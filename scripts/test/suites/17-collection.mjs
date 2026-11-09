// 3.17 Collection: the due-scope gate (staff may settle only what has arrived), the deposit-to-credit
// channel the gate points at, and the auto-debit job that settles an instalment from that credit a
// few days before it falls due.
//
// Every loan/request here is created and purged by the suite, like 06/07. The staff gate reads the real
// clock (there is deliberately no override on that path), so clock-sensitive cases are written as
// relations — "cash above maxPayable is refused", "an instalment that has not arrived cannot be paid" —
// and the loans are disbursed relative to today so the relation keeps holding on a rerun. The
// payable-now reads and the auto-debit passes take an explicit asOf and are pinned to exact dates.
import { api as http, errorMessage, login, payloadOf, pinPolicies, rows, settle, statusCheck, check, utcSql } from '../lib/harness.mjs';
import {
  addDays,
  addMonths,
  allocateComponents,
  billedInterestCents,
  buildSchedule,
  fmt,
  periodCount,
  toCents,
  toLak,
} from '../oracle.mjs';

const CAT = 'collection';
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const NIL = '00000000-7000-4000-8000-0000000000fe';

const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
/** loan.outstanding (camelCase, LAK) -> components in cents */
const outstandingOf = (loan) => ({
  PENALTY: cent(loan?.outstanding?.penalty ?? 0),
  PAST_INTEREST: cent(loan?.outstanding?.pastInterest ?? 0),
  PAST_PRINCIPAL: cent(loan?.outstanding?.pastPrincipal ?? 0),
});
const sumCents = (c) => COMPS.reduce((acc, k) => acc + (c[k] ?? 0), 0);
const asText = (c) => COMPS.map((k) => `${k}=${fmt(c[k] ?? 0)}`).join(' ');
const day = (iso) => String(iso ?? '').slice(0, 10);
const stamp = (iso) => `${day(iso)}T00:00:00.000Z`;

export default async function suite(ctx) {
  const { tokens, conn, api: adminApi } = ctx;
  // ctx.api fills in the admin token when none is given; a case that means "unauthenticated"
  // must pass token:null explicitly and bypass that default or it silently tests as admin.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));

  const products = (await api('GET', '/api/loan-products')).json.products ?? [];
  const M6 = products.find((p) => p.code === 'TST-FLAT-M6');

  // One untouched, KYC-verified customer per storyline, none of them holding seeded credit, so every
  // credit figure this suite reads back is its own doing.
  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';
  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';
  const C9 = '00000000-2000-4000-8000-000000000009';
  const custIds = [C5, C6, C7, C8, C9];

  const TODAY = day(new Date().toISOString());
  const STARTED_AT = Date.now();
  const TABLES = [
    'loans',
    'payment_requests',
    'payment_allocations',
    'financial_transactions',
    'financial_transaction_lines',
    'credit_ledger',
    'customer_credits',
    'approval_workflows',
    'approval_steps',
    'audit_logs',
    'notification_outbox',
  ];
  const baseline = {};
  for (const t of TABLES) baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  // A few of these customers hold a seeded loan of their own, so the suite counts its own leftovers by
  // id and only uses this number to prove the seeded book was not eaten.
  const baselineCustLoans = Number((await rows(conn, 'SELECT COUNT(*) n FROM loans WHERE customerId IN (?)', [custIds]))[0]?.n ?? 0);
  // The policy every case below is written against — job OFF, lead = shipped days — is installed here
  // rather than assumed, because reset-db keeps system_config and suite 13 edits this same namespace.
  // purge() puts back the policy this run found.
  const paymentPins = await pinPolicies(api, ['payment']);
  const baselinePolicy = paymentPins.found.payment;
  const shippedPolicy = paymentPins.defaults.payment;

  const created = [];
  const states = new Map();

  /**
   * Removes everything this suite wrote. The policy is PUT back first, then the rows go. The
   * action-named audit delete exists because a job run and a config change are audited without a
   * loanId, so the loan-scoped deletes cannot reach them; they are limited to this run's clock window.
   */
  const purge = async () => {
    await api('PUT', '/api/config/payment', { body: baselinePolicy });
    if (created.length) {
      const inTx = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';
      await conn.query(`DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`, [created]);
      await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [created]);
      await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [created, custIds]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [created]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [created]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [created]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [created]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [created]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [created]);
      await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [custIds]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [created]);
    }
    await conn.query("DELETE FROM audit_logs WHERE action IN ('AUTO_DEBIT_RUN', 'CONFIG_UPDATED') AND createdAt >= ?", [utcSql(STARTED_AT)]);
  };

  /** FLAT M6 loan: the whole term is billed at disbursement, so the oracle knows the debt exactly. */
  const newLoan = async ({ customerId, principal, disbursedAt, label }) => {
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: {
        customerId,
        productId: M6.id,
        principalAmount: principal,
        termValue: M6.termValue,
        termUnit: M6.termUnit,
        disbursedAt: stamp(disbursedAt),
      },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    created.push(loan.id);
    const interestCents = billedInterestCents({
      principalCents: toCents(principal),
      ratePercent: M6.interestRate,
      rateUnit: M6.interestRatePeriod,
      termValue: M6.termValue,
      termUnit: M6.termUnit,
    });
    const periods = periodCount(M6.termValue, M6.termUnit);
    states.set(loan.id, {
      customerId,
      loanNumber: loan.loanNumber,
      label,
      periods,
      disbursedAt,
      firstDue: addMonths(disbursedAt, 1),
      maturity: addMonths(disbursedAt, periods),
      // billed stays whole while payments mutate `components`, so the derived schedule can be rebuilt
      billed: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: toCents(principal) },
      components: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: toCents(principal) },
      status: 'ACTIVE',
    });
    return { id: loan.id, loanNumber: loan.loanNumber, label };
  };

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const payableNow = async (id, asOf) =>
    (await api('GET', `/api/loans/${id}/payable-now${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`)).json?.data ?? null;
  const createReq = (body, token = tokens.op1) => api('POST', '/api/payment-requests', { token, body });
  const approveReq = (id, body = {}, token = tokens.checker1) => api('POST', `/api/payment-requests/${id}/approve`, { token, body });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });
  const creditRow = (customerId) =>
    rows(conn, 'SELECT CAST(balance AS CHAR) b FROM customer_credits WHERE customerId = ?', [customerId]).then((r) => r[0] ?? null);
  const creditLedger = (customerId) =>
    rows(conn, 'SELECT type, CAST(amount AS CHAR) amount, CAST(balanceAfter AS CHAR) balanceAfter FROM credit_ledger WHERE customerId = ? ORDER BY createdAt', [customerId]);
  const runAutoDebit = (body, token = tokens.admin) => api('POST', '/api/config/payment/auto-debit/run', { token, body });
  const paymentRows = (loanId) =>
    rows(
      conn,
      "SELECT id, status, CAST(amount AS CHAR) amount, periodIndex, createdBy FROM financial_transactions WHERE loanId = ? AND transactionType = 'PAYMENT' ORDER BY createdAt",
      [loanId],
    );
  const lineRows = (txId) =>
    rows(conn, 'SELECT component, CAST(amount AS CHAR) amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [txId]);
  const countRows = (sql, params = []) => rows(conn, sql, params).then((r) => Number(r[0]?.n ?? 0));
  const machineCount = () => countRows("SELECT COUNT(*) n FROM users WHERE username = 'system.auto-debit'");
  const debitRunAudit = () => countRows("SELECT COUNT(*) n FROM audit_logs WHERE action = 'AUTO_DEBIT_RUN'");

  // Mail that a money event queued in its own transaction (transactional outbox); transport=log means
  // nothing leaves the machine, so the outbox table is the delivery evidence.
  const approverEmails = (
    await rows(
      conn,
      "SELECT email FROM users WHERE role IN ('CHECKER','HEAD_APPROVER','ADMIN') AND isActive = 1 AND email IS NOT NULL AND email <> '' ORDER BY email",
      [],
    )
  ).map((r) => r.email);
  const borrowerEmail = async (loanId) =>
    (await rows(conn, 'SELECT c.email FROM customers c JOIN loans l ON l.customerId = c.id WHERE l.id = ?', [loanId]))[0]?.email ?? null;
  /** maker ผู้สร้างคำขอได้สำเนาเฉพาะเมลแจ้งผลตัดสิน (APPROVED/REJECTED) ไม่ใช่เมลแจ้งยื่น */
  const makerEmail = async (username) => (await rows(conn, 'SELECT email FROM users WHERE username = ?', [username]))[0]?.email ?? null;
  /** formatAmount() ให้ค่าแบบ "150,000 LAK" จึงเทียบเป็นตัวเลขล้วน */
  const moneyOf = (value) => String(value ?? '').replace(/[^\d.]/g, '');
  const reaches = (mail, audience) =>
    audience.every((email) => mail.some((r) => String(r.recipientEmail).toLowerCase() === String(email).toLowerCase()));
  // payload is sealed for every event type, so the fields open in JS — JSON_EXTRACT on that text is
  // not valid JSON and answers NULL, which would compare nulls instead of the announced amounts.
  const mailFor = (loanId, type, amount = null) =>
    rows(
      conn,
      'SELECT recipientEmail, status, payload FROM notification_outbox WHERE loanId = ? AND type = ? ORDER BY createdAt',
      [loanId, type],
    )
      .then((rs) =>
        rs.map((row) => {
          const payload = payloadOf(row);
          return {
            ...row,
            requestNo: payload.requestNo ?? null,
            amount: payload.amount ?? null,
            purposeLabel: payload.purposeLabel ?? null,
            instalment: payload.instalment ?? null,
            allocation: payload.allocation ?? null,
            remaining: payload.remaining ?? null,
            creditBalance: payload.creditBalance ?? null,
          };
        }),
      )
      .then((rs) => (amount === null ? rs : rs.filter((r) => moneyOf(r.amount) === moneyOf(amount))));
  const findStep = async (txId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=200', { token });
    return (pending.json.data ?? []).find((i) => i.subjectId === txId) ?? null;
  };

  /** maker -> checker -> post for either purpose; throws with the API message if any step fails. */
  const postThrough = async (loan, body, label) => {
    const made = await createReq({ loanId: loan.id, ...body });
    if (made.status !== 201) throw new Error(`${label}: create failed ${made.status} ${errorMessage(made)}`);
    const request = made.json.data.request;
    const approved = await approveReq(request.id, {}, tokens.checker1);
    if (approved.status !== 200) throw new Error(`${label}: approve failed ${approved.status} ${errorMessage(approved)}`);
    const tx = approved.json.data.transaction;
    const posted = await postTx(tx.id);
    if (posted.status !== 200) throw new Error(`${label}: post failed ${posted.status} ${errorMessage(posted)}`);
    return { made, approved, posted, request, tx };
  };

  /**
   * Settles `amountCents` against the oracle state and compares the loan, the allocation order and the
   * ledger lines. The post response is checked when the caller has one; a machine settlement has none,
   * so the lines are always read from the table the posting engine wrote.
   */
  const verifySettled = async (loan, { tx, posted }, amountCents, label) => {
    const state = states.get(loan.id);
    const exp = allocateComponents(amountCents, state.components);
    COMPS.forEach((c) => {
      state.components[c] -= exp.allocation[c];
    });
    const excess = amountCents - sumCents(exp.allocation);
    const lines = (await lineRows(tx.id)).filter((r) => COMPS.includes(r.component));
    const allocated = Object.fromEntries(COMPS.map((c) => [c, -cent(lines.find((r) => r.component === c)?.amount ?? 0)]));
    const after = await loanView(loan.id);
    const got = outstandingOf(after);
    check(CAT, `${label}: ยอดที่ตัดเรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL และ ledger line ปิดยอด`, {
      input: `POST /api/transactions/${tx.id}/post (${fmt(amountCents)})`,
      expected: `${COMPS.map((c) => `${c}=${fmt(exp.allocation[c])}`).join(' ')} เหลือ ${asText(state.components)}`,
      actual: `${COMPS.map((c) => `${c}=${fmt(allocated[c])}`).join(' ')} เหลือ ${asText(got)}`,
      pass:
        COMPS.every((c) => allocated[c] === exp.allocation[c] && got[c] === state.components[c]) &&
        lines.length === COMPS.filter((c) => exp.allocation[c] !== 0).length &&
        (!posted ||
          (cent(posted.json?.data?.excess ?? -1) === excess &&
            COMPS.every((c) => cent(posted.json?.data?.allocation?.[c] ?? 0) === exp.allocation[c]))),
    });
    return { exp, excess, after, got, allocated };
  };

  try {
    await purge();
    await purge();
    // purge() PUTs back the policy it found, which may be drifted; the cases below count against the
    // shipped values pinPolicies() installed, so those go back on after the opening purges.
    await api('PUT', '/api/config/payment', { body: shippedPolicy });

    const leftoverCredit = await rows(conn, 'SELECT customerId, CAST(balance AS CHAR) b FROM customer_credits WHERE customerId IN (?)', [custIds]);
    check(CAT, 'ก่อนเริ่ม suite: ลูกค้าทดสอบทั้งห้าคนต้องไม่มี credit ค้าง (suite ก่อนหน้าล้างครบจริง)', {
      input: 'customer_credits ของ C5-C9',
      expected: '0 แถว หรือทุกแถว balance 0.00',
      actual: JSON.stringify(leftoverCredit.map((r) => [r.customerId.slice(-2), r.b])),
      pass: leftoverCredit.every((r) => cent(r.b) === 0),
    });

    // ================================================ A. GET /loans/:id/payable-now (asOf pinned)
    statusCheck(CAT, 'payable-now anonymous: 401', await api('GET', `/api/loans/${NIL}/payable-now`, { token: null }), 401);
    const full = await newLoan({ customerId: C5, principal: 600000, disbursedAt: '2025-01-05', label: 'FULL' });
    const mid = await newLoan({ customerId: C6, principal: 600000, disbursedAt: '2026-09-05', label: 'MID' });
    const ad = await newLoan({ customerId: C7, principal: 600000, disbursedAt: '2026-09-05', label: 'AD' });
    const adSmall = await newLoan({ customerId: C8, principal: 300000, disbursedAt: '2026-09-05', label: 'AD-SMALL' });
    const fresh = await newLoan({ customerId: C9, principal: 200000, disbursedAt: addDays(TODAY, -5), label: 'FRESH' });

    statusCheck(CAT, 'payable-now ของ loan ที่ไม่มีอยู่: 404', await api('GET', `/api/loans/${NIL}/payable-now`), 404, { input: NIL });
    statusCheck(CAT, 'payable-now asOf ไม่ถูกรูปแบบ: 400', await api('GET', `/api/loans/${full.id}/payable-now?asOf=not-a-date`), 400, {
      input: 'asOf=not-a-date',
      messageIncludes: 'asOf must be a valid date',
    });

    const viewerRead = await api('GET', `/api/loans/${full.id}/payable-now`, { token: tokens.viewer });
    statusCheck(CAT, 'payable-now ด้วย token VIEWER: 200 (ทุก role ต้องเห็นเพดานก่อนตอบลูกค้า)', viewerRead, 200);
    const VIEW_KEYS = ['loanId', 'loanNumber', 'asOf', 'maxPayable', 'dueToPay', 'ledgerOutstanding', 'duePeriods', 'nextPendingPeriod', 'creditBalance'];
    check(CAT, 'payload ของ payable-now มีครบทุก field ที่ UI ต้องใช้', {
      input: 'Object.keys(data)',
      expected: VIEW_KEYS.slice().sort().join(', '),
      actual: Object.keys(viewerRead.json?.data ?? {}).sort().join(', '),
      pass: VIEW_KEYS.every((k) => k in (viewerRead.json?.data ?? {})),
    });

    const freshState = states.get(fresh.id);
    const noPeriodYet = await payableNow(fresh.id);
    check(CAT, 'กู้ที่ปล่อยเมื่อ 5 วันก่อน: ยังไม่มีงวดใดถึงกำหนด maxPayable 0 แต่หนี้ทั้งก้อนอยู่ใน ledger แล้ว', {
      input: `GET /payable-now (นาฬิกาจริง, ปล่อยกู้ ${addDays(TODAY, -5)})`,
      expected: `maxPayable 0.00, dueToPay 0.00, duePeriods 0, ledgerOutstanding ${fmt(sumCents(freshState.components))}, next period 1 due ${freshState.firstDue}, creditBalance 0.00`,
      actual: `maxPayable ${fmt(cent(noPeriodYet.maxPayable))}, dueToPay ${fmt(cent(noPeriodYet.dueToPay))}, duePeriods ${
        noPeriodYet.duePeriods.length
      }, ledger ${fmt(cent(noPeriodYet.ledgerOutstanding))}, next ${noPeriodYet.nextPendingPeriod?.index}@${day(
        noPeriodYet.nextPendingPeriod?.dueDate,
      )}, credit ${fmt(cent(noPeriodYet.creditBalance))}`,
      pass:
        cent(noPeriodYet.maxPayable) === 0 &&
        cent(noPeriodYet.dueToPay) === 0 &&
        noPeriodYet.duePeriods.length === 0 &&
        cent(noPeriodYet.ledgerOutstanding) === sumCents(freshState.components) &&
        noPeriodYet.nextPendingPeriod?.index === 1 &&
        day(noPeriodYet.nextPendingPeriod?.dueDate) === freshState.firstDue &&
        cent(noPeriodYet.creditBalance) === 0,
    });

    const adState = states.get(ad.id);
    const adDebt = sumCents(adState.components);
    const oneDayEarly = await payableNow(ad.id, stamp(addDays(adState.firstDue, -1)));
    check(CAT, 'ก่อนงวดแรก 1 วัน (grace 0): เก็บอะไรไม่ได้เลย — เพดาน 0, duePeriods ว่าง, งวดยัง pending', {
      input: `GET /payable-now asOf=${addDays(adState.firstDue, -1)} (งวด 1 ครกำหนด ${adState.firstDue})`,
      expected: `maxPayable 0.00, duePeriods 0, ledgerOutstanding ${fmt(adDebt)}, next 1 @ ${adState.firstDue}`,
      actual: `maxPayable ${fmt(cent(oneDayEarly.maxPayable))}, duePeriods ${oneDayEarly.duePeriods.length}, ledger ${fmt(
        cent(oneDayEarly.ledgerOutstanding),
      )}, next ${oneDayEarly.nextPendingPeriod?.index}@${day(oneDayEarly.nextPendingPeriod?.dueDate)}`,
      pass:
        cent(oneDayEarly.maxPayable) === 0 &&
        oneDayEarly.duePeriods.length === 0 &&
        cent(oneDayEarly.ledgerOutstanding) === adDebt &&
        oneDayEarly.nextPendingPeriod?.index === 1 &&
        day(oneDayEarly.nextPendingPeriod?.dueDate) === adState.firstDue,
    });

    const onDue = await payableNow(ad.id, stamp(adState.firstDue));
    check(CAT, 'ในวันครบกำหนดงวด 1: duePeriods มีงวดเดียว, เพดาน = ยอดงวดนั้น (ยังไม่ครึ่งหนี้ทั้งก้อน)', {
      input: `GET /payable-now asOf=${adState.firstDue}`,
      expected: 'duePeriods 1 (index 1), maxPayable = duePeriods[0].collectable, 0 < maxPayable < ledgerOutstanding, next 2',
      actual: `duePeriods ${onDue.duePeriods.length}@${onDue.duePeriods[0]?.index}, maxPayable ${fmt(cent(onDue.maxPayable))} vs collectable ${fmt(
        cent(onDue.duePeriods[0]?.collectable ?? -1),
      )}, ledger ${fmt(cent(onDue.ledgerOutstanding))}, next ${onDue.nextPendingPeriod?.index}`,
      pass:
        onDue.duePeriods.length === 1 &&
        onDue.duePeriods[0].index === 1 &&
        cent(onDue.maxPayable) === cent(onDue.duePeriods[0].collectable) &&
        cent(onDue.maxPayable) > 0 &&
        cent(onDue.maxPayable) < cent(onDue.ledgerOutstanding) &&
        onDue.nextPendingPeriod?.index === 2,
    });

    const threeIn = await payableNow(ad.id, stamp(addMonths(adState.firstDue, 2)));
    check(CAT, 'ผ่านไป 2 เดือน: เก็บได้แล้ว 3 งวด, dueToPay เป็นผลรวม collectable และ maxPayable = min(dueToPay, หนี้ใน ledger)', {
      input: `GET /payable-now asOf=${addMonths(adState.firstDue, 2)}`,
      expected: 'duePeriods 1,2,3 · dueToPay = sum(collectable) · maxPayable = dueToPay < ledgerOutstanding',
      actual: `duePeriods ${threeIn.duePeriods.map((p) => p.index).join(',')} · dueToPay ${fmt(cent(threeIn.dueToPay))} vs sum ${fmt(
        threeIn.duePeriods.reduce((acc, p) => acc + cent(p.collectable), 0),
      )} · maxPayable ${fmt(cent(threeIn.maxPayable))} of ${fmt(cent(threeIn.ledgerOutstanding))}`,
      pass:
        threeIn.duePeriods.map((p) => p.index).join(',') === '1,2,3' &&
        cent(threeIn.dueToPay) === threeIn.duePeriods.reduce((acc, p) => acc + cent(p.collectable), 0) &&
        cent(threeIn.maxPayable) === Math.min(cent(threeIn.dueToPay), cent(threeIn.ledgerOutstanding)) &&
        cent(threeIn.maxPayable) < adDebt,
    });

    const atMaturity = await payableNow(ad.id, stamp(adState.maturity));
    check(CAT, 'ถึงวันครบสัญญา: ทุกงวดถึงกำหนดแล้ว maxPayable = หนี้ทั้งก้อนใน ledger และไม่มีงวดรอตัด', {
      input: `GET /payable-now asOf=${adState.maturity}`,
      expected: `duePeriods ${adState.periods}, maxPayable = ledgerOutstanding = ${fmt(adDebt)}, nextPendingPeriod null`,
      actual: `duePeriods ${atMaturity.duePeriods.length}, maxPayable ${fmt(cent(atMaturity.maxPayable))}, ledger ${fmt(
        cent(atMaturity.ledgerOutstanding),
      )}, next ${JSON.stringify(atMaturity.nextPendingPeriod)}`,
      pass:
        atMaturity.duePeriods.length === adState.periods &&
        cent(atMaturity.maxPayable) === cent(atMaturity.ledgerOutstanding) &&
        cent(atMaturity.ledgerOutstanding) === adDebt &&
        atMaturity.nextPendingPeriod === null,
    });

    const expectedDates = Array.from({ length: adState.periods }, (_, i) => addMonths('2026-09-05', i + 1)).join(',');
    check(CAT, 'วันครบกำหนดรายงวดเพิ่มเดือนละเดือนจากวันปล่อยกู้ (ปฏิทินจริง ไม่ใช่ 30 วัน x งวด)', {
      input: `duePeriods[].dueDate ที่ asOf=${adState.maturity} (ปล่อยกู้ 2026-09-05)`,
      expected: expectedDates,
      actual: atMaturity.duePeriods.map((p) => day(p.dueDate)).join(','),
      pass: atMaturity.duePeriods.map((p) => day(p.dueDate)).join(',') === expectedDates,
    });

    // ================================================ B. the gate on the staff path (real clock)
    const fullOwed = sumCents(states.get(full.id).components);
    const refusedTiny = await createReq({ loanId: full.id, cashAmount: toLak(fullOwed + 1) });
    statusCheck(CAT, 'ปิดหนี้เกิน 1 สตางค์: 422 (เพดานคือยอดที่ถึงกำหนด ไม่ใช่ยอดหนี้)', refusedTiny, 422, {
      input: `cashAmount ${fmt(fullOwed + 1)} บน ${full.loanNumber} ที่เก็บได้ทั้ง ${fmt(fullOwed)}`,
      messageIncludes: 'is due on loan',
    });
    const tinyDetails = refusedTiny.json?.error?.details ?? {};
    check(CAT, '422 ตอบ details ให้ UI ยืนยันตัวเลข (maxPayable, requested, duePeriods, nextPendingPeriod)', {
      input: 'POST /api/payment-requests เกินเพดาน',
      expected: `maxPayable ${fmt(fullOwed)}, requested ${fmt(fullOwed + 1)}, duePeriods ${states.get(full.id).periods}, nextPendingPeriod null`,
      actual: `maxPayable ${fmt(cent(tinyDetails.maxPayable ?? -1))}, requested ${fmt(cent(tinyDetails.requested ?? -1))}, duePeriods ${
        tinyDetails.duePeriods?.length
      }, next ${JSON.stringify(tinyDetails.nextPendingPeriod)}`,
      pass:
        cent(tinyDetails.maxPayable ?? -1) === fullOwed &&
        cent(tinyDetails.requested ?? -1) === fullOwed + 1 &&
        tinyDetails.duePeriods?.length === states.get(full.id).periods &&
        tinyDetails.nextPendingPeriod === null,
    });
    check(CAT, 'คำขอที่ถูก gate ปฏิเสธไม่ทิ้งแถวไว้ใน DB (transaction rollback ทั้งก้อน)', {
      input: 'payment_requests + payment_allocations ของ FULL หลัง 422',
      expected: '0 แถวทั้งสองตาราง',
      actual: `${await countRows('SELECT COUNT(*) n FROM payment_requests WHERE loanId = ?', [full.id])} request, ${await countRows(
        'SELECT COUNT(*) n FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId = ?)',
        [full.id],
      )} allocation`,
      pass:
        (await countRows('SELECT COUNT(*) n FROM payment_requests WHERE loanId = ?', [full.id])) === 0 &&
        (await countRows('SELECT COUNT(*) n FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId = ?)', [full.id])) === 0,
    });

    const closedPay = await postThrough(full, { cashAmount: toLak(fullOwed) }, 'payoff พอดี');
    const closedVerify = await verifySettled(full, closedPay, fullOwed, `ปิดหนี้ ${full.loanNumber} ด้วยยอดพอดี`);
    check(CAT, 'จ่ายพอดีทุกส่วนผ่าน gate ได้: loan เปลี่ยนเป็น CLOSED ยอดคงเหลือและส่วนเกินเป็น 0', {
      input: `cash ${fmt(fullOwed)} (ทั้งสัญญาถึงกำหนดแล้ว)`,
      expected: 'status CLOSED, outstanding 0.00, excess 0.00, ไม่มี credit ของ C5',
      actual: `${closedVerify.after.status}, outstanding ${closedVerify.after.outstanding.total}, excess ${fmt(closedVerify.excess)}, credit ${String(
        (await creditRow(C5))?.b ?? 'no row',
      )}`,
      pass:
        closedVerify.after.status === 'CLOSED' &&
        sameMoney(closedVerify.after.outstanding.total, 0) &&
        closedVerify.excess === 0 &&
        cent((await creditRow(C5))?.b ?? 0) === 0,
    });
    states.get(full.id).status = 'CLOSED';

    // A loan a couple of months into its term: the gate holds for the whole of it, not once.
    const midPayable = await payableNow(mid.id);
    check(CAT, 'กู้กลางสัญญา: เพดานวันนี้ต่ำกว่าหนี้ทั้งก้อน (งวดในอนาคตยังเรียกเก็บไม่ได้)', {
      input: `GET /payable-now ${mid.loanNumber} (today ${TODAY})`,
      expected: `0 < maxPayable < ledgerOutstanding ${fmt(sumCents(states.get(mid.id).components))}`,
      actual: `maxPayable ${fmt(cent(midPayable.maxPayable))}, ledger ${fmt(cent(midPayable.ledgerOutstanding))}, duePeriods ${
        midPayable.duePeriods.length
      }`,
      pass:
        cent(midPayable.maxPayable) > 0 &&
        cent(midPayable.maxPayable) < cent(midPayable.ledgerOutstanding) &&
        cent(midPayable.ledgerOutstanding) === sumCents(states.get(mid.id).components),
    });
    const refusedFull = await createReq({ loanId: mid.id, cashAmount: toLak(cent(midPayable.ledgerOutstanding)) });
    statusCheck(CAT, 'ขอก้อนเต็มของกู้กลางสัญญา: 422 และข้อความชี้ช่อง deposit + auto-debit', refusedFull, 422, {
      input: `cashAmount ${fmt(cent(midPayable.ledgerOutstanding))} เพดาน ${fmt(cent(midPayable.maxPayable))}`,
      messageIncludes: 'Bring the rest as a deposit to credit',
    });
    const refuseMsg = errorMessage(refusedFull);
    check(CAT, 'ข้อความ 422 ระบุยอดที่เก็บได้จริง ชื่อ loan และงวดถัดที่กำลังจะถึงกำหนด', {
      input: 'body.error.message',
      expected: `Only ${fmt(cent(midPayable.maxPayable))} LAK is due on loan ${mid.loanNumber} today ... the system auto-debits it when the instalment falls due ... Next instalment ${
        midPayable.nextPendingPeriod?.index
      } falls due on ${day(midPayable.nextPendingPeriod?.dueDate)}`,
      actual: refuseMsg.slice(0, 240),
      pass:
        refuseMsg.startsWith(`Only ${fmt(cent(midPayable.maxPayable))} LAK is due on loan ${mid.loanNumber} today`) &&
        /auto-debits it when the instalment falls due/.test(refuseMsg) &&
        refuseMsg.includes(`Next instalment ${midPayable.nextPendingPeriod?.index} falls due on ${day(midPayable.nextPendingPeriod?.dueDate)}`),
    });
    const exactDue = await postThrough(mid, { cashAmount: toLak(cent(midPayable.maxPayable)) }, 'จ่ายเท่าเพดาน');
    const exactVerify = await verifySettled(mid, exactDue, cent(midPayable.maxPayable), `จ่ายเท่า maxPayable ของ ${mid.loanNumber}`);
    const midAfter = await loanView(mid.id);
    check(CAT, 'จ่ายเท่าเพดาน: loan ยัง ACTIVE, หนี้งวดอนาคตเหลืออยู่ และไม่มีส่วนเกินกลายเป็น credit', {
      input: `GET /api/loans/${mid.loanNumber} + customer_credits ของ C6`,
      expected: 'ACTIVE, outstanding > 0, excess 0.00, ยังไม่มีแถว credit',
      actual: `${midAfter.status}, outstanding ${midAfter.outstanding.total}, excess ${fmt(cent(exactDue.posted.json?.data?.excess ?? -1))}, credit ${String(
        (await creditRow(C6))?.b ?? 'no row',
      )}`,
      pass:
        midAfter.status === 'ACTIVE' &&
        cent(midAfter.outstanding.total) > 0 &&
        cent(exactDue.posted.json?.data?.excess ?? -1) === 0 &&
        (await creditRow(C6)) === null,
    });

    // The gate re-measures the schedule on every request, and a FLAT loan bills its whole-term interest
    // as one booking, so the first payment drains PAST_INTEREST before touching much of period 1's
    // principal. Period 1 therefore stays open with a principal residual that is still arrived money:
    // the ceiling after one payment is that residual, not 0 and not the previous amount.
    const midState = states.get(mid.id);
    const firstPeriod = buildSchedule({
      startIso: midState.disbursedAt,
      principalCents: midState.billed.PAST_PRINCIPAL,
      interestCents: midState.billed.PAST_INTEREST,
      termValue: M6.termValue,
      termUnit: M6.termUnit,
    })[0];
    const creditedOnFirst =
      Math.min(exactVerify.exp.allocation.PAST_PRINCIPAL, firstPeriod.principalCents) +
      Math.min(exactVerify.exp.allocation.PAST_INTEREST, firstPeriod.interestCents);
    const residualOfFirst = firstPeriod.principalCents + firstPeriod.interestCents - creditedOnFirst;
    const stillOwedAfterFirst = cent(midPayable.ledgerOutstanding) - cent(midPayable.maxPayable);

    const afterFirst = await payableNow(mid.id);
    const refusedNext = await createReq({ loanId: mid.id, cashAmount: toLak(stillOwedAfterFirst) });
    statusCheck(CAT, 'จ่ายงวดแรกแล้วขอก้อนที่เหลือทันที: 422 อีกครั้ง (gate วัดใหม่ทุกครั้ง ไม่ใช่โควตาครั้งเดียว)', refusedNext, 422, {
      input: `cashAmount ${fmt(stillOwedAfterFirst)} หลังจ่าย ${fmt(cent(midPayable.maxPayable))}`,
      messageIncludes: `Only ${fmt(residualOfFirst)} LAK is due`,
    });
    const nextMsg = errorMessage(refusedNext);
    const nextDetails = refusedNext.json?.error?.details ?? {};
    check(CAT, 'เพดานรอบสอง = เงินต้นของงวด 1 ที่ยังไม่ถูกตัด (ดอกเบี้ยทั้งก้อนถูกตัดก่อน) ไม่ใช่ 0 และไม่ใช่ยอดเดิม', {
      input: `GET /payable-now + 422 details หลังจ่าย ${fmt(cent(midPayable.maxPayable))}`,
      expected: `maxPayable ${fmt(residualOfFirst)} (งวด 1 จ่ายแล้ว ${fmt(creditedOnFirst)} จาก ${fmt(
        firstPeriod.principalCents + firstPeriod.interestCents,
      )}), duePeriods [1], ledgerOutstanding ${fmt(sumCents(midState.components))}, requested ${fmt(stillOwedAfterFirst)}`,
      actual: `maxPayable ${fmt(cent(afterFirst.maxPayable))} (dueToPay ${fmt(cent(afterFirst.dueToPay))}, duePeriods ${JSON.stringify(
        afterFirst.duePeriods.map((p) => [p.index, cent(p.collectable)]),
      )}}, ledger ${fmt(cent(afterFirst.ledgerOutstanding))}, details ${JSON.stringify([
        cent(nextDetails.maxPayable ?? -1),
        cent(nextDetails.requested ?? -1),
        nextDetails.duePeriods?.length,
      ])})`,
      pass:
        residualOfFirst > 0 &&
        residualOfFirst < cent(midPayable.maxPayable) &&
        cent(afterFirst.maxPayable) === residualOfFirst &&
        cent(afterFirst.dueToPay) === residualOfFirst &&
        afterFirst.duePeriods.length === 1 &&
        afterFirst.duePeriods[0].index === 1 &&
        cent(afterFirst.duePeriods[0].collectable) === residualOfFirst &&
        cent(afterFirst.ledgerOutstanding) === sumCents(midState.components) &&
        cent(nextDetails.maxPayable ?? -1) === residualOfFirst &&
        cent(nextDetails.requested ?? -1) === stillOwedAfterFirst &&
        nextDetails.duePeriods?.length === 1 &&
        nextMsg.startsWith(`Only ${fmt(residualOfFirst)} LAK is due on loan ${mid.loanNumber} today (period 1)`) &&
        nextMsg.includes(`but ${fmt(stillOwedAfterFirst)} was requested`) &&
        nextMsg.includes(`Next instalment ${afterFirst.nextPendingPeriod?.index} falls due on ${day(afterFirst.nextPendingPeriod?.dueDate)}`),
    });

    // Over-collection is the risk this gate exists to prevent, so the derived schedule is checked end
    // to end: every instalment keeps its own share, nothing is credited past its due amount, and the
    // period sums land exactly on the ledger the postings wrote.
    const scheduleAfterFirst = (await api('GET', `/api/loans/${mid.id}/schedule`)).json?.data ?? null;
    const viewedPeriods = scheduleAfterFirst?.periods ?? [];
    const summedOutstanding = viewedPeriods.reduce((acc, p) => acc + cent(p.outstanding), 0);
    const summedDue = viewedPeriods.reduce((acc, p) => acc + cent(p.principalDue) + cent(p.interestDue), 0);
    check(CAT, 'เงินไม่รั่วและไม่มีงวดใดถูกตัดเกิน: รวมตารางรายงวด = ledger = oracle', {
      input: `GET /api/loans/${mid.loanNumber}/schedule (today ${TODAY})`,
      expected: `${midState.periods} งวด · sum(outstanding) ${fmt(sumCents(midState.components))} · sum(due) ${fmt(
        midState.billed.PAST_PRINCIPAL + midState.billed.PAST_INTEREST,
      )} · paid <= due ทุกงวด`,
      actual: `${viewedPeriods.length} งวด · sum(outstanding) ${fmt(summedOutstanding)} (ledger API ${fmt(
        cent(afterFirst.ledgerOutstanding),
      )}) · sum(due) ${fmt(summedDue)} ·งวดที่จ่ายเกิน ${viewedPeriods.filter((p) => cent(p.paid) > cent(p.due)).length}`,
      pass:
        viewedPeriods.length === midState.periods &&
        summedOutstanding === sumCents(midState.components) &&
        summedOutstanding === cent(afterFirst.ledgerOutstanding) &&
        summedDue === midState.billed.PAST_PRINCIPAL + midState.billed.PAST_INTEREST &&
        viewedPeriods.every(
          (p) =>
            cent(p.paid) <= cent(p.due) &&
            cent(p.outstanding) >= 0 &&
            cent(p.due) === cent(p.principalDue) + cent(p.interestDue) &&
            cent(p.paid) === cent(p.principalPaid) + cent(p.interestPaid),
        ),
    });

    // Settling that residual is what makes the ceiling legitimately 0: once every arrived instalment is
    // closed, the next request hits the "no instalment has arrived yet" branch instead of a number.
    const residualPay = await postThrough(mid, { cashAmount: toLak(residualOfFirst) }, 'จ่ายส่วนค้างของงวด 1');
    const residualVerify = await verifySettled(mid, residualPay, residualOfFirst, `ปิดงวด 1 ของ ${mid.loanNumber} ด้วยส่วนค้าง ${fmt(residualOfFirst)}`);
    const interestClearedEntirely =
      exactVerify.exp.allocation.PAST_INTEREST + residualVerify.exp.allocation.PAST_INTEREST === midState.billed.PAST_INTEREST;
    const afterSecond = await payableNow(mid.id);
    check(CAT, 'จ่ายครบงวด 1 แล้ว: ไม่มีงวดถึงกำหนดเหลือ, เพดาน 0, ยอดคงค้างคือเงินต้นงวด 2-6 ที่ยังไม่ถึงกำหนด', {
      input: `GET /payable-now หลังจ่ายส่วนค้าง ${fmt(residualOfFirst)} (รวมที่จ่าย ${fmt(cent(midPayable.maxPayable) + residualOfFirst)})`,
      expected: `maxPayable 0.00, dueToPay 0.00, duePeriods 0, ledgerOutstanding ${fmt(sumCents(midState.components))} = เงินต้น ${fmt(
        midState.billed.PAST_PRINCIPAL - firstPeriod.principalCents,
      )} + ดอกเบี้ย 0.00, next 2 @ ${addMonths(midState.disbursedAt, 2)}, credit 0.00`,
      actual: `maxPayable ${fmt(cent(afterSecond.maxPayable))}, dueToPay ${fmt(cent(afterSecond.dueToPay))}, duePeriods ${
        afterSecond.duePeriods.length
      }, ledger ${fmt(cent(afterSecond.ledgerOutstanding))}, oracle ${asText(midState.components)}, next ${
        afterSecond.nextPendingPeriod?.index
      }@${day(afterSecond.nextPendingPeriod?.dueDate)} ${fmt(cent(afterSecond.nextPendingPeriod?.amount ?? -1))}, credit ${fmt(
        cent(afterSecond.creditBalance),
      )} excess ${fmt(residualVerify.excess)}`,
      pass:
        residualVerify.excess === 0 &&
        cent(afterSecond.maxPayable) === 0 &&
        cent(afterSecond.dueToPay) === 0 &&
        afterSecond.duePeriods.length === 0 &&
        midState.components.PAST_INTEREST === 0 &&
        midState.components.PAST_PRINCIPAL === midState.billed.PAST_PRINCIPAL - firstPeriod.principalCents &&
        cent(afterSecond.ledgerOutstanding) === sumCents(midState.components) &&
        afterSecond.nextPendingPeriod?.index === 2 &&
        day(afterSecond.nextPendingPeriod?.dueDate) === addMonths(midState.disbursedAt, 2) &&
        // every instalment's interest is already booked (the whole term was billed once), so the only
        // debt left on a future period is its principal share
        interestClearedEntirely &&
        cent(afterSecond.nextPendingPeriod?.amount) === firstPeriod.principalCents &&
        cent(afterSecond.creditBalance) === 0,
    });

    const refusedLater = await createReq({ loanId: mid.id, cashAmount: toLak(cent(afterSecond.ledgerOutstanding)) });
    statusCheck(
      CAT,
      'งวดถัดไปยังไม่ถึงกำหนด: ขอก้อนที่เหลือทั้งก้อนได้ 422 branch "ยังไม่มีงวดถึงกำหนด" ไม่ใช่โควตาที่เหลือ',
      refusedLater,
      422,
      {
        input: `cashAmount ${fmt(cent(afterSecond.ledgerOutstanding))} บนเพดาน 0.00 (งวด 2 ถึงกำหนด ${day(
          afterSecond.nextPendingPeriod?.dueDate,
        )})`,
        messageIncludes: 'no instalment has arrived yet',
      },
    );
    const laterMsg = errorMessage(refusedLater);
    const laterDetails = refusedLater.json?.error?.details ?? {};
    check(CAT, 'ข้อความ 422 ตอนเพดาน 0: บอกว่างวดไหนวันใดพร้อมเก็บ และเชิญให้ฝากเข้า credit แทน', {
      input: 'body.error.message + details',
      expected: `Only 0.00 LAK is due on loan ${mid.loanNumber} today (no instalment has arrived yet), but ${fmt(
        cent(afterSecond.ledgerOutstanding),
      )} was requested ... Bring the rest as a deposit to credit ... Next instalment ${
        afterSecond.nextPendingPeriod?.index
      } falls due on ${day(afterSecond.nextPendingPeriod?.dueDate)} · details.maxPayable 0.00, duePeriods 0`,
      actual: `${laterMsg.slice(0, 200)} | ${JSON.stringify([
        cent(laterDetails.maxPayable ?? -1),
        cent(laterDetails.requested ?? -1),
        laterDetails.duePeriods?.length,
        laterDetails.nextPendingPeriod?.index,
      ])}`,
      pass:
        laterMsg.startsWith(`Only 0.00 LAK is due on loan ${mid.loanNumber} today (no instalment has arrived yet)`) &&
        laterMsg.includes(`but ${fmt(cent(afterSecond.ledgerOutstanding))} was requested`) &&
        laterMsg.includes('Bring the rest as a deposit to credit') &&
        laterMsg.includes(
          `Next instalment ${afterSecond.nextPendingPeriod?.index} falls due on ${day(afterSecond.nextPendingPeriod?.dueDate)}`,
        ) &&
        cent(laterDetails.maxPayable ?? -1) === 0 &&
        cent(laterDetails.requested ?? -1) === cent(afterSecond.ledgerOutstanding) &&
        laterDetails.duePeriods?.length === 0 &&
        laterDetails.nextPendingPeriod?.index === afterSecond.nextPendingPeriod?.index &&
        (await creditRow(C6)) === null,
    });

    // ================================================ C. the deposit channel the gate points at
    statusCheck(
      CAT,
      'deposit พร้อม settlementAgreementId: 422 (เงินฝากเข้า credit ห้ามผูกข้อตกลง)',
      await createReq({ loanId: fresh.id, cashAmount: 1000, purpose: 'DEPOSIT_TO_CREDIT', settlementAgreementId: NIL }),
      422,
      {
        input: 'purpose DEPOSIT_TO_CREDIT + settlementAgreementId (UUID ปลอม)',
        messageIncludes: 'cannot be tied to a settlement agreement',
        note: 'guard นี้ทำงานก่อนการค้นข้อตกลงจริง จึงยืนยันด้วย id ปลอมได้ และไม่ทิ้งแถว settlement ไว้ใน DB',
      },
    );
    statusCheck(
      CAT,
      'deposit ที่ขอใช้ credit ไปด้วย: 422 (เป็นเงินรับเข้าฝ่ายเดียว)',
      await createReq({ loanId: fresh.id, cashAmount: 1000, creditToApply: 500, purpose: 'DEPOSIT_TO_CREDIT' }),
      422,
      { input: 'cash 1000 + creditToApply 500', messageIncludes: 'cannot also spend customer credit' },
    );
    statusCheck(CAT, 'deposit เงินสด 0: 400 ยอดต้องมากกว่า 0', await createReq({ loanId: fresh.id, cashAmount: 0, purpose: 'DEPOSIT_TO_CREDIT' }), 400, {
      input: 'cashAmount 0 purpose DEPOSIT_TO_CREDIT',
      messageIncludes: 'Payment amount must be greater than zero',
    });

    const depMade = await createReq({ loanId: fresh.id, cashAmount: 50000, purpose: 'DEPOSIT_TO_CREDIT', note: 'ฝากล่วงหน้าก่อนถึงงวด' });
    statusCheck(CAT, 'ฝากเข้า credit บนกู้ที่ยังไม่มีงวดใดถึงกำหนด (maxPayable 0): 201 — นี่คือเส้นทางที่ gate ชี้', depMade, 201, {
      input: 'POST /api/payment-requests purpose DEPOSIT_TO_CREDIT (เพดานวันนี้ 0.00)',
    });
    const depRequest = depMade.json.data.request;
    check(CAT, 'คำขอ deposit บันทึก purpose ไว้ และ proposed allocation เป็น 0 ทุกส่วน', {
      input: 'POST response request.purpose + proposed',
      expected: `DEPOSIT_TO_CREDIT, ${COMPS.map((c) => `${c}=0.00`).join(' ')}`,
      actual: `${depRequest.purpose}, ${COMPS.map((c) => `${c}=${fmt(cent(depMade.json.data.proposed?.[c] ?? -1))}`).join(' ')}`,
      pass: depRequest.purpose === 'DEPOSIT_TO_CREDIT' && COMPS.every((c) => cent(depMade.json.data.proposed?.[c] ?? -1) === 0),
    });
    // An OPERATOR never reaches the maker-checker rule on approve — the role guard answers 403 first —
    // so the self-approve case needs a maker who is allowed to approve: ADMIN creates its own deposit.
    const selfMade = await createReq({ loanId: fresh.id, cashAmount: 20000, purpose: 'DEPOSIT_TO_CREDIT', note: 'ฝากโดย ADMIN เพื่อพิสูจน์ maker-checker' }, tokens.admin);
    statusCheck(CAT, 'ADMIN สร้างคำขอ deposit เองได้: 201 (ด่าน role ยอมรับ ADMIN)', selfMade, 201, {
      input: 'POST /api/payment-requests purpose DEPOSIT_TO_CREDIT ด้วย token ADMIN',
    });
    const selfRequest = selfMade.json.data.request;
    // Creating a request already stores its proposed allocation rows, and the loan already carries its
    // disbursement row, so "the rejected approve wrote nothing" is measured as a delta, not an absolute.
    const txBeforeSelfApprove = await countRows('SELECT COUNT(*) n FROM financial_transactions WHERE loanId = ?', [fresh.id]);
    const allocBeforeSelfApprove = await countRows('SELECT COUNT(*) n FROM payment_allocations WHERE paymentRequestId = ?', [selfRequest.id]);
    statusCheck(
      CAT,
      'ผู้สร้างอนุมัติ deposit เอง: 422 (รับฝากเงินก็ห้ามคนละคนกันเหมือนกัน)',
      await approveReq(selfRequest.id, {}, tokens.admin),
      422,
      {
        input: 'approve ด้วย token เดียวกับ creator — ครั้งนี้ creator เป็น role ที่อนุมัติได้ จึงเห็นด่าน maker-checker จริง',
        messageIncludes: 'maker-checker separation',
      },
    );
    const txAfterSelfApprove = await countRows('SELECT COUNT(*) n FROM financial_transactions WHERE loanId = ?', [fresh.id]);
    const allocAfterSelfApprove = await countRows('SELECT COUNT(*) n FROM payment_allocations WHERE paymentRequestId = ?', [selfRequest.id]);
    const creditOfSelf = await creditRow(C9);
    check(CAT, 'อนุมัติเองไม่ผ่าน: คำขอยัง PENDING, ไม่มี transaction/allocation เพิ่ม, credit ของ C9 ยังไม่มีแถว', {
      input: `payment_requests ${selfRequest.id} + financial_transactions ของ ${fresh.loanNumber}`,
      expected: `request PENDING, tx ${txBeforeSelfApprove} เท่าเดิม, allocation ${allocBeforeSelfApprove} เท่าเดิม, credit no row`,
      actual: `${selfRequest.status}, tx ${txAfterSelfApprove}, allocation ${allocAfterSelfApprove}, credit ${String(creditOfSelf?.b ?? 'no row')}`,
      pass:
        selfRequest.status === 'PENDING' &&
        txAfterSelfApprove === txBeforeSelfApprove &&
        allocAfterSelfApprove === allocBeforeSelfApprove &&
        creditOfSelf === null,
    });
    const depApproved = await approveReq(depRequest.id, { reason: 'รับเงินที่หน้าเคาน์เตอร์' }, tokens.checker1);
    statusCheck(CAT, 'checker อนุมัติ deposit: 200', depApproved, 200);
    const depTx = depApproved.json.data.transaction;
    check(CAT, 'transaction ของ deposit เป็นชนิด PAYMENT สถานะ APPROVED ยอดเท่าเงินสดที่รับ', {
      input: 'approve response transaction',
      expected: 'transactionType PAYMENT, status APPROVED, amount 50000.00, creditApplied 0.00',
      actual: `${depTx.transactionType}, ${depTx.status}, ${depTx.amount}, credit ${String(depTx.creditApplied)}`,
      pass: depTx.transactionType === 'PAYMENT' && depTx.status === 'APPROVED' && sameMoney(depTx.amount, 50000) && sameMoney(depTx.creditApplied ?? 0, 0),
    });
    const depPosted = await postTx(depTx.id);
    statusCheck(CAT, 'โพสต์ deposit: 200', depPosted, 200);
    const freshAfter = outstandingOf(await loanView(fresh.id));
    check(CAT, 'deposit ไม่ตัดหนี้: allocation 0 ทุกส่วน, excess = เงินทั้งก้อน, ยอดคงค้างเท่า oracle', {
      input: `POST /api/transactions/${depTx.id}/post`,
      expected: `${COMPS.map((c) => `${c}=0.00`).join(' ')} excess 50000.00 เหลือ ${asText(states.get(fresh.id).components)}`,
      actual: `${COMPS.map((c) => `${c}=${fmt(cent(depPosted.json?.data?.allocation?.[c] ?? -1))}`).join(' ')} excess ${fmt(
        cent(depPosted.json?.data?.excess ?? -1),
      )} เหลือ ${asText(freshAfter)}`,
      pass:
        COMPS.every((c) => cent(depPosted.json?.data?.allocation?.[c] ?? -1) === 0) &&
        cent(depPosted.json?.data?.excess ?? -1) === toCents(50000) &&
        COMPS.every((c) => freshAfter[c] === states.get(fresh.id).components[c]) &&
        sumCents(freshAfter) === sumCents(states.get(fresh.id).components),
    });
    const depLines = await lineRows(depTx.id);
    const depLedger = await creditLedger(C9);
    check(CAT, 'deposit ไม่สร้าง ledger line (ไม่มีการตัดหนี้) แต่ credit งอกจริงพร้อม balanceAfter', {
      input: 'financial_transaction_lines + customer_credits + credit_ledger ของ C9',
      expected: '0 lines, balance 50000.00, ledger [ACCRUED 50000.00 after 50000.00]',
      actual: `${depLines.length} lines, balance ${String((await creditRow(C9))?.b ?? 'no row')}, ledger ${JSON.stringify(
        depLedger.map((r) => [r.type, r.amount, r.balanceAfter]),
      ).slice(0, 120)}`,
      pass:
        depLines.length === 0 &&
        sameMoney((await creditRow(C9))?.b ?? -1, 50000) &&
        depLedger.length === 1 &&
        depLedger[0].type === 'ACCRUED' &&
        cent(depLedger[0].amount) === toCents(50000) &&
        cent(depLedger[0].balanceAfter) === toCents(50000),
    });
    const freshSubmitted = (await mailFor(fresh.id, 'PAYMENT_REQUEST_SUBMITTED')).filter((r) => r.requestNo === depRequest.requestNo);
    const freshApproved = (await mailFor(fresh.id, 'PAYMENT_REQUEST_APPROVED')).filter((r) => r.requestNo === depRequest.requestNo);
    const freshCredit = await mailFor(fresh.id, 'CREDIT_DEPOSITED', 50000);
    const freshBorrower = await borrowerEmail(fresh.id);
    const freshAudience = [freshBorrower, ...approverEmails];
    const freshDecided = [...new Set([...freshAudience, await makerEmail('test_op1')])];
    check(CAT, 'ฝากเข้า credit: เกิดเมลแจ้งคำขอถึงผู้กู้ +ผู้มีอำนาจ พร้อมประเภทคำขอเป็นช่องเติมเครดิต', {
      input: 'notification_outbox type=PAYMENT_REQUEST_SUBMITTED ของ FRESH, requestNo ของคำขอนี้',
      expected: `${freshAudience.length} แถว, amount 50,000 LAK, purposeLabel ไม่ใช่ค่าว่าง`,
      actual: `${freshSubmitted.length} แถว ${JSON.stringify(freshSubmitted.map((r) => [r.recipientEmail, r.amount, r.purposeLabel]))}`,
      pass:
        freshSubmitted.length === freshAudience.length &&
        reaches(freshSubmitted, freshAudience) &&
        freshSubmitted.every((r) => moneyOf(r.amount) === '50000' && !!r.purposeLabel),
      note: 'purposeLabel ต่างกันระหว่าง "ชำระหนี้" กับ "นำเงินเข้าเครดิต" ผู้รับจึงแยกออกว่าเมลนี้ไม่ได้บอกว่าหนี้ถูกตัด',
    });
    check(CAT, 'อนุมัติคำฝากแล้วมีเมล APPROVED ให้ผู้มีอำนาจ ส่วนเงินที่เข้าเครดิตเป็นอีกเมลหนึ่งถึงผู้กู้คนเดียว', {
      input: 'notification_outbox type=PAYMENT_REQUEST_APPROVED + CREDIT_DEPOSITED ของ FRESH',
      expected: `APPROVED ${freshDecided.length} แถว (ผู้กู้ +ผู้มีอำนาจ +maker ที่ยื่น), CREDIT_DEPOSITED ถึงเฉพาะผู้กู้และมียอดคงเหลือในเครดิต`,
      actual: `${freshApproved.length}/${freshCredit.length} แถว ${JSON.stringify(freshCredit.map((r) => [r.recipientEmail, r.amount, r.creditBalance]))}`,
      pass:
        freshApproved.length === freshDecided.length &&
        reaches(freshApproved, freshDecided) &&
        freshCredit.length >= 1 &&
        freshCredit.every((r) => String(r.recipientEmail).toLowerCase() === String(freshBorrower).toLowerCase() && !!r.creditBalance),
      note: 'การอนุมัติของตัวเองยังไม่ทำให้เงินเป็นเครดิต — เมล CREDIT_DEPOSITED เกิดตอนโพสต์เท่านั้น จึงตรงกับ credit_ledger ที่ตรวจไว้ข้างบน',
    });
    const depAudit = await rows(conn, "SELECT action FROM audit_logs WHERE loanId = ? AND action IN ('PAYMENT_REQUEST_APPROVED', 'CREDIT_ACCRUED') ORDER BY createdAt", [
      fresh.id,
    ]);
    check(CAT, 'เส้นทาง deposit มี audit ครบทั้งอนุมัติรายการและ credit ที่งอก (ตรวจย้อนหลังได้)', {
      input: 'audit_logs ของ loan FRESH',
      expected: 'PAYMENT_REQUEST_APPROVED แล้ว CREDIT_ACCRUED',
      actual: JSON.stringify(depAudit.map((r) => r.action)),
      pass: depAudit.map((r) => r.action).join(',') === 'PAYMENT_REQUEST_APPROVED,CREDIT_ACCRUED',
    });
    const freshWithCredit = await payableNow(fresh.id);
    check(CAT, 'payable-now คืน creditBalance ของลูกค้า (UI ใช้บอกยอดที่ฝากไว้) และเพดานยัง 0', {
      input: 'GET /payable-now หลังฝาก 50,000',
      expected: 'creditBalance 50000.00, maxPayable 0.00',
      actual: `creditBalance ${fmt(cent(freshWithCredit.creditBalance))}, maxPayable ${fmt(cent(freshWithCredit.maxPayable))}`,
      pass: cent(freshWithCredit.creditBalance) === toCents(50000) && cent(freshWithCredit.maxPayable) === 0,
    });
    statusCheck(CAT, 'deposit บน loan ที่ CLOSED แล้ว: 422 (ต้องมีสถานะ ACTIVE เท่านั้น)', await createReq({ loanId: full.id, cashAmount: 1000, purpose: 'DEPOSIT_TO_CREDIT' }), 422, {
      input: 'FULL เปลี่ยนเป็น CLOSED แล้ว',
      messageIncludes: 'payments require an ACTIVE loan',
    });

    // ================================================ D. the auto-debit job
    const policyGet = await api('GET', '/api/config/payment', { token: tokens.viewer });
    statusCheck(CAT, 'GET /api/config/payment: VIEWER อ่าน policy ได้ 200', policyGet, 200);
    const policy = policyGet.json?.data?.policy ?? {};
    check(CAT, 'policy การเก็บเงินมีสวิตช์ auto-debit + lead days และ env default ปิดสวิตช์ไว้', {
      input: 'GET /api/config/payment',
      expected: 'policy {autoDebitEnabled, autoDebitLeadDays}, defaults.autoDebitEnabled false, มี checksum และ defaults',
      actual: `policy ${JSON.stringify(policy)} defaults ${JSON.stringify(policyGet.json?.data?.defaults)} checksum ${String(
        policyGet.json?.data?.checksum,
      ).slice(0, 8)}`,
      pass:
        typeof policy.autoDebitEnabled === 'boolean' &&
        Number.isFinite(Number(policy.autoDebitLeadDays)) &&
        policyGet.json?.data?.defaults?.autoDebitEnabled === false &&
        !!policyGet.json?.data?.checksum &&
        !!policyGet.json?.data?.defaults,
    });
    const lead = Number(policy.autoDebitLeadDays);

    for (const [name, token, want] of [
      ['anon', null, 401],
      ['viewer', tokens.viewer, 403],
      ['maker', tokens.op1, 403],
      ['checker', tokens.checker1, 403],
      ['head', tokens.head, 403],
    ]) {
      statusCheck(CAT, `POST /config/payment/auto-debit/run ด้วย role ${name}: ${want}`, await runAutoDebit({ dryRun: true }, token), want, {
        input: `token=${name}`,
        note: want === 401 ? 'ต้องเป็น 401 ไม่ใช่ 403' : 'เฉพาะ ADMIN ที่สั่งรอบนี้ได้',
      });
    }

    // The customer brings money early: 150,000 against an instalment of 110,800.
    await postThrough(ad, { cashAmount: 150000, purpose: 'DEPOSIT_TO_CREDIT' }, 'ฝาก 150,000 (AD)');
    const adDepositOutstanding = sumCents(outstandingOf(await loanView(ad.id)));
    check(CAT, 'ฝาก 150,000 ให้ AD: credit ของลูกค้า C7 พร้อมใช้แล้ว และหนี้ยังไม่ถูกตัด', {
      input: 'customer_credits.balance ของ C7 + GET /api/loans/AD',
      expected: 'credit 150000.00, outstanding ยัง ' + fmt(adDebt),
      actual: `credit ${String((await creditRow(C7))?.b ?? 'no row')}, outstanding ${fmt(adDepositOutstanding)}`,
      pass: sameMoney((await creditRow(C7))?.b ?? -1, 150000) && adDepositOutstanding === adDebt,
    });

    // The job's window opens `lead` days before the instalment falls due.
    const inWindow = stamp(addDays(adState.firstDue, -(lead - 1)));
    const outWindow = stamp(addDays(adState.firstDue, -(lead + 1)));
    const reqsBefore = await countRows('SELECT COUNT(*) n FROM payment_requests');
    const auditBefore = await debitRunAudit();
    const machineBefore = await machineCount();

    const dryRes = await runAutoDebit({ loanId: ad.id, asOf: inWindow, dryRun: true });
    statusCheck(CAT, 'dryRun ของ auto-debit: 200 (รายงานอย่างเดียว ไม่แตะบัญชี)', dryRes, 200, {
      input: `POST /config/payment/auto-debit/run {loanId: AD, asOf: ${day(inWindow)}, dryRun: true}`,
    });
    const dry = dryRes.json.data;
    const plannedAmount = cent(dry.planned[0]?.amount ?? -1);
    check(CAT, 'dryRun วางแผนงวดที่อยู่ใน window (lead days) โดยไม่สร้างคำขอ ไม่เขียน audit และไม่สร้างบัญชีเครื่อง', {
      input: `asOf = ${day(inWindow)} (งวด 1 ครกำหนด ${adState.firstDue}, lead ${lead} วัน)`,
      expected: `planned 1 (period 1, due ${adState.firstDue}), debited/skipped/failed ว่าง, payment_requests ไม่เพิ่ม, audit AUTO_DEBIT_RUN ไม่เพิ่ม, บัญชีเครื่องยังไม่ถูกสร้าง`,
      actual: `planned ${JSON.stringify(dry.planned.slice(0, 1)).slice(0, 140)} debited ${dry.debited.length} skipped ${dry.skipped.length} failed ${
        dry.failed.length
      }, requests +${(await countRows('SELECT COUNT(*) n FROM payment_requests')) - reqsBefore}, audit +${await debitRunAudit() - auditBefore}, machine ${await machineCount()} rows`,
      pass:
        dry.dryRun === true &&
        dry.enabled === false &&
        dry.leadDays === lead &&
        dry.planned.length === 1 &&
        dry.planned[0].periodIndex === 1 &&
        dry.planned[0].loanNumber === ad.loanNumber &&
        plannedAmount > 0 &&
        plannedAmount <= toCents(150000) &&
        day(dry.planned[0].dueDate) === adState.firstDue &&
        dry.debited.length === 0 &&
        dry.skipped.length === 0 &&
        dry.failed.length === 0 &&
        (await countRows('SELECT COUNT(*) n FROM payment_requests')) === reqsBefore &&
        (await debitRunAudit()) === auditBefore &&
        (await machineCount()) === machineBefore,
    });
    check(CAT, 'reason ของ planned บอกชื่อกู้/งวด/วันครบกำหนด/จำนวนวันล่วงหน้า (ตรวจได้โดยไม่ต้องเปิด DB)', {
      input: 'planned[0].reason',
      expected: `AUTO-DEBIT ${ad.loanNumber} period 1 (falls due ${adState.firstDue}) from customer credit, ${lead} day(s) ahead`,
      actual: String(dry.planned[0]?.reason ?? ''),
      pass:
        String(dry.planned[0]?.reason ?? '') ===
        `AUTO-DEBIT ${ad.loanNumber} period 1 (falls due ${adState.firstDue}) from customer credit, ${lead} day(s) ahead`,
    });
    const drySmall = await runAutoDebit({ loanId: adSmall.id, asOf: inWindow, dryRun: true });
    check(CAT, 'dryRun บอก skip เหมือนรอบจริง: AD-SMALL ยังไม่มี credit เลย งวดจึงไม่ถูกวางแผน', {
      input: `POST run {loanId: AD-SMALL, asOf: ${day(inWindow)}, dryRun: true}`,
      expected: 'planned 0, skipped 1 reason "does not cover period 1"',
      actual: `planned ${drySmall.json?.data?.planned?.length}, skipped ${JSON.stringify(drySmall.json?.data?.skipped)}`,
      pass:
        drySmall.json?.data?.planned?.length === 0 &&
        /does not cover period 1/.test(drySmall.json?.data?.skipped?.[0]?.reason ?? '') &&
        (await countRows('SELECT COUNT(*) n FROM payment_requests')) === reqsBefore,
    });

    const wholeOff = await runAutoDebit({ asOf: inWindow });
    check(CAT, 'รอบทั้งบัญชีขณะสวิตช์ OFF: คืนผลว่างและไม่แตะอะไรเลย (ระบบไม่เก็บเงินเองถ้าไม่มีใครสั่ง)', {
      input: 'POST /config/payment/auto-debit/run {asOf} (ไม่มี loanId, สวิตช์ OFF)',
      expected: 'enabled false, scanned > 0, planned/debited/skipped ว่าง, payment_requests ไม่เพิ่ม',
      actual: `enabled ${wholeOff.json?.data?.enabled}, scanned ${wholeOff.json?.data?.scanned}, planned ${
        wholeOff.json?.data?.planned?.length
      }, debited ${wholeOff.json?.data?.debited?.length}, requests +${(await countRows('SELECT COUNT(*) n FROM payment_requests')) - reqsBefore}`,
      pass:
        wholeOff.status === 200 &&
        wholeOff.json.data.enabled === false &&
        wholeOff.json.data.scanned > 0 &&
        wholeOff.json.data.planned.length === 0 &&
        wholeOff.json.data.debited.length === 0 &&
        wholeOff.json.data.skipped.length === 0 &&
        (await countRows('SELECT COUNT(*) n FROM payment_requests')) === reqsBefore,
    });

    const run1 = await runAutoDebit({ loanId: ad.id, asOf: inWindow });
    statusCheck(CAT, 'ADMIN สั่งรอบเก็บเงินเฉพาะกู้ (loanId) แม้สวิตช์ OFF: 200 และ debit จริง 1 รายการ', run1, 200, {
      input: `POST /config/payment/auto-debit/run {loanId: AD, asOf: ${day(inWindow)}}`,
    });
    const debit1 = run1.json.data.debited[0] ?? {};
    check(CAT, 'debit ครั้งแรกตรงกับที่ dryRun วางไว้ (งวด 1, ยอดเดิม, loan เดิม, มี requestNo)', {
      input: 'debited[0]',
      expected: `periodIndex 1, amount ${fmt(plannedAmount)}, loanNumber ${ad.loanNumber}, requestNo PR-______`,
      actual: `periodIndex ${debit1.periodIndex}, amount ${fmt(cent(debit1.amount ?? -1))}, loanNumber ${debit1.loanNumber}, requestNo ${debit1.requestNo}`,
      pass:
        debit1.periodIndex === 1 &&
        cent(debit1.amount ?? -1) === plannedAmount &&
        debit1.loanNumber === ad.loanNumber &&
        /^PR-\d{6}$/.test(String(debit1.requestNo ?? '')) &&
        run1.json.data.debited.length === 1 &&
        run1.json.data.skipped.length === 0 &&
        run1.json.data.failed.length === 0,
    });
    const machine = (await rows(conn, "SELECT id, username, role, isActive, email FROM users WHERE username = 'system.auto-debit'"))[0] ?? null;
    const afterRun = await paymentRows(ad.id);
    check(CAT, 'auto-debit เดินเส้นทางเดียวกับมนุษย์: request -> approve -> POSTED พร้อม periodIndex', {
      input: 'financial_transactions (PAYMENT) ของ AD',
      expected: `2 แถว: deposit POSTED periodIndex null (คนสร้าง) + debit POSTED periodIndex 1 amount ${fmt(plannedAmount)} createdBy = บัญชีเครื่อง`,
      actual: JSON.stringify(afterRun.map((r) => [r.status, String(r.amount), r.periodIndex, r.createdBy === machine?.id ? 'machine' : 'human'])),
      pass:
        afterRun.length === 2 &&
        afterRun.some((r) => r.status === 'POSTED' && r.periodIndex === null && r.createdBy !== machine?.id) &&
        afterRun.some((r) => r.status === 'POSTED' && Number(r.periodIndex) === 1 && cent(r.amount) === plannedAmount && r.createdBy === machine?.id),
    });
    check(CAT, 'บัญชีเครื่องของ job ถูกต้อง: inactive, role CHECKER, ไม่มี email', {
      input: "users WHERE username = 'system.auto-debit'",
      expected: 'isActive 0, role CHECKER, email NULL, มีแถวเดียว',
      actual: JSON.stringify(machine),
      pass: !!machine && Number(machine.isActive) === 0 && machine.role === 'CHECKER' && machine.email === null && (await machineCount()) === 1,
    });
    statusCheck(CAT, 'login ด้วยบัญชีเครื่อง: 401 (ไม่มีใครใช้บัญชีนี้เข้าระบบได้)', await login('system.auto-debit'), 401, {
      input: 'POST /api/auth/login system.auto-debit',
      note: 'passwordHash เป็น randomUUID ที่ทิ้งทันที จึงลองตรงไม่ได้',
    });

    const debitVerify = await verifySettled(ad, { tx: { id: debit1.transactionId } }, plannedAmount, `auto-debit งวด 1 ของ ${ad.loanNumber}`);
    const adLedger = await creditLedger(C7);
    const creditAfterDebit = cent((await creditRow(C7))?.b ?? -1);
    check(CAT, 'auto-debit ใช้ credit ไม่ใช่เงินสด: ACCRUED แล้ว USED ปิดยอด, balance = ผลต่างเป๊ะ', {
      input: 'credit_ledger + customer_credits ของ C7',
      expected: `[ACCRUED 150000.00, USED ${fmt(plannedAmount)}], balance ${fmt(toCents(150000) - plannedAmount)}`,
      actual: `${JSON.stringify(adLedger.map((r) => [r.type, r.amount, r.balanceAfter])).slice(0, 140)} balance ${fmt(creditAfterDebit)}`,
      pass:
        adLedger.length === 2 &&
        adLedger[0].type === 'ACCRUED' &&
        cent(adLedger[0].amount) === toCents(150000) &&
        adLedger[1].type === 'USED' &&
        cent(adLedger[1].amount) === plannedAmount &&
        creditAfterDebit === toCents(150000) - plannedAmount,
    });

    const autoMail = await mailFor(ad.id, 'AUTO_DEBIT_POSTED', toLak(plannedAmount));
    const adBorrower = await borrowerEmail(ad.id);
    const humanDebits = (await paymentRows(ad.id)).filter((r) => r.periodIndex === null).length;
    const receiptMails = await countRows("SELECT COUNT(*) n FROM notification_outbox WHERE loanId = ? AND type = 'PAYMENT_POSTED'", [ad.id]);
    check(CAT, 'job ตัดงวดอัตโนมัติเกิดเมล AUTO_DEBIT_POSTED ระบุเลขงวด ถึงผู้กู้คนเดียว', {
      input: 'notification_outbox type=AUTO_DEBIT_POSTED ของ AD',
      expected: '1 แถวถึงผู้กู้, instalment 1, amount ตรงยอดงวด, allocation + remaining ไม่ใช่ค่าว่าง',
      actual: `${autoMail.length} แถว ${JSON.stringify(autoMail.map((r) => [r.recipientEmail, r.instalment, r.amount, r.allocation, r.remaining]))}`,
      pass:
        autoMail.length === 1 &&
        String(autoMail[0]?.recipientEmail).toLowerCase() === String(adBorrower).toLowerCase() &&
        autoMail[0]?.instalment === '1' &&
        !!autoMail[0]?.allocation &&
        !!autoMail[0]?.remaining,
      note: 'ไม่มีเงินสดเข้ามาใหม่ ณ ช่วงนี้ เงินคือ credit ที่ลูกค้าฝากไว้ก่อนหน้า เมลจึงต้องบอกว่า "ตัดงวดที่เท่าไร" ไม่ใช่ "ได้รับเงินชำระ"',
    });
    check(CAT, 'การตัดอัตโนมัติไม่ออกใบเสร็จซ้ำ: จำนวนเมล PAYMENT_POSTED ของ AD = รายการที่มนุษย์โพสต์เท่านั้น', {
      input: 'notification_outbox PAYMENT_POSTED เทียบ financial_transactions (PAYMENT, periodIndex IS NULL) ของ AD',
      expected: `${humanDebits} แถว`,
      actual: `${receiptMails} แถว`,
      pass: receiptMails === humanDebits,
      note: 'แถวฝากเงิน (periodIndex = null) ยังได้ใบเสร็จตามเดิม ส่วนแถวของ job (periodIndex = 1) สลับเป็น AUTO_DEBIT_POSTED แทน — ผู้รับจะไม่ได้รับเมลสองฉบับเรื่องเดียวกัน',
    });
    const run2 = await runAutoDebit({ loanId: ad.id, asOf: inWindow });
    check(CAT, 'รันซ้ำด้วย asOf เดิม: ไม่ debit ซ้ำ (งวดถูกตัดจาก ledger แล้ว จึงไม่มีอะไรค้างใน window)', {
      input: 'POST /config/payment/auto-debit/run {loanId: AD} ครั้ง 2',
      expected: 'debited 0, skipped 1, จำนวนแถว PAYMENT ยัง 2',
      actual: `debited ${run2.json.data.debited.length}, skipped ${JSON.stringify(run2.json.data.skipped)}, payments ${(await paymentRows(ad.id)).length}`,
      pass:
        run2.json.data.debited.length === 0 &&
        run2.json.data.skipped.length === 1 &&
        run2.json.data.skipped[0].loanNumber === ad.loanNumber &&
        (await paymentRows(ad.id)).length === 2,
    });

    // Staff reverses the machine debit: the instalment reopens, but the job must still refuse it.
    const reversed = await api('POST', '/api/transactions/reversals', {
      token: tokens.op1,
      body: { referenceTransactionId: debit1.transactionId, amount: toLak(plannedAmount), reason: 'suite17: กลับรายการ auto-debit เพื่อตรวจ idempotency' },
    });
    statusCheck(CAT, 'reverse auto-debit ที่ POSTED แล้ว: สร้างคำขอ reversal ได้ 201', reversed, 201, {
      input: `POST /api/transactions/reversals amount ${fmt(plannedAmount)} ของ ${debit1.requestNo}`,
    });
    const reversalTx = reversed.json?.data?.transaction ?? {};
    for (const tk of [tokens.checker1, tokens.head]) {
      const step = await findStep(reversalTx.id, tk);
      if (step) await api('POST', `/api/approvals/steps/${step.stepId}/decision`, { token: tk, body: { decision: 'APPROVE' } });
    }
    const reversalPosted = await postTx(reversalTx.id);
    statusCheck(CAT, 'โพสต์ reversal ของ auto-debit: 200', reversalPosted, 200);
    const reversalLines = Object.fromEntries((await lineRows(reversalTx.id)).map((r) => [r.component, cent(r.amount)]));
    const adStateNow = states.get(ad.id);
    COMPS.forEach((c) => {
      adStateNow.components[c] += debitVerify.exp.allocation[c];
    });
    const adAfterReversal = outstandingOf(await loanView(ad.id));
    check(CAT, 'reversal เปิดงวดกลับคืนมา exact: ledger line ตรงข้ามกับยอดที่ debit ไป และยอดคงเหลือเท่า oracle', {
      input: 'financial_transaction_lines ของ reversal เทียบกับ allocation ของ debit',
      expected: `${COMPS.map((c) => `${c}=+${fmt(debitVerify.exp.allocation[c])}`).join(' ')} แล้ว outstanding กลับเป็น ${asText(adStateNow.components)}`,
      actual: `${COMPS.map((c) => `${c}=+${fmt(reversalLines[c] ?? 0)}`).join(' ')} outstanding ${asText(adAfterReversal)}`,
      pass:
        COMPS.every((c) => (reversalLines[c] ?? 0) === debitVerify.exp.allocation[c]) &&
        COMPS.every((c) => adAfterReversal[c] === adStateNow.components[c]),
    });

    const run3 = await runAutoDebit({ loanId: ad.id, asOf: inWindow });
    check(CAT, 'งวดกลับมา open อีกครั้งหลัง reversal: job ยังปฏิเสธ — periodIndex เดิมถูกจองไว้แล้ว (idempotent จริง)', {
      input: 'POST /config/payment/auto-debit/run {loanId: AD} ครั้ง 3 (หลัง reversal)',
      expected: 'debited 0, skipped 1 reason "Every instalment inside the lead window has already been debited"',
      actual: `debited ${run3.json.data.debited.length}, skipped ${JSON.stringify(run3.json.data.skipped)}`,
      pass:
        run3.json.data.debited.length === 0 &&
        /has already been debited/.test(run3.json.data.skipped[0]?.reason ?? '') &&
        (await paymentRows(ad.id)).length === 2,
    });
    const creditAfterReversal = cent((await creditRow(C7))?.b ?? -1);
    check(CAT, 'เงินไม่หายเมื่อกลับรายการ: หนี้ที่เปิดกลับ + credit ที่เหลือ = เงินที่ฝากไว้ 150,000', {
      input: 'ยอดที่เปิดกลับ + customer_credits ของ C7',
      expected: `${fmt(plannedAmount)} (หนี้) + ${fmt(toCents(150000) - plannedAmount)} (credit) = 150000.00`,
      actual: `หนี้ที่เปิดกลับ ${fmt(plannedAmount)} + credit ${fmt(creditAfterReversal)}`,
      pass:
        plannedAmount + (toCents(150000) - plannedAmount) === toCents(150000) &&
        creditAfterReversal === toCents(150000) - plannedAmount &&
        sumCents(adAfterReversal) === adDebt,
      note: 'reversal ไม่คืน credit ที่ใช้ไป (postPaymentReversal ใน posting-engine.service.ts ปรับหนี้เท่านั้น) ลูกค้าต้องฝากใหม่เท่ายอดที่เปิดกลับ',
    });

    const runOut = await runAutoDebit({ loanId: ad.id, asOf: outWindow });
    check(CAT, 'asOf ก่อน window ของ lead days: ยังไม่ถึงเวลาของงวดใด -> skip ว่าไม่มีงวดใน window', {
      input: `asOf = ${day(outWindow)} (งวด 1 ครกำหนด ${adState.firstDue}, lead ${lead} วัน)`,
      expected: 'debited 0, skip reason "No instalment is inside the lead window yet"',
      actual: `debited ${runOut.json.data.debited.length}, skipped ${JSON.stringify(runOut.json.data.skipped)}`,
      pass:
        runOut.json.data.debited.length === 0 &&
        /No instalment is inside the lead window yet/.test(runOut.json.data.skipped[0]?.reason ?? ''),
    });

    await postThrough(adSmall, { cashAmount: 1000, purpose: 'DEPOSIT_TO_CREDIT' }, 'ฝาก 1,000 (AD-SMALL)');
    const runSmall = await runAutoDebit({ loanId: adSmall.id, asOf: inWindow });
    check(CAT, 'credit ไม่พองวด: ไม่เก็บแบบเศษงวด (รอเก็บทั้งงวด) พร้อมเหตุผลบอกตัวเลขทั้งสองฟาก', {
      input: `POST run {loanId: AD-SMALL, asOf: ${day(inWindow)}} credit 1000.00`,
      expected: 'debited 0, skip reason "does not cover period 1 ... waiting for the rest instead of taking a partial debit"',
      actual: `debited ${runSmall.json.data.debited.length}, skipped ${JSON.stringify(runSmall.json.data.skipped)}`,
      pass:
        runSmall.json.data.debited.length === 0 &&
        /does not cover period 1/.test(runSmall.json.data.skipped[0]?.reason ?? '') &&
        /waiting for the rest instead of taking a partial debit/.test(runSmall.json.data.skipped[0]?.reason ?? '') &&
        (await paymentRows(adSmall.id)).length === 1,
    });
    const runFresh = await runAutoDebit({ loanId: fresh.id });
    check(CAT, 'กู้ที่ปล่อย 5 วันก่อน (asOf ตามนาฬิกาจริง): ยังไม่มีงวดใน window -> skip และ credit 50,000 ยังอยู่ครบ', {
      input: 'POST run {loanId: FRESH} (ไม่ส่ง asOf)',
      expected: 'debited 0, skip reason เรื่อง lead window, credit 50000.00 คงเดิม, PAYMENT มีแค่แถว deposit',
      actual: `debited ${runFresh.json.data.debited.length}, skipped ${JSON.stringify(runFresh.json.data.skipped.map((s) => s.reason))}, credit ${String(
        (await creditRow(C9))?.b ?? 'no row',
      )}, payments ${await paymentRows(fresh.id).then((r) => r.length)}`,
      pass:
        runFresh.json.data.debited.length === 0 &&
        /lead window/.test(runFresh.json.data.skipped[0]?.reason ?? '') &&
        sameMoney((await creditRow(C9))?.b ?? -1, 50000) &&
        (await paymentRows(fresh.id)).length === 1,
    });

    const runAudit = await rows(conn, "SELECT newStatus, reason FROM audit_logs WHERE action = 'AUTO_DEBIT_RUN' ORDER BY createdAt");
    const runAuditRows = runAudit.slice(auditBefore);
    check(CAT, 'ทุกรอบที่ไม่ใช่ dryRun เขียน audit AUTO_DEBIT_RUN (ใครสั่ง สแกนกี่ฉบับ สวิตช์สถานะไหน ผลเท่าไร)', {
      input: 'audit_logs WHERE action = AUTO_DEBIT_RUN ของรอบนี้',
      expected: '7 แถว (whole-book OFF + run1 + run2 + run3 หลัง reversal + out-of-window + AD-SMALL + FRESH), newStatus ADMIN_SCOPED_RUN เพราะสวิตช์ปิดอยู่',
      actual: JSON.stringify(runAuditRows.map((r) => [r.newStatus, String(r.reason).slice(0, 60)])).slice(0, 400),
      pass:
        runAuditRows.length === 7 &&
        runAuditRows.every((r) =>
          /Manual auto-debit pass over \d+ active loan\(s\), lead \d+ day\(s\), switch (on|off): \d+ debit\(s\), \d+ skip\(s\), \d+ failure\(s\)/.test(
            String(r.reason),
          ),
        ) &&
        runAuditRows.every((r) => r.newStatus === 'ADMIN_SCOPED_RUN'),
    });

    const cfgBefore = await countRows("SELECT COUNT(*) n FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND reason LIKE '%Payment policy%'");
    const badLead = await api('PUT', '/api/config/payment', { body: { autoDebitEnabled: true, autoDebitLeadDays: -1 } });
    statusCheck(CAT, 'PUT /config/payment autoDebitLeadDays ติดลบ: 400 (validation ก่อนเขียน)', badLead, 400, { input: 'autoDebitLeadDays=-1' });
    const badMax = await api('PUT', '/api/config/payment', { body: { autoDebitLeadDays: 91 } });
    statusCheck(CAT, 'PUT /config/payment autoDebitLeadDays เกิน 90 วัน: 400', badMax, 400, { input: 'autoDebitLeadDays=91' });
    const cfgAfterBad = await countRows("SELECT COUNT(*) n FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND reason LIKE '%Payment policy%'");
    check(CAT, 'PUT ที่ถูกปฏิเสธไม่เขียน audit CONFIG_UPDATED (ไม่มีแถวกำพร้าจากรายการที่ล้มเหลว)', {
      input: 'audit_logs CONFIG_UPDATED ของ payment policy หลัง 2 คำขอที่ 400',
      expected: `${cfgBefore} แถว (ไม่เพิ่ม)`,
      actual: `${cfgAfterBad} แถว`,
      pass: cfgAfterBad === cfgBefore,
    });
    const changedLead = await api('PUT', '/api/config/payment', { body: { autoDebitEnabled: false, autoDebitLeadDays: 7 } });
    statusCheck(CAT, 'ADMIN แก้ lead days ผ่าน API: 200 (สวิตช์ยังปิด จึงไม่มีรอบไหนเดินเอง)', changedLead, 200, {
      input: 'autoDebitEnabled=false, autoDebitLeadDays=7',
      note: 'ไม่ทดสอบทิศ "เปิดสวิตช์" ด้วยการรันทั้งบัญชี เพราะ timer ของเซิร์ฟเวอร์ (ทุก 15 นาที) อาจ tick มา debit หนังสือจริงระหว่างที่สวิตช์เปิดค้าง',
    });
    const policyNow = (await api('GET', '/api/config/payment')).json?.data?.policy;
    check(CAT, 'policy ที่อ่านกลับมาจาก system_config ทับ env default ตามที่ PUT', {
      input: 'GET /api/config/payment หลัง PUT leadDays=7',
      expected: 'autoDebitLeadDays 7, autoDebitEnabled false',
      actual: JSON.stringify(policyNow),
      pass: policyNow?.autoDebitLeadDays === 7 && policyNow?.autoDebitEnabled === false,
    });
    const dry7 = await runAutoDebit({ loanId: ad.id, dryRun: true });
    check(CAT, 'job อ่าน policy ทุกครั้งที่รัน (ไม่ต้อง restart): dryRun รายงาน leadDays ตัวใหม่ทันที', {
      input: 'POST run dryRun หลัง PUT leadDays=7',
      expected: 'leadDays 7, enabled false',
      actual: `leadDays ${dry7.json?.data?.leadDays}, enabled ${dry7.json?.data?.enabled}`,
      pass: dry7.json?.data?.leadDays === 7 && dry7.json?.data?.enabled === false,
    });
    const cfgAuditAll = await rows(conn, "SELECT reason FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND reason LIKE '%Payment policy%' ORDER BY createdAt");
    const cfgAuditRows = cfgAuditAll.slice(cfgBefore);
    check(CAT, 'การเปลี่ยน policy ถูก audit แบบ previous -> updated ให้ตอบผู้ตรวจสอบได้', {
      input: 'audit_logs CONFIG_UPDATED ของ payment policy ที่เกิดจาก suite นี้',
      expected: '1 แถวรูปแบบ Payment policy autoDebit=off,leadDays=N  ->  autoDebit=off,leadDays=M (2 PUT ที่ 400 ต้องไม่มีแถว)',
      actual: JSON.stringify(cfgAuditRows.map((r) => String(r.reason))).slice(0, 300),
      pass:
        cfgAuditRows.length === 1 &&
        /Payment policy autoDebit=(on|off),leadDays=\d+\s+->\s+autoDebit=(on|off),leadDays=\d+/.test(String(cfgAuditRows[0]?.reason)),
    });

    const finalOutstanding = outstandingOf(await loanView(ad.id));
    const finalCredit = cent((await creditRow(C7))?.b ?? -1);
    check(CAT, `สรุปเส้นทางเงินของ ${ad.loanNumber}: ฝาก 150,000 -> debit ${fmt(plannedAmount)} -> reversal เปิดหนี้กลับ -> credit เหลือเท่าผลต่างเป๊ะ`, {
      input: 'GET /api/loans/AD + customer_credits ของ C7',
      expected: `outstanding กลับเป็น ${fmt(adDebt)} ทั้งก้อน, credit ${fmt(toCents(150000) - plannedAmount)}`,
      actual: `outstanding ${asText(finalOutstanding)} (${fmt(sumCents(finalOutstanding))}), credit ${fmt(finalCredit)}`,
      pass: sumCents(finalOutstanding) === adDebt && finalCredit === toCents(150000) - plannedAmount,
    });

    // ================================================ E. cleanup + restore
    const machineId = (await rows(conn, "SELECT id FROM users WHERE username = 'system.auto-debit'"))[0]?.id ?? '';
    const requestSplit = (
      await rows(
        conn,
        'SELECT SUM(createdBy = ?) machineRequests, SUM(createdBy <> ?) humanRequests FROM payment_requests WHERE loanId IN (?)',
        [machineId, machineId, created],
      )
    )[0] ?? {};
    const submittedRequests = new Set(
      (
        await rows(
          conn,
          "SELECT payload FROM notification_outbox WHERE loanId IN (?) AND type = 'PAYMENT_REQUEST_SUBMITTED'",
          [created],
        )
      )
        .map((row) => payloadOf(row).requestNo)
        .filter(Boolean),
    ).size;
    check(CAT, 'เมลแจ้งยื่นคำขอ = จำนวนคำขอที่มนุษย์สร้างเท่านั้น (รอบของ job ไม่ส่งเมลแจ้งยื่น)', {
      input: 'payment_requests แยก createdBy เทียบ number of distinct requestNo ใน notification_outbox (ทุก loan ของ suite)',
      expected: `SUBMITTED ${Number(submittedRequests)} = humanRequests ${Number(requestSplit.humanRequests ?? 0)} และมี machineRequests >= 1 ที่ไม่มีเมลแจ้งยื่น`,
      actual: `submitted ${submittedRequests}, human ${Number(requestSplit.humanRequests ?? 0)}, machine ${Number(requestSplit.machineRequests ?? 0)}`,
      pass:
        Number(submittedRequests) === Number(requestSplit.humanRequests ?? -1) &&
        Number(requestSplit.machineRequests ?? 0) >= 1 &&
        submittedRequests > 0,
      note: 'job เรียก createAndApprovePaymentRequest ตรง ๆ โดยไม่ผ่าน router จึงไม่มีเมลแจ้งยื่น/อนุมัติจากเครื่อง เหลือแค่เมล AUTO_DEBIT_POSTED ตอนโพสต์งวด — ผู้กู้ไม่ถูกรบกวนทุก ๆ 5 นาที',
    });

    await settle(400);
    await purge();
    const counts = {};
    for (const t of TABLES) counts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const dirty = Object.keys(baseline).filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: แถวทุกตารางที่ suite นี้แตะกลับเท่าก่อนเริ่ม (loan/request/ledger/credit/audit)', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      pass: dirty.length === 0,
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
    });
    const policyBack = (await api('GET', '/api/config/payment')).json?.data?.policy;
    check(CAT, 'policy การเก็บเงินถูกคืนค่าเดิม (สวิตช์ปิดตาม default, lead days เท่าเดิม)', {
      input: 'GET /api/config/payment หลัง restore',
      expected: JSON.stringify(baselinePolicy),
      actual: JSON.stringify(policyBack),
      pass: JSON.stringify(policyBack) === JSON.stringify(baselinePolicy),
    });
    const creditLeftRows = await countRows('SELECT COUNT(*) n FROM customer_credits WHERE customerId IN (?)', [custIds]);
    const suiteLoansLeft = await countRows('SELECT COUNT(*) n FROM loans WHERE id IN (?)', [created]);
    const custLoansNow = await countRows('SELECT COUNT(*) n FROM loans WHERE customerId IN (?)', [custIds]);
    const machineLeft = await machineCount();
    check(CAT, 'ไม่มี credit หรือ loan ของ suite ค้าง, กู้ seeded ของลูกค้าเดิมยังครบเท่าก่อนเริ่ม, บัญชีเครื่องเหลือไว้แถวเดียว (เป็นตัวตนถาวรของ job)', {
      input: 'loans ที่ suite สร้าง + ของ C5-C9 เทียบ baseline, customer_credits ของ C5-C9, users system.auto-debit',
      expected: `0 credit rows, 0 suite loans, ${baselineCustLoans} seeded loans, 1 machine row`,
      actual: `${creditLeftRows} credit, ${suiteLoansLeft} suite loans, ${custLoansNow} seeded loans, ${machineLeft} machine`,
      pass: creditLeftRows === 0 && suiteLoansLeft === 0 && custLoansNow === baselineCustLoans && machineLeft === 1,
    });
  } finally {
    await purge().catch(() => {});
  }
}
