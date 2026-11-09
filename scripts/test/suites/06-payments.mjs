// 3.6 Payments: payment request lifecycle (create -> checker verify -> post), the locked
// sequential allocation order, staff override rules, rejection/resubmission, and customer credit.
//
// Like suite 05, every loan/request this suite touches is created by the suite and deleted in
// `purge`, because suites 10/15 compare the seeded ledger against expected.json. The 21 seeded
// loans are only used for read-only refusal paths (non-ACTIVE loans, existing credit balances).
import { api as http, errorMessage, expected, payloadOf, rows, settle, statusCheck, check, withPinnedPolicies } from '../lib/harness.mjs';
import {
  allocateComponents,
  billedInterestCents,
  fmt,
  postEvent,
  toCents,
  toLak,
  totalOf,
} from '../oracle.mjs';

const CAT = 'payments';

const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];

/** loan.outstanding (camelCase, LAK) -> components in cents */
const outstandingOf = (loan) => ({
  PENALTY: cent(loan.outstanding?.penalty ?? 0),
  PAST_INTEREST: cent(loan.outstanding?.pastInterest ?? 0),
  PAST_PRINCIPAL: cent(loan.outstanding?.pastPrincipal ?? 0),
});
const sumMoney = (c) => COMPS.reduce((acc, k) => acc + Number(c[k] ?? 0), 0);
const asText = (c) => COMPS.map((k) => `${k}=${fmt(c[k] ?? 0)}`).join(' ');
const jwtId = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;

export default async function suite(ctx) {
  // reset-db keeps system_config, so the payment policy is pinned to the shipped defaults for this
  // suite and put back afterwards: with the job switched on by an earlier run, the live auto-debit
  // timer would move money on the book while these cases are still counting it.
  return withPinnedPolicies(ctx.api, ['payment'], () => run(ctx));
}

async function run(ctx) {
  const { tokens, conn, api: adminApi } = ctx;
  // ctx.api fills in the admin token when none is given; a case that means "unauthenticated"
  // must pass token:null explicitly and bypass that default or it silently tests as admin.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));
  const loansExp = expected.loans;
  const byNum = loansExp;

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);
  const NIL = '00000000-7000-4000-8000-0000000000ff';

  // dedicated customers with no seeded credit row, so credit effects are fully reversible
  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';
  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';
  const custIds = [C5, C6, C7, C8];

  const baseline = {};
  for (const t of [
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
    'settlement_agreements',
  ]) {
    baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  }

  const created = [];
  const purge = async () => {
    if (!created.length) return;
    const inTx = `SELECT id FROM financial_transactions WHERE loanId IN (?)`;
    await conn.query(
      `DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`,
      [created],
    );
    await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [created]);
    await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [created, custIds]);
    await conn.query(
      'DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))',
      [created],
    );
    await conn.query(
      'DELETE FROM financial_transaction_lines WHERE transactionId IN (SELECT id FROM financial_transactions WHERE loanId IN (?))',
      [created],
    );
    await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [created]);
    await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [created]);
    await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [created]);
    await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [created]);
    await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [custIds]);
    await conn.query('DELETE FROM loans WHERE id IN (?)', [created]);
  };

  /** Independent oracle state per suite-created loan (cents). */
  const states = new Map();

  const newLoan = async ({ customerId, productCode, principal, disbursedAt, label }) => {
    const p = product(productCode);
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: {
        customerId,
        productId: p.id,
        principalAmount: principal,
        termValue: p.termValue,
        termUnit: p.termUnit,
        disbursedAt,
      },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    created.push(loan.id);
    const interestCents = billedInterestCents({
      principalCents: toCents(principal),
      ratePercent: p.interestRate,
      rateUnit: p.interestRatePeriod,
      termValue: p.termValue,
      termUnit: p.termUnit,
    });
    states.set(loan.id, {
      id: loan.id,
      customerId,
      principalCents: toCents(principal),
      components: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: toCents(principal) },
      status: 'ACTIVE',
      history: [],
    });
    check(CAT, `${label}: สร้าง loan และบันทึกเงินออกกู้ตรงกับ oracle (เงินต้น + ดอกเบี้ย flat)` , {
      input: `${productCode} principal ${fmt(toCents(principal))} @${p.interestRate}%/${p.interestRatePeriod} ${p.termValue}${p.termUnit}`,
      expected: `interest ${fmt(interestCents)}, outstanding ${fmt(interestCents + toCents(principal))}`,
      actual: `interest ${loan.outstanding.pastInterest}, outstanding ${loan.outstanding.total}`,
      pass: sameMoney(loan.outstanding.pastInterest, toLak(interestCents)) && sameMoney(loan.outstanding.total, toLak(interestCents + toCents(principal))),
    });
    return { id: loan.id, loanNumber: loan.loanNumber, productId: p.id, principal };
  };

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;

  const createReq = (body, token = tokens.op1) => api('POST', '/api/payment-requests', { token, body });
  const approveReq = (id, body = {}, token = tokens.checker1) =>
    api('POST', `/api/payment-requests/${id}/approve`, { token, body });
  const rejectReq = (id, body, token = tokens.checker1) => api('POST', `/api/payment-requests/${id}/reject`, { token, body });
  const resubmitReq = (id, token = tokens.op1) => api('POST', `/api/payment-requests/${id}/resubmit`, { token });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });
  const detail = (id, token = tokens.admin) => api('GET', `/api/payment-requests/${id}`, { token });

  // The email rows a money event queued in its own transaction. Reading them here (not after the
  // dispatcher) is what proves "posted and announced commit together"; transport=log means the mail
  // never leaves the machine. `enqueueNotification` seals every payload, so the fields are opened in
  // JS: JSON_EXTRACT on `sealed:v1:` text is not valid JSON and returns NULL for all of them.
  const OUTBOX_PAYLOAD_KEYS = [
    'requestNo',
    'loanCode',
    'amount',
    'purposeLabel',
    'reason',
    'remaining',
    'allocation',
    'components',
    'creditBalance',
    'instalment',
  ];
  const withPayload = (row) => {
    const payload = payloadOf(row);
    return {
      ...row,
      ...Object.fromEntries(OUTBOX_PAYLOAD_KEYS.map((key) => [key, payload[key] ?? null])),
      payloadStatus: payload.status ?? null,
    };
  };
  const outboxRows = (loanId, type) =>
    rows(
      conn,
      'SELECT recipientEmail, status, payload FROM notification_outbox WHERE loanId = ? AND type = ? ORDER BY createdAt',
      [loanId, type],
    ).then((rs) => rs.map(withPayload));

  /** formatAmount() renders "12,345.67 LAK"; compared as bare digits so the suite stays locale-free. */
  const moneyOf = (value) => String(value ?? '').replace(/[^\d.]/g, '');

  /** collectionAudience() server-side = ผู้กู้ + staff ที่ role ยังมีอำนาจและ active และมีอีเมลจริง */
  const approverEmails = (
    await rows(
      conn,
      "SELECT email FROM users WHERE role IN ('CHECKER','HEAD_APPROVER','ADMIN') AND isActive = 1 AND email IS NOT NULL AND email <> '' ORDER BY email",
      [],
    )
  ).map((r) => r.email);
  const borrowerEmail = async (loanId) =>
    (await rows(conn, 'SELECT c.email FROM customers c JOIN loans l ON l.customerId = c.id WHERE l.id = ?', [loanId]))[0]?.email ?? null;
  const reachesAudience = (mail, audience) => audience.every((email) => mail.some((r) => String(r.recipientEmail).toLowerCase() === String(email).toLowerCase()));

  const findStep = async (txId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=100', { token });
    const item = (pending.json.data ?? []).find((i) => i.subjectId === txId);
    return item ?? null;
  };

  /** maker -> checker -> post, verifying every ledger/balance/audit effect against the oracle. */
  const payAndVerify = async (loan, { cash = 0, credit = 0, label, poster = tokens.admin, checker = tokens.checker1 }) => {
    const state = states.get(loan.id);
    const made = await createReq(
      { loanId: loan.id, cashAmount: cash, ...(credit ? { creditToApply: credit } : {}) },
      tokens.op1,
    );
    if (made.status !== 201) throw new Error(`${label}: create failed ${made.status} ${errorMessage(made)}`);
    const request = made.json.data.request;
    const approved = await approveReq(request.id, {}, checker);
    if (approved.status !== 200) throw new Error(`${label}: approve failed ${approved.status} ${errorMessage(approved)}`);
    const tx = approved.json.data.transaction;
    const posted = await postTx(tx.id, poster);
    if (posted.status !== 200) throw new Error(`${label}: post failed ${posted.status} ${errorMessage(posted)}`);

    const exp = postEvent(state, { type: 'PAYMENT', amountCents: toCents(cash), creditAppliedCents: toCents(credit) });
    const data = posted.json.data;
    const after = await loanView(loan.id);

    check(CAT, `${label}: การกระจายเงิน ณ ตอนโพสต์ เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL ตาม oracle`, {
      input: `cash ${fmt(toCents(cash))} + credit ${fmt(toCents(credit))}`,
      expected: COMPS.map((c) => `${c}=${fmt(exp.allocation[c])}`).join(' '),
      actual: COMPS.map((c) => `${c}=${fmt(toCents(data.allocation?.[c] ?? 0))}`).join(' '),
      pass: COMPS.every((c) => cent(data.allocation?.[c] ?? 0) === exp.allocation[c]),
    });
    const got = outstandingOf(after ?? {});
    check(CAT, `${label}: ยอดคงค้างรายส่วนหลังโพสต์ ตรง oracle ทุกทศนิยม`, {
      input: 'GET /api/loans/:id outstanding',
      expected: COMPS.map((c) => `${c}=${fmt(state.components[c])}`).join(' ') + ` total ${fmt(totalOf(state.components))}`,
      actual: COMPS.map((c) => `${c}=${fmt(got[c])}`).join(' ') + ` total ${fmt(sumMoney(got))}`,
      pass: COMPS.every((c) => got[c] === state.components[c]) && sameMoney(after?.outstanding?.total, toLak(totalOf(state.components))),
    });
    check(CAT, `${label}: สถานะ loan หลังโพสต์ = ${exp.statusAfter} (ปิดเมื่อยอดค้างทุกส่วนเป็น 0)`, {
      input: 'loan.status',
      expected: exp.statusAfter,
      actual: `${data.newStatus} / db ${after?.status}`,
      pass: data.newStatus === exp.statusAfter && after?.status === exp.statusAfter,
    });
    check(CAT, `${label}: ยอดที่เกิน (excess) ต้องกลายเป็น credit ตาม oracle`, {
      input: 'post result excess',
      expected: fmt(exp.creditAccruedCents),
      actual: fmt(toCents(data.excess ?? 0)),
      pass: cent(data.excess ?? 0) === exp.creditAccruedCents,
    });
    const lineRows = await rows(conn, 'SELECT component, amount FROM financial_transaction_lines WHERE transactionId = ?', [tx.id]);
    const nonzero = COMPS.filter((c) => exp.allocation[c] !== 0);
    check(CAT, `${label}: ledger lines เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0`, {
      input: 'financial_transaction_lines',
      expected: nonzero.map((c) => `${c}=-${fmt(exp.allocation[c])}`).join(' '),
      actual: lineRows.map((r) => `${r.component}=${String(r.amount)}`).join(' '),
      pass: lineRows.length === nonzero.length && nonzero.every((c) => cent(lineRows.find((r) => r.component === c)?.amount ?? 0) === -exp.allocation[c]),
    });
    return { made, approved, posted, request, tx, exp, after };
  };

  /**
   * Deposit to credit — the channel the collection gate points at when cash is above what has
   * arrived. It runs the same maker -> checker -> post path as a payment, but buys no debt: every
   * allocation stays zero and the whole amount lands as customer credit.
   */
  const depositAndVerify = async (loan, { cash, label }) => {
    const state = states.get(loan.id);
    const made = await createReq({ loanId: loan.id, cashAmount: cash, purpose: 'DEPOSIT_TO_CREDIT' }, tokens.op1);
    if (made.status !== 201) throw new Error(`${label}: deposit create failed ${made.status} ${errorMessage(made)}`);
    const request = made.json.data.request;
    check(CAT, `${label}: สร้างคำขอ purpose DEPOSIT_TO_CREDIT — proposed allocation เป็น 0 ทุกส่วน (ไม่ตัดหนี้ใด ๆ)`, {
      input: 'POST /api/payment-requests purpose=DEPOSIT_TO_CREDIT',
      expected: `purpose DEPOSIT_TO_CREDIT ${COMPS.map((c) => `${c}=0.00`).join(' ')}`,
      actual: `${request.purpose} ${COMPS.map((c) => `${c}=${fmt(cent(made.json.data.proposed?.[c] ?? -1))}`).join(' ')}`,
      pass: request.purpose === 'DEPOSIT_TO_CREDIT' && COMPS.every((c) => cent(made.json.data.proposed?.[c] ?? -1) === 0),
    });
    const approved = await approveReq(request.id, {}, tokens.checker1);
    if (approved.status !== 200) throw new Error(`${label}: deposit approve failed ${approved.status} ${errorMessage(approved)}`);
    const tx = approved.json.data.transaction;
    check(CAT, `${label}: อนุมัติ deposit -> transaction PAYMENT สถานะ APPROVED ยอด = เงินที่ฝาก`, {
      input: 'POST /api/payment-requests/:id/approve',
      expected: { type: 'PAYMENT', status: 'APPROVED', amount: fmt(toCents(cash)) },
      actual: { type: tx.transactionType, status: tx.status, amount: fmt(toCents(tx.amount)) },
      pass: tx.transactionType === 'PAYMENT' && tx.status === 'APPROVED' && sameMoney(tx.amount, cash),
    });
    const posted = await postTx(tx.id, tokens.admin);
    if (posted.status !== 200) throw new Error(`${label}: deposit post failed ${posted.status} ${errorMessage(posted)}`);
    const data = posted.json.data;
    const after = await loanView(loan.id);
    check(CAT, `${label}: โพสต์ deposit -> allocation 0 ทุกส่วน, excess = ยอดทั้งก้อน, หนี้คงค้างไม่ขยับ`, {
      input: `POST /api/transactions/${tx.id}/post`,
      expected: `${COMPS.map((c) => `${c}=0.00`).join(' ')} excess ${fmt(toCents(cash))} outstanding ${asText(state.components)}`,
      actual: `${COMPS.map((c) => `${c}=${fmt(cent(data.allocation?.[c] ?? -1))}`).join(' ')} excess ${fmt(cent(data.excess ?? -1))} outstanding ${asText(outstandingOf(after ?? {}))}`,
      pass:
        COMPS.every((c) => cent(data.allocation?.[c] ?? -1) === 0) &&
        cent(data.excess ?? -1) === toCents(cash) &&
        COMPS.every((c) => outstandingOf(after ?? {})[c] === state.components[c]) &&
        after?.status === 'ACTIVE',
    });
    const depositMail = (await outboxRows(loan.id, 'CREDIT_DEPOSITED')).filter((r) => moneyOf(r.amount) === moneyOf(cash));
    const depositor = await borrowerEmail(loan.id);
    check(CAT, `${label}: โพสต์ deposit แล้วเกิดเมล CREDIT_DEPOSITED บอกยอดที่เข้าบัญชีเครดิต`, {
      input: `notification_outbox type=CREDIT_DEPOSITED ยอด ${cash} ของ loan นี้`,
      expected: '>= 1 แถวถึงเฉพาะผู้กู้, amount ตรงยอดฝาก, creditBalance + loanCode ไม่ว่าง',
      actual: JSON.stringify(depositMail.map((r) => [r.recipientEmail, r.amount, r.creditBalance, r.loanCode])),
      pass:
        depositMail.length >= 1 &&
        depositMail.every((r) => r.recipientEmail === depositor) &&
        !!depositMail[0].creditBalance &&
        !!depositMail[0].loanCode &&
        moneyOf(depositMail[0].amount) === moneyOf(cash),
      note: 'เงินที่ฝากยังไม่ตัดหนี้ จึงเป็นเมลแจ้งเติมเครดิต ไม่ใช่ใบเสร็จชำระหนี้ และไม่มีสำเนาถึงผู้มีอำนาจ',
    });
    return { made, approved, posted, request, tx };
  };

  try {
    // ============================================ A. roles on every payment endpoint
    const seedClosed = byNum['LN-TST-000002'].loanId;
    const seedWrittenOff = byNum['LN-TST-000018'].loanId;
    const probe = await newLoan({
      customerId: C8,
      productCode: 'TST-FLAT-M6',
      principal: 500000,
      disbursedAt: '2026-02-05T09:00:00.000Z',
      label: 'probe',
    });

    const roleTable = [
      ['anon', null, 401],
      ['viewer', tokens.viewer, 403],
      ['maker', tokens.op1, 201],
      ['checker', tokens.checker1, 201],
      ['head', tokens.head, 201],
      ['admin', tokens.admin, 201],
    ];
    for (const [name, token, want] of roleTable) {
      const res = await createReq({ loanId: probe.id, cashAmount: 1000 }, token);
      statusCheck(CAT, `POST /api/payment-requests ด้วย role ${name}: ${want}`, res, want, {
        input: `token=${name}`,
        note: want === 401 ? 'ต้อง 401 ไม่ใช่ 403' : undefined,
      });
    }
    const pendingForRole = await createReq({ loanId: probe.id, cashAmount: 5000 }, tokens.op1);
    const pid = pendingForRole.json.data.request.id;
    for (const [name, token, want] of [
      ['anon', null, 401],
      ['viewer', tokens.viewer, 403],
      ['maker (creator)', tokens.op1, 403],
      ['other maker', tokens.op2, 403],
      ['checker', tokens.checker1, 200],
      ['head', tokens.head, 422],
    ]) {
      const res = await approveReq(pid, {}, token);
      statusCheck(CAT, `POST /:id/approve ด้วย role ${name}: ${want}`, res, want, {
        input: `request status PENDING`,
        note: name === 'head' ? 'อันนี้ถูก checker approve ไปแล้ว -> ครั้งถัดไปต้อง 422 already APPROVED' : undefined,
      });
      if (name === 'checker') break;
    }
    const toReject = await createReq({ loanId: probe.id, cashAmount: 7000 }, tokens.op1);
    const rid = toReject.json.data.request.id;
    for (const [name, token, want] of [
      ['viewer', tokens.viewer, 403],
      ['maker', tokens.op1, 403],
      ['checker', tokens.checker1, 200],
    ]) {
      const res = await rejectReq(rid, { reason: 'Role probe' }, token);
      statusCheck(CAT, `POST /:id/reject ด้วย role ${name}: ${want}`, res, want, { input: 'reason given' });
      if (name === 'checker') break;
    }
    for (const [name, token, want] of [
      ['anon', null, 401],
      ['viewer', tokens.viewer, 403],
      ['maker', tokens.op1, 201],
    ]) {
      const res = await resubmitReq(rid, token);
      statusCheck(CAT, `POST /:id/resubmit ด้วย role ${name}: ${want}`, res, want, { input: 'of a REJECTED request' });
      if (name === 'maker') {
        // leave the resubmitted copy pending, the reject above is now consumed
        break;
      }
    }
    const approvedTxId = (await detail(pid)).json.data.transaction.id;
    let rolePosted = null;
    for (const [name, token, want] of [
      ['anon', null, 401],
      ['viewer', tokens.viewer, 403],
      ['maker', tokens.op1, 200],
    ]) {
      const res = await postTx(approvedTxId, token);
      statusCheck(CAT, `POST /api/transactions/:id/post ด้วย role ${name}: ${want}`, res, want, {
        input: 'APPROVED payment transaction',
        note: name === 'maker' ? 'MAKER โพสต์ได้ (OPERATOR_ROLES) — ตรวจว่าขัดหลักการ maker-checker หรือไม่' : undefined,
      });
      if (name === 'maker') {
        rolePosted = res;
        break;
      }
    }
    // the role probe really posted 5,000 on the probe loan -> keep the oracle state in step,
    // otherwise every later "outstanding unchanged" check compares against a stale balance
    if (rolePosted?.status === 200) {
      const expProbe = postEvent(states.get(probe.id), { type: 'PAYMENT', amountCents: toCents(5000) });
      const probeNow = await loanView(probe.id);
      check(CAT, 'โพสต์จาก role probe (maker): ledger + ยอดคงค้างตรงกับ oracle 5,000 ทั้งหมดลงดอกเบี้ย', {
        input: 'POST /api/transactions/:id/post as test_op1',
        expected: COMPS.map((c) => `${c}=${fmt(states.get(probe.id).components[c])}`).join(' '),
        actual: COMPS.map((c) => fmt(outstandingOf(probeNow)[c])).join(' '),
        pass:
          COMPS.every((c) => outstandingOf(probeNow)[c] === states.get(probe.id).components[c]) &&
          COMPS.every((c) => cent(rolePosted.json.data.allocation[c]) === expProbe.allocation[c]),
      });
    }
    for (const [name, token] of [
      ['viewer', tokens.viewer],
      ['maker', tokens.op1],
      ['admin', tokens.admin],
    ]) {
      const res = await api('GET', '/api/payment-requests?limit=5', { token });
      statusCheck(CAT, `GET /api/payment-requests ด้วย role ${name}: 200 (read allowed)`, res, 200, { input: 'list' });
    }

    // ============================================ B. create: validation + gates
    statusCheck(CAT, 'loanId ไม่ใช่ uuid: 400', await createReq({ loanId: 'not-a-uuid', cashAmount: 1000 }), 400, {
      input: 'loanId=not-a-uuid',
      messageIncludes: 'Validation failed',
    });
    statusCheck(CAT, 'loan ที่ไม่มีอยู่: 404', await createReq({ loanId: NIL, cashAmount: 1000 }), 404, {
      input: NIL,
      note: 'notFound("Loan") -> ข้อความไม่ใช่ "Loan not found" (F-LN-1 เดิม)',
    });
    const loan404 = await createReq({ loanId: NIL, cashAmount: 1000 });
    check(CAT, 'ข้อความ error ของ 404 payment request ต้องอ่านรู้เรื่อง', {
      input: 'POST /api/payment-requests with unknown loan',
      expected: 'message contains "not found"',
      actual: `message = "${errorMessage(loan404)}"`,
      pass: /not found/i.test(errorMessage(loan404)),
    });
    statusCheck(CAT, 'cashAmount ติดลบ: 400', await createReq({ loanId: probe.id, cashAmount: -1 }), 400, {
      input: 'cashAmount=-1',
      messageIncludes: 'Validation failed',
    });
    statusCheck(CAT, 'cashAmount=0 และไม่ใช้ credit: 400 ยอดชำระต้อง > 0', await createReq({ loanId: probe.id, cashAmount: 0 }), 400, {
      input: 'cashAmount=0',
      messageIncludes: 'Payment amount must be greater than zero',
    });
    statusCheck(CAT, 'cashAmount=0 + creditToApply>0 แต่ credit ไม่มี: 422 (insufficient credit)', await createReq({ loanId: probe.id, cashAmount: 0, creditToApply: 1000 }), 422, {
      input: 'cash 0, credit 1000, customer has no credit',
      messageIncludes: 'Insufficient customer credit',
    });
    statusCheck(CAT, 'creditToApply ติดลบ: 400', await createReq({ loanId: probe.id, cashAmount: 1000, creditToApply: -5 }), 400, {
      input: 'creditToApply=-5',
    });
    statusCheck(CAT, 'note ยาว 1001 ตัวอักษร: 400', await createReq({ loanId: probe.id, cashAmount: 1000, note: 'x'.repeat(1001) }), 400, {
      input: 'note length 1001',
    });
    statusCheck(CAT, 'ชำระเงินของ loan ที่ CLOSED แล้ว: 422', await createReq({ loanId: seedClosed, cashAmount: 1000 }), 422, {
      input: 'CLOSED seed loan',
      messageIncludes: 'payments require an ACTIVE loan',
    });
    statusCheck(CAT, 'ชำระเงินของ loan ที่ WRITE_OFF แล้ว: 422', await createReq({ loanId: seedWrittenOff, cashAmount: 1000 }), 422, {
      input: 'WRITTEN_OFF seed loan',
      messageIncludes: 'Loan is WRITTEN_OFF',
    });
    statusCheck(CAT, 'settlementAgreementId ไม่ใช่ uuid: 400', await createReq({ loanId: probe.id, cashAmount: 1000, settlementAgreementId: 'x' }), 400, {
      input: 'settlementAgreementId=x',
    });
    statusCheck(CAT, 'settlementAgreementId ที่ไม่มีอยู่: 404', await createReq({ loanId: probe.id, cashAmount: 1000, settlementAgreementId: NIL }), 404, {
      input: 'unknown agreement id',
      messageIncludes: 'Settlement agreement',
      note: 'validateSettlementPayment เรียก notFound("Settlement agreement") ก่อนการตรวจ credit',
    });

    const createdOk = await createReq({ loanId: probe.id, cashAmount: 12345.67, note: 'rounding probe' }, tokens.op1);
    statusCheck(CAT, 'สร้าง payment request ด้วยยอดทศนิยม: 201', createdOk, 201, { input: 'cashAmount 12345.67' });
    const reqA = createdOk.json.data.request;
    check(CAT, 'requestNo ตั้งตามรูปแบบ PR-6 หลัก และไม่ชนกับเลขของข้อมูล seed', {
      input: reqA.requestNo,
      expected: 'PR-\\d{6} and unused before',
      actual: reqA.requestNo,
      pass: /^PR-\d{6}$/.test(reqA.requestNo),
    });
    check(CAT, 'status ตอนสร้างต้องเป็น PENDING และบันทึก cash/credit ตามที่ส่ง', {
      input: 'POST response request',
      expected: { status: 'PENDING', cashAmount: '12345.67', creditApplied: '0.00' },
      actual: { status: reqA.status, cashAmount: reqA.cashAmount, creditApplied: reqA.creditApplied },
      pass: reqA.status === 'PENDING' && sameMoney(reqA.cashAmount, 12345.67) && sameMoney(reqA.creditApplied, 0),
    });
    check(CAT, 'createdBy ของ request = user ที่ login (ไม่ใช่ user อื่น)', {
      input: 'request.createdBy vs JWT id of test_op1',
      expected: jwtId(tokens.op1),
      actual: reqA.createdBy,
      pass: reqA.createdBy === jwtId(tokens.op1),
    });
    const dbReq = (await rows(conn, 'SELECT * FROM payment_requests WHERE id = ?', [reqA.id]))[0];
    const allocRows = await rows(conn, 'SELECT component, proposedAmount, finalAmount FROM payment_allocations WHERE paymentRequestId = ? ORDER BY component', [reqA.id]);
    check(CAT, 'ใน DB: มี payment_allocations ครบ 3 รายส่วน และ finalAmount = 0 ก่อน approve', {
      input: 'payment_allocations of the new request',
      expected: '3 rows, all finalAmount 0',
      actual: `${allocRows.length} rows ${JSON.stringify(allocRows.map((r) => [r.component, String(r.proposedAmount), String(r.finalAmount)]))}`,
      pass: allocRows.length === 3 && allocRows.every((r) => sameMoney(r.finalAmount, 0)) && COMPS.every((c) => allocRows.some((r) => r.component === c)),
    });
    const stProbe = states.get(probe.id);
    const expProp = allocateComponents(toCents(12345.67), stProbe.components);
    check(CAT, 'proposed allocation ที่ระบบ snapshot = oracle (ดอกเบี้ยก่อนเงินต้น เพราะค่าปรับยังไม่มีการเรียกเก็บ)', {
      input: 'oracle.allocateComponents(12345.67, outstanding)',
      expected: COMPS.map((c) => `${c}=${fmt(expProp.allocation[c])}`).join(' '),
      actual: COMPS.map((c) => `${c}=${fmt(toCents(allocRows.find((r) => r.component === c)?.proposedAmount ?? 0))}`).join(' '),
      pass: COMPS.every((c) => cent(allocRows.find((r) => r.component === c)?.proposedAmount ?? 0) === expProp.allocation[c]),
    });
    check(CAT, 'response ตอนสร้างคืน proposed + allocations ครบ', {
      input: 'POST /api/payment-requests body',
      expected: 'proposed object with 3 components + 3 allocation rows',
      actual: `${JSON.stringify(createdOk.json.data.proposed)} / ${createdOk.json.data.allocations?.length} rows`,
      pass: COMPS.every((c) => createdOk.json.data.proposed?.[c] !== undefined) && createdOk.json.data.allocations?.length === 3,
    });
    const noTxYet = await rows(conn, 'SELECT COUNT(*) n FROM financial_transactions WHERE sourceRequestId = ?', [reqA.id]);
    check(CAT, 'ยังไม่มี financial_transaction ก่อนที่ checker จะอนุมัติ (LOCKED: POSTED เท่านั้นที่เป็นหนี้จริง)', {
      input: 'financial_transactions by sourceRequestId',
      expected: 0,
      actual: noTxYet[0].n,
      pass: noTxYet[0].n === 0,
    });
    const probeAfterCreate = await loanView(probe.id);
    check(CAT, 'ตอนสร้าง request ยอดคงค้าง loan ต้องยังไม่ขยับ', {
      input: 'loan outstanding after create only',
      expected: COMPS.map((c) => fmt(stProbe.components[c])).join(' '),
      actual: COMPS.map((c) => fmt(outstandingOf(probeAfterCreate)[c])).join(' '),
      pass: COMPS.every((c) => outstandingOf(probeAfterCreate)[c] === stProbe.components[c]),
    });
    const auditCreated = await rows(
      conn,
      "SELECT action, amount, userId, sourceRequestId FROM audit_logs WHERE action='PAYMENT_REQUEST_CREATED' AND sourceRequestId = ?",
      [reqA.id],
    );
    check(CAT, 'audit PAYMENT_REQUEST_CREATED ถูกเขียนพร้อมยอดรวม cash+credit และ user', {
      input: 'audit_logs for the new request',
      expected: `1 row amount 12345.67 user ${jwtId(tokens.op1)}`,
      actual: `${auditCreated.length} row ${JSON.stringify(auditCreated.map((r) => [r.action, String(r.amount), r.userId]))}`,
      pass: auditCreated.length === 1 && sameMoney(auditCreated[0].amount, 12345.67) && auditCreated[0].userId === jwtId(tokens.op1),
    });

    // ============================================ C. approve: separation, immutability, effects
    statusCheck(CAT, 'approve id ที่ไม่มีอยู่: 404', await approveReq(NIL, {}, tokens.checker1), 404, {
      input: NIL,
      messageIncludes: 'Payment request',
    });
    const selfMade = await createReq({ loanId: probe.id, cashAmount: 9000 }, tokens.checker2);
    statusCheck(CAT, 'ผู้สร้างอนุมัติเอง (checker2 สร้าง/อนุมัติ): 422 maker-checker separation', await approveReq(selfMade.json.data.request.id, {}, tokens.checker2), 422, {
      input: 'same user as creator',
      messageIncludes: 'maker-checker separation',
    });
    const appr = await approveReq(reqA.id, { reason: 'Cash received at counter' }, tokens.checker1);
    statusCheck(CAT, 'approve ด้วย checker อื่น: 200', appr, 200, { input: 'reason given' });
    const apprTx = appr.json.data.transaction;
    check(CAT, 'approve สร้าง transaction สถานะ APPROVED (ยังไม่ใช่ POSTED) ยอด = เงินสด+credit', {
      input: 'approve response transaction',
      expected: { status: 'APPROVED', amount: '12345.67', type: 'PAYMENT' },
      actual: { status: apprTx.status, amount: apprTx.amount, type: apprTx.transactionType },
      pass: apprTx.status === 'APPROVED' && sameMoney(apprTx.amount, 12345.67) && apprTx.transactionType === 'PAYMENT',
    });
    check(CAT, 'approve คืน allocation เท่ากับ snapshot ที่ระบบเสนอ (ไม่มี override)', {
      input: 'approve response allocation vs proposed',
      expected: COMPS.map((c) => fmt(expProp.allocation[c])).join(' '),
      actual: COMPS.map((c) => fmt(toCents(appr.json.data.allocation[c]))).join(' '),
      pass: COMPS.every((c) => cent(appr.json.data.allocation[c]) === expProp.allocation[c]),
    });
    const finalRows = await rows(conn, 'SELECT component, finalAmount FROM payment_allocations WHERE paymentRequestId = ?', [reqA.id]);
    check(CAT, 'finalAmount ของ payment_allocations ถูกเขียนตอน approve ตรงกับ proposed', {
      input: 'payment_allocations after approve',
      expected: COMPS.map((c) => `${c}=${fmt(expProp.allocation[c])}`).join(' '),
      actual: COMPS.map((c) => `${c}=${fmt(toCents(finalRows.find((r) => r.component === c)?.finalAmount ?? 0))}`).join(' '),
      pass: COMPS.every((c) => cent(finalRows.find((r) => r.component === c)?.finalAmount ?? 0) === expProp.allocation[c]),
    });
    const reqAfterApprove = (await detail(reqA.id)).json.data.request;
    check(CAT, 'request เปลี่ยนเป็น APPROVED พร้อม approvedBy/approvedAt', {
      input: 'GET /api/payment-requests/:id',
      expected: { status: 'APPROVED', approvedBy: jwtId(tokens.checker1) },
      actual: { status: reqAfterApprove.status, approvedBy: reqAfterApprove.approvedBy, approvedAt: !!reqAfterApprove.approvedAt },
      pass: reqAfterApprove.status === 'APPROVED' && reqAfterApprove.approvedBy === jwtId(tokens.checker1) && !!reqAfterApprove.approvedAt,
    });
    statusCheck(CAT, 'approve ซ้ำ: 422 (สถานะเปลี่ยนแล้วห้ามอนุมัติซ้ำ)', await approveReq(reqA.id, {}, tokens.head), 422, {
      input: 'second approve',
      messageIncludes: 'Request is already APPROVED',
    });
    statusCheck(CAT, 'reject หลัง approve: 422', await rejectReq(reqA.id, { reason: 'too late' }, tokens.head), 422, {
      input: 'reject an APPROVED request',
      messageIncludes: 'Request is already APPROVED',
    });
    const wfForPayment = await rows(conn, 'SELECT COUNT(*) n FROM approval_workflows WHERE subjectId = ?', [apprTx.id]);
    check(CAT, 'payment request ใช้ single-checker verify (ไม่มี approval_workflow ของ transaction นี้)', {
      input: 'approval_workflows by transaction id',
      expected: 0,
      actual: wfForPayment[0].n,
      pass: wfForPayment[0].n === 0,
    });
    const auditApproved = await rows(
      conn,
      "SELECT makerUserId, checkerUserId, amount, previousStatus, newStatus FROM audit_logs WHERE action='PAYMENT_REQUEST_APPROVED' AND sourceRequestId = ?",
      [reqA.id],
    );
    check(CAT, 'audit PAYMENT_REQUEST_APPROVEDบันทึก maker + checker คนละคน', {
      input: 'audit_logs row of the approve',
      expected: `maker ${jwtId(tokens.op1)} checker ${jwtId(tokens.checker1)} PENDING->APPROVED`,
      actual: JSON.stringify(auditApproved.map((r) => [r.makerUserId, r.checkerUserId, String(r.amount), r.previousStatus, r.newStatus])),
      pass:
        auditApproved.length === 1 &&
        auditApproved[0].makerUserId === jwtId(tokens.op1) &&
        auditApproved[0].checkerUserId === jwtId(tokens.checker1) &&
        auditApproved[0].previousStatus === 'PENDING' &&
        auditApproved[0].newStatus === 'APPROVED' &&
        sameMoney(auditApproved[0].amount, 12345.67),
    });
    const balAfterApprove = await loanView(probe.id);
    check(CAT, 'หลัง approve แต่ยังไม่ post: ยอดคงค้าง loan ไม่เปลี่ยน (transaction ยังไม่ POSTED)', {
      input: 'loan outstanding between approve and post',
      expected: COMPS.map((c) => fmt(stProbe.components[c])).join(' '),
      actual: COMPS.map((c) => fmt(outstandingOf(balAfterApprove)[c])).join(' '),
      pass: COMPS.every((c) => outstandingOf(balAfterApprove)[c] === stProbe.components[c]),
    });

    // override allocation rules (LOCKED section 7: hard validation, no bypass)
    const ovr = async (override) => {
      const made = await createReq({ loanId: probe.id, cashAmount: 30000 }, tokens.op1);
      return approveReq(made.json.data.request.id, { overrideAllocation: override }, tokens.checker1);
    };
    statusCheck(CAT, 'override รวมทุกส่วนเกินยอดชำระ: 422', await ovr({ PENALTY: 0, PAST_INTEREST: 5000, PAST_PRINCIPAL: 26000 }), 422, {
      input: 'sum 31000 > payment 30000',
      messageIncludes: 'exceeds payment amount',
    });
    statusCheck(CAT, 'override ส่วนเงินต้นเกินยอดคงค้าง: 422', await ovr({ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 999999 }), 422, {
      input: 'principal allocation above outstanding',
      messageIncludes: 'exceeds outstanding',
    });
    statusCheck(CAT, 'override ติดลบ: 400 (zod min 0 กันไว้ก่อนชั้น business)', await ovr({ PENALTY: -1, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }), 400, {
      input: 'PENALTY=-1',
      note: 'validateAllocationOverride มีสาขา negative แต่ API ไปไม่ถึง (zod ตัดก่อน) — ไม่ใช่บั๊กแต่บันทึกไว้',
    });
    statusCheck(CAT, 'override ไม่ครบทุกส่วน (ขาด PAST_PRINCIPAL): 400', await ovr({ PENALTY: 0, PAST_INTEREST: 1 }), 400, {
      input: 'partial override object',
    });
    const ovrOk = await ovr({ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 30000 });
    statusCheck(CAT, 'override ที่อยู่ในกรอบ (จ่ายเงินต้นก่อนดอกเบี้ย): 200 — สัมภาษณ์พนักงานเลือกได้', ovrOk, 200, {
      input: 'PAST_PRINCIPAL 30000 of a 54,000+500,000 outstanding',
    });
    check(CAT, 'override ที่ได้รับอนุญาตถูกบันทึกเป็น finalAmount และ componentAmounts ของ transaction', {
      input: 'approved transaction componentAmounts',
      expected: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 30000 },
      actual: ovrOk.json.data.transaction.componentAmounts,
      pass: COMPS.every((c) => sameMoney(ovrOk.json.data.transaction.componentAmounts?.[c] ?? 0, { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 30000 }[c])),
    });
    // abandon the override request without posting (must not affect balances), keep it for cleanup check
    const ovrTxId = ovrOk.json.data.transaction.id;

    // ============================================ D. reject + resubmit chain
    statusCheck(CAT, 'reject โดยไม่มีเหตุผล: 400', await rejectReq(selfMade.json.data.request.id, {}, tokens.checker1), 400, {
      input: 'reason missing',
      messageIncludes: 'Validation failed',
      note: 'zod rejectSchema.reason.min(1) ตัดก่อน จึงไปไม่ถึงข้อความ "Rejection reason is required" ของชั้น business — พฤติกรรมถูกต้อง ข้อความมาจากคนละชั้น',
    });
    statusCheck(CAT, 'reject ด้วยเหตุผลว่าง (str): 400', await rejectReq(selfMade.json.data.request.id, { reason: '' }, tokens.checker1), 400, {
      input: 'reason=""',
    });
    const rejected = await rejectReq(selfMade.json.data.request.id, { reason: 'Amount does not match the bank slip' }, tokens.checker1);
    statusCheck(CAT, 'reject โดย checker: 200', rejected, 200, { input: 'valid reason' });
    check(CAT, 'record หลัง reject: สถานะ REJECTED +เหตุผลการปฏิเสธ + ผู้ปฏิเสธ', {
      input: 'reject response',
      expected: { status: 'REJECTED', rejectedBy: jwtId(tokens.checker1) },
      actual: { status: rejected.json.data.status, rejectionReason: rejected.json.data.rejectionReason, rejectedBy: rejected.json.data.rejectedBy },
      pass:
        rejected.json.data.status === 'REJECTED' &&
        rejected.json.data.rejectionReason === 'Amount does not match the bank slip' &&
        rejected.json.data.rejectedBy === jwtId(tokens.checker1),
    });
    const rejTx = await rows(conn, 'SELECT COUNT(*) n FROM financial_transactions WHERE sourceRequestId = ?', [selfMade.json.data.request.id]);
    check(CAT, 'request ที่ถูกปฏิเสธต้องไม่มี transaction ใน ledger เลย', {
      input: 'financial_transactions of a rejected request',
      expected: 0,
      actual: rejTx[0].n,
      pass: rejTx[0].n === 0,
    });
    const auditRejected = await rows(conn, "SELECT action, reason FROM audit_logs WHERE action='PAYMENT_REQUEST_REJECTED' AND sourceRequestId = ?", [
      selfMade.json.data.request.id,
    ]);
    check(CAT, 'audit PAYMENT_REQUEST_REJECTED บันทึกเหตุผลตรงกับที่ส่ง', {
      input: 'audit_logs',
      expected: 1,
      actual: `${auditRejected.length} ${JSON.stringify(auditRejected.map((r) => r.reason))}`,
      pass: auditRejected.length === 1 && auditRejected[0].reason === 'Amount does not match the bank slip',
    });
    const stillPending = await createReq({ loanId: probe.id, cashAmount: 111 }, tokens.op1);
    statusCheck(CAT, 'resubmit request ที่ยังไม่ถูกปฏิเสธ (PENDING): 422', await resubmitReq(stillPending.json.data.request.id), 422, {
      input: 'resubmit a PENDING request',
      messageIncludes: 'Only rejected requests can be resubmitted',
    });
    statusCheck(CAT, 'resubmit id ที่ไม่มีอยู่: 404', await resubmitReq(NIL), 404, { input: NIL, messageIncludes: 'Payment request' });
    const resub = await resubmitReq(selfMade.json.data.request.id, tokens.op2);
    statusCheck(CAT, 'resubmit request ที่ REJECTED: 201 สร้าง request ใหม่', resub, 201, { input: 'by another maker' });
    const resubReq = resub.json.data.request;
    check(CAT, 'request ใหม่-linked ถึงของเดิมผ่าน previousRequestId และกลับเป็น PENDING', {
      input: 'resubmit response',
      expected: { previousRequestId: selfMade.json.data.request.id, status: 'PENDING' },
      actual: { previousRequestId: resubReq.previousRequestId, status: resubReq.status },
      pass: resubReq.previousRequestId === selfMade.json.data.request.id && resubReq.status === 'PENDING',
    });
    const origAfterResub = (await detail(selfMade.json.data.request.id)).json.data.request;
    check(CAT, 'ต้นฉบับที่ถูกรีเจกต์ต้องคงสถานะ REJECTED ตลอด (ห้ามแก้ — LOCKED: ต้นฉบับห้ามแก้)', {
      input: 'GET original rejected request',
      expected: 'REJECTED',
      actual: origAfterResub.status,
      pass: origAfterResub.status === 'REJECTED',
    });
    const auditResub = await rows(conn, "SELECT action, referenceTransactionId FROM audit_logs WHERE action='PAYMENT_REQUEST_RESUBMITTED' AND sourceRequestId = ?", [resubReq.id]);
    check(CAT, 'audit PAYMENT_REQUEST_RESUBMITTEDชี้กลับไปยัง request เดิม', {
      input: 'audit_logs',
      expected: selfMade.json.data.request.id,
      actual: JSON.stringify(auditResub.map((r) => [r.action, r.referenceTransactionId])),
      pass: auditResub.length === 1 && auditResub[0].referenceTransactionId === selfMade.json.data.request.id,
    });
    statusCheck(CAT, 'resubmit ซ้ำ (สถานะ PENDING แล้ว): 422', await resubmitReq(resubReq.id), 422, {
      input: 'resubmit the resubmitted request',
      messageIncludes: 'Only rejected requests can be resubmitted',
    });

    // ============================================ E. posting: allocation order + balance + credit
    const postA = await postTx(apprTx.id, tokens.admin);
    statusCheck(CAT, 'โพสต์ payment ที่ APPROVED: 200', postA, 200, { input: 'transaction of reqA' });
    const expA = postEvent(states.get(probe.id), { type: 'PAYMENT', amountCents: toCents(12345.67) });
    check(CAT, 'allocation ณ ตอนโพสต์ = oracle (ตัดดอกเบี้ยก่อน เพราะค่าปรับยังไม่มี)', {
      input: 'post response allocation',
      expected: COMPS.map((c) => `${c}=${fmt(expA.allocation[c])}`).join(' '),
      actual: COMPS.map((c) => `${c}=${fmt(toCents(postA.json.data.allocation[c]))}`).join(' '),
      pass: COMPS.every((c) => cent(postA.json.data.allocation[c]) === expA.allocation[c]),
    });
    const probeAfterA = await loanView(probe.id);
    check(CAT, 'ยอดคงค้าง loan ลดตามส่วนที่ตัดจริง (12,345.67 ลงดอกเบี้ยทั้งหมด เพราะค่าปรับยังไม่มี)', {
      input: 'loan outstanding after post',
      expected: COMPS.map((c) => `${c}=${fmt(states.get(probe.id).components[c])}`).join(' '),
      actual: COMPS.map((c) => `${c}=${fmt(outstandingOf(probeAfterA)[c])}`).join(' '),
      pass:
        COMPS.every((c) => outstandingOf(probeAfterA)[c] === states.get(probe.id).components[c]) &&
        sameMoney(probeAfterA.outstanding.total, toLak(totalOf(states.get(probe.id).components))),
    });
    const linesA = await rows(conn, 'SELECT component, amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [apprTx.id]);
    check(CAT, 'ledger lines ของ payment เป็นลบตามส่วนที่ตัด และมีเฉพาะส่วนที่ไม่ใช่ 0', {
      input: 'financial_transaction_lines of the posted payment',
      expected: COMPS.filter((c) => expA.allocation[c] !== 0).map((c) => `${c}=-${fmt(expA.allocation[c])}`).join(' '),
      actual: linesA.map((r) => `${r.component}=${String(r.amount)}`).join(' '),
      pass: linesA.length === COMPS.filter((c) => expA.allocation[c] !== 0).length && COMPS.every((c) => cent(linesA.find((r) => r.component === c)?.amount ?? 0) === -expA.allocation[c]),
    });
    statusCheck(CAT, 'โพสต์ซ้ำ transaction เดียวกัน: 422 (ต้อง APPROVED เท่านั้น)', await postTx(apprTx.id, tokens.admin), 422, {
      input: 'second post',
      messageIncludes: 'Only APPROVED transactions can be posted',
    });
    const auditPost = await rows(conn, "SELECT userId, previousStatus, newStatus FROM audit_logs WHERE action='TRANSACTION_POSTED' AND transactionId = ?", [apprTx.id]);
    check(CAT, 'audit TRANSACTION_POSTED มีแถวเดียว และผู้โพสต์ถูกต้อง', {
      input: 'audit_logs TRANSACTION_POSTED',
      expected: `1 row APPROVED->POSTED by ${jwtId(tokens.admin)}`,
      actual: JSON.stringify(auditPost),
      pass: auditPost.length === 1 && auditPost[0].previousStatus === 'APPROVED' && auditPost[0].newStatus === 'POSTED',
    });
    const outboxPost = await rows(
      conn,
      "SELECT type, recipientEmail, subject FROM notification_outbox WHERE loanId = ? AND type='PAYMENT_POSTED'",
      [probe.id],
    );
    check(CAT, 'โพสต์แล้วมีแถวใน notification_outbox สำหรับใบเสร็จ (PAYMENT_POSTED ของ loan นี้)', {
      input: 'notification_outbox by loanId + type PAYMENT_POSTED',
      expected: '>= 1 row, recipient email ends @test.local',
      actual: `${outboxPost.length} row ${JSON.stringify(outboxPost.map((r) => r.recipientEmail))}`,
      pass: outboxPost.length >= 1 && outboxPost.every((r) => String(r.recipientEmail).endsWith('@test.local')),
      note: 'ตรวจรายละเอียด payload/ใบเสร็จจริงใน suite 11',
    });

    // D2 — the three payment-request emails, read from the outbox the same transactions wrote
    const prSubmitted = await outboxRows(probe.id, 'PAYMENT_REQUEST_SUBMITTED');
    const prApproved = await outboxRows(probe.id, 'PAYMENT_REQUEST_APPROVED');
    const prRejected = await outboxRows(probe.id, 'PAYMENT_REQUEST_REJECTED');
    const probeBorrower = await borrowerEmail(probe.id);
    const submittedNos = [reqA.requestNo, selfMade.json.data.request.requestNo, stillPending.json.data.request.requestNo, resubReq.requestNo];
    const submitMail = prSubmitted.filter((r) => r.requestNo === reqA.requestNo);
    const approveMail = prApproved.filter((r) => r.requestNo === reqA.requestNo);
    const rejectMail = prRejected.filter((r) => r.requestNo === selfMade.json.data.request.requestNo);
    check(CAT, 'ยื่นคำขอชำระทุกครั้งที่สร้างสำเร็จ เกิดเมล PAYMENT_REQUEST_SUBMITTED', {
      input: 'notification_outbox type=PAYMENT_REQUEST_SUBMITTED ของ loan นี้ แยกตาม requestNo',
      expected: `ครบทั้ง ${submittedNos.length} เลขคำขอ: ${submittedNos.join(', ')}`,
      actual: [...new Set(prSubmitted.map((r) => r.requestNo))].join(', '),
      pass: submittedNos.every((no) => prSubmitted.some((r) => r.requestNo === no)),
    });
    check(CAT, 'เมลคำขอชำระถึงผู้กู้ +ผู้มีอำนาจทุกคน หนึ่งฉบับต่อกล่องจดหมาย', {
      input: `recipientEmail ของ SUBMITTED ${reqA.requestNo}`,
      expected: `ผู้กู้ ${probeBorrower} และผู้มีอำนาจ ${approverEmails.length} ที่อยู่`,
      actual: `${submitMail.length} แถว → ${submitMail.map((r) => r.recipientEmail).join(', ')}`,
      pass:
        submitMail.length > 0 &&
        reachesAudience(submitMail, [probeBorrower, ...approverEmails]) &&
        submitMail.length === new Set(submitMail.map((r) => String(r.recipientEmail).toLowerCase())).size,
      note: 'คำขอชำระต้องผู้มีอำนาจสั่ง จึงคัดผู้รับคนละแบบกับใบเสร็จเงินเข้า (ถึงเฉพาะผู้กู้ — ดู PAYMENT_POSTED ด้านบน)',
    });
    check(CAT, 'payload ของ SUBMITTED มียอด เลขสัญญา ประเภทคำขอ และสถานะครบ', {
      input: `payload SUBMITTED ${reqA.requestNo}`,
      expected: `amount 12,345.67 LAK, loanCode ${probe.loanNumber}, purposeLabel + status ไม่ใช่ค่าว่าง`,
      actual: JSON.stringify(submitMail[0] ?? null),
      pass:
        submitMail.length >= 1 &&
        submitMail.every(
          (r) => moneyOf(r.amount) === '12345.67' && r.loanCode === probe.loanNumber && !!r.purposeLabel && !!r.payloadStatus,
        ),
    });
    check(CAT, 'checker อนุมัติแล้วเกิดเมล PAYMENT_REQUEST_APPROVED ยอดตรงกับเงินที่ระบบจะตัดใช้', {
      input: `payload APPROVED ${reqA.requestNo}`,
      expected: 'มีแถวถึงผู้กู้ + ผู้มีอำนาจ, amount 12,345.67 LAK, allocation/remaining ไม่ว่าง',
      actual: JSON.stringify(approveMail.map((r) => [r.recipientEmail, r.amount, r.allocation, r.remaining])),
      pass:
        approveMail.length > 0 &&
        moneyOf(approveMail[0].amount) === '12345.67' &&
        !!approveMail[0].allocation &&
        !!approveMail[0].remaining &&
        reachesAudience(approveMail, [probeBorrower, ...approverEmails]),
    });
    check(CAT, 'ปฏิเสธแล้วเกิดเมล PAYMENT_REQUEST_REJECTED พร้อมเหตุผลที่ผู้ตรวจพิมพ์ไป', {
      input: `payload REJECTED ${selfMade.json.data.request.requestNo}`,
      expected: 'มีแถวถึงผู้กู้ + ผู้มีอำนาจ, reason ตรงข้อความที่ส่ง, amount 9,000 LAK',
      actual: JSON.stringify(rejectMail.map((r) => [r.recipientEmail, r.amount, r.reason])),
      pass:
        rejectMail.length > 0 &&
        rejectMail.every((r) => r.reason === 'Amount does not match the bank slip') &&
        moneyOf(rejectMail[0].amount) === '9000' &&
        reachesAudience(rejectMail, [probeBorrower, ...approverEmails]),
    });
    check(CAT, 'คำขอที่ยังไม่มีใครตัดสิน ไม่มีเมล APPROVED/REJECTED (เมลมาพร้อมการตัดสินใจเท่านั้น)', {
      input: `requestNo ของคำขอที่ค้าง PENDING: ${stillPending.json.data.request.requestNo}`,
      expected: '0 แถวทั้ง PAYMENT_REQUEST_APPROVED และ PAYMENT_REQUEST_REJECTED',
      actual: `${prApproved.filter((r) => r.requestNo === stillPending.json.data.request.requestNo).length} + ${prRejected.filter((r) => r.requestNo === stillPending.json.data.request.requestNo).length} แถว`,
      pass:
        prApproved.every((r) => r.requestNo !== stillPending.json.data.request.requestNo) &&
        prRejected.every((r) => r.requestNo !== stillPending.json.data.request.requestNo),
    });

    // E2 — loan with a real penalty: locked order must clear penalty first
    const pen = await newLoan({
      customerId: C6,
      productCode: 'TST-FLAT-M12',
      principal: 2000000,
      // disbursed a full term ago on purpose: this block settles the loan in three goes, and the
      // collection gate only accepts instalments that have actually arrived.
      disbursedAt: '2025-01-05T09:00:00.000Z',
      label: 'pen-loan',
    });
    const penCreate = await api('POST', '/api/transactions/penalties', {
      token: tokens.op1,
      body: { loanId: pen.id, amount: 50000, reason: 'Late instalment (suite 06 order test)' },
    });
    statusCheck(CAT, 'เรียกเก็บค่าปรับ 50,000 ผ่าน workflow: 201 สถานะ PENDING_APPROVAL', penCreate, 201, {
      input: 'POST /api/transactions/penalties',
    });
    const penTxId = penCreate.json.data.transaction.id;
    const penStep = await findStep(penTxId, tokens.checker1);
    check(CAT, 'ค่าปรับ <=1M ต้องการชั้น CHECKER ชั้นเดียวและเห็นใน queue ของ checker', {
      input: 'GET /api/approvals/pending as checker1',
      expected: 'one step at level CHECKER, canDecide true',
      actual: JSON.stringify(penStep ? [penStep.currentLevel, penStep.canDecide, penStep.remainingLevels] : null),
      pass: !!penStep && penStep.currentLevel === 'CHECKER' && penStep.canDecide === true && penStep.remainingLevels.length === 1,
    });
    const penDecide = await api('POST', `/api/approvals/steps/${penStep.stepId}/decision`, {
      token: tokens.checker1,
      body: { decision: 'APPROVE' },
    });
    statusCheck(CAT, 'checker อนุมัติค่าปรับ: 200 และ transaction เป็น APPROVED', penDecide, 200, { input: 'single-level workflow' });
    const penPost = await postTx(penTxId, tokens.admin);
    statusCheck(CAT, 'โพสต์ค่าปรับ: 200 ยอดคงค้างส่วน PENALTY เพิ่ม 50,000', penPost, 200, { input: 'POST /api/transactions/:id/post' });
    states.get(pen.id).components.PENALTY += toCents(50000);
    const penLoan = await loanView(pen.id);
    check(CAT, 'หลังโพสต์ค่าปรับ: outstanding = ค่าปรับ+ดอกเบี้ย+เงินต้น ตาม ledger', {
      input: 'loan outstanding',
      expected: COMPS.map((c) => fmt(states.get(pen.id).components[c])).join(' '),
      actual: COMPS.map((c) => fmt(outstandingOf(penLoan)[c])).join(' '),
      pass: COMPS.every((c) => outstandingOf(penLoan)[c] === states.get(pen.id).components[c]),
    });
    const penaltyMail = await outboxRows(pen.id, 'PENALTY_POSTED');
    const penAudience = [await borrowerEmail(pen.id), ...approverEmails];
    check(CAT, 'โพสต์ค่าปรับแล้วเกิดเมล PENALTY_POSTED ถึงผู้กู้ +ผู้มีอำนาจ ครั้งละหนึ่งฉบับต่อกล่องจดหมาย', {
      input: 'notification_outbox type=PENALTY_POSTED ของ pen-loan',
      expected: `${penAudience.length} แถว, amount 50,000 LAK, reason ตรงกับที่เรียกเก็บ, remaining ไม่ใช่ค่าว่าง`,
      actual: JSON.stringify(penaltyMail.map((r) => [r.recipientEmail, r.amount, r.reason, r.remaining])),
      pass:
        penaltyMail.length === penAudience.length &&
        moneyOf(penaltyMail[0]?.amount) === '50000' &&
        penaltyMail[0]?.reason === 'Late instalment (suite 06 order test)' &&
        !!penaltyMail[0]?.remaining &&
        reachesAudience(penaltyMail, penAudience),
      note: 'ตอน create และตอน approve ยังไม่มีแถว — เมลถูกคิวพร้อมโพสต์เท่านั้น เพราะค่าปรับที่ยังไม่โพสต์ยังไม่ถูกเรียกเก็บจริง',
    });
    await payAndVerify(pen, { cash: 60000, label: 'order-1 (ค่าปรับ 50,000 ต้องถูกตัดก่อนดอกเบี้ย)' });
    await payAndVerify(pen, { cash: 350000, label: 'order-2 (ดอกเบี้ยที่เหลือจนหมด)' });
    const penMid = await loanView(pen.id);
    check(CAT, 'หลังชำระ 2 รอบ: ค่าปรับกับดอกเบี้ยเป็น 0 เหลือแต่เงินต้น 2,000,000', {
      input: 'loan outstanding',
      expected: 'PENALTY=0.00 PAST_INTEREST=0.00 PAST_PRINCIPAL=2000000.00',
      actual: `PENALTY=${penMid.outstanding.penalty} PAST_INTEREST=${penMid.outstanding.pastInterest} PAST_PRINCIPAL=${penMid.outstanding.pastPrincipal}`,
      pass:
        sameMoney(penMid.outstanding.penalty, 0) &&
        sameMoney(penMid.outstanding.pastInterest, 0) &&
        sameMoney(penMid.outstanding.pastPrincipal, 2000000),
    });
    const penRest = await payAndVerify(pen, { cash: 2000000, label: 'order-3 (เงินต้นปิดทั้งก้อน -> CLOSED)' });
    check(CAT, 'ปิด loan ด้วยยอดชำระพอดีทุกส่วน: สถานะ CLOSED และ outstanding = 0', {
      input: 'final payment result',
      expected: { status: 'CLOSED', outstanding: '0.00' },
      actual: { status: penRest.after.status, outstanding: penRest.after.outstanding.total },
      pass: penRest.after.status === 'CLOSED' && sameMoney(penRest.after.outstanding.total, 0),
    });

    // E3 — the collection gate refuses cash above the instalments that have arrived and points at the
    // deposit channel; the deposited 75,000 then stays as customer credit while the loan closes (LOCKED 6).
    const over = await newLoan({
      customerId: C7,
      productCode: 'TST-FLAT-M12',
      principal: 1000000,
      disbursedAt: '2025-01-05T09:00:00.000Z',
      label: 'over-loan',
    });
    const overState = states.get(over.id);
    const overOwed = totalOf(overState.components);
    const overPayable = (await api('GET', `/api/loans/${over.id}/payable-now`)).json?.data ?? {};
    check(CAT, 'payable-now หลังกู้ครบทั้งสัญญา: maxPayable = dueToPay = หนี้ทั้งก้อนใน ledger', {
      input: 'GET /api/loans/:id/payable-now',
      expected: fmt(overOwed),
      actual: `maxPayable ${fmt(cent(overPayable.maxPayable ?? -1))} dueToPay ${fmt(cent(overPayable.dueToPay ?? -1))} ledger ${fmt(cent(overPayable.ledgerOutstanding ?? -1))}`,
      pass: [overPayable.maxPayable, overPayable.dueToPay, overPayable.ledgerOutstanding].every((v) => cent(v ?? -1) === overOwed),
    });
    const gatedAsk = overOwed + toCents(75000);
    const gated = await createReq({ loanId: over.id, cashAmount: toLak(gatedAsk) }, tokens.op1);
    statusCheck(CAT, 'ชำระเกินยอดที่ถึงกำหนด: 422 พร้อมชี้ช่อง deposit to credit', gated, 422, {
      input: `cash ${fmt(gatedAsk)} ทั้งที่เก็บได้ ${fmt(overOwed)}`,
      messageIncludes: 'Bring the rest as a deposit to credit',
    });
    const gateMsg = errorMessage(gated);
    check(CAT, 'ข้อความ 422 บอกตัวเลขที่เก็บได้จริงและอ้างถึง auto-debit เพื่อให้ staff อธิบายลูกค้าได้', {
      input: 'POST /api/payment-requests เกิน due scope',
      expected: `Only ${fmt(overOwed)} LAK is due ... auto-debits it when the instalment falls due`,
      actual: gateMsg.slice(0, 200),
      pass: gateMsg.startsWith(`Only ${fmt(overOwed)} LAK is due on loan`) && /auto-debits it when the instalment falls due/.test(gateMsg),
    });
    const gateDetails = gated.json?.error?.details ?? {};
    check(CAT, '422 มี details ให้ UI ยืนยันตัวเลข (maxPayable/requested/duePeriods/nextPendingPeriod)', {
      input: 'error.details ของคำขอที่ถูก gate',
      expected: `maxPayable ${fmt(overOwed)}, requested ${fmt(gatedAsk)}, duePeriods 12, nextPendingPeriod null (ทั้งสัญญาถึงกำหนดแล้ว)`,
      actual: `maxPayable ${fmt(cent(gateDetails.maxPayable ?? -1))} requested ${fmt(cent(gateDetails.requested ?? -1))} periods ${gateDetails.duePeriods?.length} next ${JSON.stringify(gateDetails.nextPendingPeriod)}`,
      pass:
        cent(gateDetails.maxPayable ?? -1) === overOwed &&
        cent(gateDetails.requested ?? -1) === gatedAsk &&
        gateDetails.duePeriods?.length === 12 &&
        gateDetails.nextPendingPeriod === null,
    });
    const gatedTx = await rows(conn, 'SELECT COUNT(*) n FROM payment_requests WHERE loanId = ?', [over.id]);
    check(CAT, 'คำขอที่ถูก gate ต้องไม่เหลือแถวใน DB (rollback ทั้ง transaction) — กติกาใหม่ไม่สร้างหนี้ค้างครึ่งตัว', {
      input: 'payment_requests ของ over-loan หลัง 422',
      expected: 0,
      actual: gatedTx[0].n,
      pass: gatedTx[0].n === 0,
    });
    await depositAndVerify(over, { cash: 75000, label: 'deposit 75,000 (ช่องทางที่gate ชี้)' });
    const creditRow = (await rows(conn, 'SELECT balance FROM customer_credits WHERE customerId = ?', [C7]))[0];
    check(CAT, 'เงินที่ฝากไว้กลายเป็น credit ของลูกค้า 75,000 (LOCKED section 6)', {
      input: 'customer_credits.balance',
      expected: '75000.00',
      actual: creditRow ? String(creditRow.balance) : 'no row',
      pass: !!creditRow && sameMoney(creditRow.balance, 75000),
    });
    const creditLedger = await rows(conn, 'SELECT type, amount, balanceAfter FROM credit_ledger WHERE customerId = ? ORDER BY createdAt', [C7]);
    check(CAT, 'credit_ledger มีแถว ACCRUED 75,000 พร้อม balanceAfter', {
      input: 'credit_ledger',
      expected: [['ACCRUED', '75000.00', '75000.00']],
      actual: creditLedger.map((r) => [r.type, String(r.amount), String(r.balanceAfter)]),
      pass: creditLedger.length === 1 && creditLedger[0].type === 'ACCRUED' && sameMoney(creditLedger[0].amount, 75000) && sameMoney(creditLedger[0].balanceAfter, 75000),
    });
    const creditAudit = await rows(conn, "SELECT action FROM audit_logs WHERE action IN ('CREDIT_ACCRUED','CREDIT_USED') AND customerId = ?", [C7]);
    check(CAT, 'การขยับ credit มี audit ทุกรายการ (CREDIT_ACCRUED)', {
      input: 'audit_logs credit actions',
      expected: "['CREDIT_ACCRUED']",
      actual: JSON.stringify(creditAudit.map((r) => r.action)),
      pass: creditAudit.length === 1 && creditAudit[0].action === 'CREDIT_ACCRUED',
    });
    const overRes = await payAndVerify(over, { cash: toLak(overOwed), label: 'payoff พอดีทุกส่วน (เงิน 75,000 ที่ฝากไว้ยังเป็น credit)' });
    const creditLeft = (await rows(conn, 'SELECT balance FROM customer_credits WHERE customerId = ?', [C7]))[0];
    check(CAT, 'loan ที่ปิดพอดี: สถานะ CLOSED และยังมียอด credit ค้าง (ไม่ถูกนำไปปิดหนี้ loan อื่นอัตโนมัติ)', {
      input: 'post-payoff loan + customer_credits',
      expected: { status: 'CLOSED', outstanding: '0.00', credit: '75000.00' },
      actual: {
        status: overRes.after.status,
        outstanding: overRes.after.outstanding.total,
        credit: String(creditLeft?.balance ?? 'no row'),
      },
      pass:
        overRes.after.status === 'CLOSED' &&
        sameMoney(overRes.after.outstanding.total, 0) &&
        sameMoney(overRes.posted.json.data.excess, 0) &&
        sameMoney(creditLeft?.balance ?? -1, 75000),
    });

    // E4 — pay fully with credit only (cash 0). Target loan uses the zero-interest product so its
    // total stays below the credit we generate on the source loan.
    const cred = await newLoan({
      customerId: C5,
      productCode: 'TST-NOPEN-ZERO',
      principal: 100000,
      disbursedAt: '2026-01-05T09:00:00.000Z',
      label: 'credit-loan',
    });
    // bring credit to C5 the way the collection gate intends: a deposit on a second loan of the same
    // customer. It buys no debt, so the source loan stays exactly where the oracle put it.
    const cred2 = await newLoan({
      customerId: C5,
      productCode: 'TST-FLAT-M6',
      principal: 300000,
      disbursedAt: '2026-01-05T09:00:00.000Z',
      label: 'credit-source-loan',
    });
    await depositAndVerify(cred2, { cash: 120000, label: 'credit-source deposit (+120,000)' });
    const avail = (await rows(conn, 'SELECT balance FROM customer_credits WHERE customerId = ?', [C5]))[0]?.balance;
    check(CAT, 'ลูกค้า C5 มี credit จากการฝากเข้า credit ของ loan แรก 120,000', {
      input: 'customer_credits.balance for C5',
      expected: '120000.00',
      actual: String(avail),
      pass: sameMoney(avail, 120000),
    });
    // the due-scope gate is checked before the credit balance, so this probe asks for less than the
    // source loan owes (332,400) and more than the customer holds (120,000)
    statusCheck(CAT, 'ขอใช้ credit เกินยอดที่มี: 422', await createReq({ loanId: cred2.id, cashAmount: 0, creditToApply: 200000 }, tokens.op1), 422, {
      input: 'creditToApply 200,000 บนหนี้ 332,400 ขณะที่ credit คงเหลือ 120,000',
      messageIncludes: 'Insufficient customer credit: available 120000, requested 200000',
    });
    const credFull = states.get(cred.id);
    const credTotal = totalOf(credFull.components);
    const credMade = await createReq({ loanId: cred.id, cashAmount: 0, creditToApply: toLak(credTotal) }, tokens.op1);
    statusCheck(CAT, 'ชำระเงินด้วย credit ล้วน (เงินสด 0): 201', credMade, 201, {
      input: `cash 0 + credit ${toLak(credTotal)}`,
      note: 'cashAmount=0 allowed because cash+credit > 0',
    });
    const credAppr = await approveReq(credMade.json.data.request.id, {}, tokens.checker1);
    statusCheck(CAT, 'approve payment ที่ใช้ credit ล้วน: 200', credAppr, 200, { input: 'credit-only request' });
    const credPost = await postTx(credAppr.json.data.transaction.id, tokens.admin);
    statusCheck(CAT, 'โพสต์ payment ที่ใช้ credit ล้วน: 200', credPost, 200, { input: 'post' });
    const credExp = postEvent(credFull, { type: 'PAYMENT', amountCents: 0, creditAppliedCents: credTotal });
    check(CAT, 'payment แบบใช้ credit อย่างเดียว: tx.amount = ยอดที่ใช้ credit และ allocation ครบตามลำดับ', {
      input: 'posted transaction',
      expected: `amount ${fmt(credTotal)} + ${COMPS.map((c) => `${c}=${fmt(credExp.allocation[c])}`).join(' ')}`,
      actual: `amount ${credPost.json.data.transaction.amount} + ${COMPS.map((c) => `${c}=${fmt(toCents(credPost.json.data.allocation[c]))}`).join(' ')}`,
      pass: cent(credPost.json.data.transaction.amount) === credTotal && COMPS.every((c) => cent(credPost.json.data.allocation[c]) === credExp.allocation[c]),
    });
    const credLedger = await rows(conn, 'SELECT type, amount, balanceAfter FROM credit_ledger WHERE customerId = ? ORDER BY createdAt', [C5]);
    check(CAT, 'credit_ledger ของ C5: ACCRUED 120,000 แล้ว USED 100,000 -> เหลือ credit 20,000', {
      input: 'credit_ledger rows',
      expected: 'ACCRUED 120000 (120000), USED 100000 (20000)',
      actual: JSON.stringify(credLedger.map((r) => [r.type, String(r.amount), String(r.balanceAfter)])),
      pass:
        credLedger.length === 2 &&
        credLedger[0].type === 'ACCRUED' &&
        sameMoney(credLedger[0].balanceAfter, 120000) &&
        credLedger[1].type === 'USED' &&
        sameMoney(credLedger[1].amount, 100000) &&
        sameMoney(credLedger[1].balanceAfter, 20000),
    });
    const credLoanAfter = await loanView(cred.id);
    check(CAT, 'loan ที่ปิดด้วย credit อย่างเดียว: outstanding 0 สถานะ CLOSED', {
      input: 'loan after credit-only payment',
      expected: { status: 'CLOSED', outstanding: '0.00' },
      actual: { status: credLoanAfter.status, outstanding: credLoanAfter.outstanding.total },
      pass: credLoanAfter.status === 'CLOSED' && sameMoney(credLoanAfter.outstanding.total, 0),
    });

    // E5 — outstanding shrinks between approve and post (locked: only POSTED is truth)
    const race = await newLoan({
      customerId: C8,
      productCode: 'TST-FLAT-M6',
      principal: 600000,
      disbursedAt: '2026-01-05T09:00:00.000Z',
      label: 'race-loan',
    });
    const rs = states.get(race.id);
    const rTotal = totalOf(rs.components);
    const first = await createReq({ loanId: race.id, cashAmount: toLak(rTotal) }, tokens.op1);
    const second = await createReq({ loanId: race.id, cashAmount: 100000 }, tokens.op2);
    const firstAppr = await approveReq(first.json.data.request.id, {}, tokens.checker1);
    const secondAppr = await approveReq(second.json.data.request.id, {}, tokens.head);
    statusCheck(CAT, 'อนุมัติ 2 request บน loan เดียวกันก่อนโพสต์ (ทั้งสอง 200)', firstAppr, 200, { input: 'request 1 full payoff' });
    statusCheck(CAT, 'request ที่สอง (100,000) อนุมัติได้ เพราะยอดยังไม่ลด', secondAppr, 200, { input: 'request 2' });
    const racePost1 = await postTx(firstAppr.json.data.transaction.id, tokens.admin);
    statusCheck(CAT, 'โพสต์ request แรก (ปิดหนี้ทั้งก้อน): 200', racePost1, 200, { input: 'post full payoff' });
    postEvent(rs, { type: 'PAYMENT', amountCents: rTotal });
    const racePost2 = await postTx(secondAppr.json.data.transaction.id, tokens.admin);
    check(CAT, 'โพสต์ request ที่สองบน loan ที่หมดหนี้แล้ว: ต้องไม่ตัดหนี้ซ้ำ และควรกลายเป็น credit', {
      input: 'post of a payment approved against the old balance',
      expected: '200 with allocation all zero + excess 100000 as credit, OR a clear 422 explaining the loan is closed',
      actual: `HTTP ${racePost2.status} ${errorMessage(racePost2)}`,
      pass: racePost2.status === 200,
      note: 'F-PAY-1 (รอสรุป severity): approve เขียน finalAmount = proposed เสมอ ทำให้ postPayment มองเป็น staff override แล้ว 422 "Allocation ... exceeds outstanding" ทั้งที่ควรเป็น overpayment -> credit',
    });

    // E6 — approve after the loan closed meanwhile
    const late = await newLoan({
      customerId: C8,
      productCode: 'TST-FLAT-M6',
      principal: 250000,
      disbursedAt: '2026-01-05T09:00:00.000Z',
      label: 'late-loan',
    });
    const latePending = await createReq({ loanId: late.id, cashAmount: 1000 }, tokens.op1);
    const ls = states.get(late.id);
    await payAndVerify(late, { cash: toLak(totalOf(ls.components)), label: 'late-loan payoff' });
    statusCheck(CAT, 'approve request ที่ค้างอยู่ หลัง loan กลายเป็น CLOSED: 422', await approveReq(latePending.json.data.request.id, {}, tokens.checker1), 422, {
      input: 'approve after closure',
      messageIncludes: 'Loan is CLOSED — cannot approve payment',
    });

    // E7 — odd decimals / rounding to the cent
    const odd = await newLoan({
      customerId: C6,
      productCode: 'TST-FLAT-M12',
      principal: 333333.33,
      disbursedAt: '2025-01-05T09:00:00.000Z',
      label: 'odd-loan',
    });
    const os = states.get(odd.id);
    await payAndVerify(odd, { cash: 1000.01, label: 'odd-1 ทศนิยม 2 ตำแหน่ง' });
    await payAndVerify(odd, { cash: toLak(totalOf(os.components)), label: 'odd-2 ปิดด้วยยอดที่เหลือทศนิยม' });

    // ============================================ F. list / detail / pagination
    const list = await api('GET', '/api/payment-requests?limit=100');
    statusCheck(CAT, 'GET /api/payment-requests: 200', list, 200, { input: 'limit=100' });
    const dbTotal = (await rows(conn, 'SELECT COUNT(*) n FROM payment_requests'))[0].n;
    check(CAT, 'pagination.total ของ list ตรงกับจำนวนแถวใน DB', {
      input: 'GET list total vs COUNT(*) payment_requests',
      expected: dbTotal,
      actual: list.json.pagination?.total,
      pass: list.json.pagination?.total === dbTotal,
    });
    const clamps = [
      ['0', 20, '0 -> ตกเป็นค่า default 20'],
      ['abc', 20, 'ค่าที่ไม่ใช่ตัวเลข -> 20'],
      ['5000', 100, 'เกินเพดาน -> clamp ที่ 100'],
      ['-3', 1, 'ค่าติดลบไม่ได้กลับเป็น default แต่ถูก clamp ที่ 1 (ยังปลอดภัย ไม่ crash)'],
    ];
    for (const [q, want, why] of clamps) {
      const res = await api('GET', `/api/payment-requests?limit=${q}`);
      check(CAT, `limit=${q} ต้องได้ ${want} (${why})`, {
        input: `?limit=${q}`,
        expected: want,
        actual: res.json.pagination?.limit,
        pass: res.status === 200 && res.json.pagination?.limit === want,
      });
    }
    const p1 = await api('GET', '/api/payment-requests?limit=5&page=1');
    const p2 = await api('GET', '/api/payment-requests?limit=5&page=2');
    const ids1 = (p1.json.data ?? []).map((r) => r.id);
    const ids2 = (p2.json.data ?? []).map((r) => r.id);
    const stamp = (r) => String(r.createdAt);
    const t1 = (p1.json.data ?? []).map(stamp);
    check(CAT, 'แบ่งหน้า: หน้า 1/2 ไม่ซ้ำกัน และเรียงตาม createdAt DESC', {
      input: 'page=1 & page=2 limit=5',
      expected: '5+5 distinct ids, createdAt non-increasing',
      actual: `${ids1.length}/${ids2.length} overlap ${ids1.filter((i) => ids2.includes(i)).length} order ${t1.join(' ')}`,
      pass: ids1.length === 5 && ids2.length === 5 && t1.every((v, k) => k === 0 || t1[k - 1] >= v) && ids1.filter((i) => ids2.includes(i)).length === 0,
    });
    const onlyPending = await api('GET', '/api/payment-requests?status=PENDING&limit=100');
    const dbPending = (await rows(conn, "SELECT COUNT(*) n FROM payment_requests WHERE status='PENDING'"))[0].n;
    check(CAT, 'filter status=PENDING ตรงกับ DB และไม่มียอดสถานะอื่นปน', {
      input: '?status=PENDING vs DB count',
      expected: dbPending,
      actual: `${onlyPending.json.pagination?.total} total, foreign statuses ${(onlyPending.json.data ?? []).filter((r) => r.status !== 'PENDING').length}`,
      pass: onlyPending.json.pagination?.total === dbPending && (onlyPending.json.data ?? []).every((r) => r.status === 'PENDING'),
    });
    const bogusStatus = await api('GET', '/api/payment-requests?status=NOT_A_STATUS');
    const dbBogus = (await rows(conn, 'SELECT COUNT(*) n FROM payment_requests'))[0].n;
    check(CAT, 'filter ค่า enum ปลอม: ระบบไม่ crash (คืนทั้งชุดหรือว่าง) และตอบ 200', {
      input: '?status=NOT_A_STATUS',
      expected: '200',
      actual: `${bogusStatus.status}, rows ${bogusStatus.json.data?.length} of ${dbBogus}`,
      pass: bogusStatus.status === 200,
      note: 'ไม่ validate enum ของ filter — ควรมี 400 หรือ ignore ที่ชัดเจน (บันทึกเป็นข้อสังเกต)',
    });
    const byLoan = await api('GET', `/api/payment-requests?loanId=${probe.id}&limit=100`);
    check(CAT, 'filter loanId คืนเฉพาะ request ของ loan นั้น', {
      input: `?loanId=${probe.loanNumber ?? probe.id}`,
      expected: 'all rows loanId equal',
      actual: `${byLoan.json.data?.length} rows, foreign ${(byLoan.json.data ?? []).filter((r) => r.loanId !== probe.id).length}`,
      pass: (byLoan.json.data ?? []).length > 0 && (byLoan.json.data ?? []).every((r) => r.loanId === probe.id),
    });
    const pcRes = await api('GET', '/api/payment-requests/pending-count');
    check(CAT, 'GET /pending-count = จำนวน PENDING จริงใน DB', {
      input: 'pending-count vs DB',
      expected: dbPending,
      actual: pcRes.json.data?.count,
      pass: pcRes.json.data?.count === dbPending,
    });
    const dPending = await detail(resubReq.id);
    check(CAT, 'detail ของ PENDING: allocations ครบ 3 และ transaction = null', {
      input: `GET /api/payment-requests/${resubReq.requestNo}`,
      expected: '3 allocations, transaction null, previousRequest present',
      actual: `${dPending.json.data.allocations?.length} allocations, tx ${dPending.json.data.transaction === null ? 'null' : 'set'}, prev ${!!dPending.json.data.previousRequest}`,
      pass: dPending.json.data.allocations?.length === 3 && dPending.json.data.transaction === null && !!dPending.json.data.previousRequest,
    });
    const dPosted = await detail(reqA.id);
    check(CAT, 'detail ของ request ที่โพสต์แล้ว: คืน transaction สถานะ POSTED', {
      input: 'GET detail of posted request',
      expected: 'transaction POSTED + allocations with finalAmount',
      actual: `${dPosted.json.data.transaction?.status}, final sum ${sumMoney(dPosted.json.data.allocations.reduce((a, r) => ({ ...a, [r.component]: r.finalAmount }), {}))}`,
      pass: dPosted.json.data.transaction?.status === 'POSTED' && dPosted.json.data.allocations?.length === 3,
    });
    statusCheck(CAT, 'detail id ปลอม: 404', await detail(NIL), 404, { input: NIL, messageIncludes: 'Payment request' });
    statusCheck(CAT, 'detail โดยไม่ส่ง token: 401', await detail(reqA.id, null), 401, { input: 'no token' });

    // ============================================ G. credits endpoints
    const credList = await api('GET', '/api/credits');
    statusCheck(CAT, 'GET /api/credits: 200 (ทุก role อ่านได้)', credList, 200, { input: 'list' });
    const dbCreditSum = await rows(conn, 'SELECT customerId, balance FROM customer_credits');
    check(CAT, 'GET /api/credits คืนตรงตามตาราง customer_credits', {
      input: 'list vs DB',
      expected: dbCreditSum.length,
      actual: credList.json.data?.length,
      pass: credList.json.data?.length === dbCreditSum.length,
    });
    const ledgerRes = await api('GET', `/api/credits/ledger?customerId=${C7}`);
    statusCheck(CAT, 'GET /api/credits/ledger?customerId: 200', ledgerRes, 200, { input: C7 });
    const led = ledgerRes.json.data.ledger ?? [];
    const acc = led.filter((r) => r.type === 'ACCRUED').reduce((a, r) => a + Number(r.amount), 0);
    const used = led.filter((r) => r.type === 'USED').reduce((a, r) => a + Number(r.amount), 0);
    check(CAT, 'credit ledger (ACCRUED - USED) = currentBalance ที่ระบบคืน (invariant หนี้ credit)', {
      input: 'ledger of C5 (has ACCRUED+USED)',
      expected: `${acc} - ${used} = balance`,
      actual: JSON.stringify(ledgerRes.json.data.currentBalance),
      pass: sameMoney(acc - used, ledgerRes.json.data.currentBalance),
    });
    const c5Led = await api('GET', `/api/credits/ledger?customerId=${C5}`);
    check(CAT, 'ledger ของ C5 ผ่าน API: ACCRUED + USED และ balance 20,000 ที่เหลือจากใช้ credit ปิด loan', {
      input: 'C5 ledger',
      expected: { types: ['ACCRUED', 'USED'], balance: 20000 },
      actual: { types: (c5Led.json.data.ledger ?? []).map((r) => r.type).sort(), balance: c5Led.json.data.currentBalance },
      pass: JSON.stringify((c5Led.json.data.ledger ?? []).map((r) => r.type).sort()) === '["ACCRUED","USED"]' && sameMoney(c5Led.json.data.currentBalance, 20000),
    });
    statusCheck(CAT, 'GET /api/credits/ledger โดยไม่มี customerId: 400', await api('GET', '/api/credits/ledger'), 400, {
      input: 'no query',
      messageIncludes: 'customerId query parameter is required',
    });
    const emptyLed = await api('GET', `/api/credits/ledger?customerId=${NIL}`);
    check(CAT, 'ledger ของลูกค้าที่ไม่มีอยู่: 200 + ว่าง + balance 0 (ไม่ใช่ 404)', {
      input: 'unknown customerId',
      expected: { ledger: 0, currentBalance: 0 },
      actual: { ledger: (emptyLed.json.data?.ledger ?? []).length, currentBalance: emptyLed.json.data?.currentBalance },
      pass: (emptyLed.json.data?.ledger ?? []).length === 0 && emptyLed.json.data?.currentBalance === 0,
    });
    const seedCreditUntouched = (await rows(conn, 'SELECT balance FROM customer_credits WHERE customerId = ?', ['00000000-2000-4000-8000-000000000003']))[0];
    check(CAT, 'suite นี้ไม่แตะ credit ของข้อมูล seed (CUST-TST-0003 ยัง 160,000)', {
      input: 'seeded credit balance',
      expected: expected.credits['00000000-2000-4000-8000-000000000003'].balance,
      actual: String(seedCreditUntouched?.balance),
      pass: sameMoney(seedCreditUntouched?.balance, expected.credits['00000000-2000-4000-8000-000000000003'].balance),
    });

    // ============================================ H. abandoned/unposted transactions stay inert
    const ovrTxRow = (await rows(conn, 'SELECT status, postedAt FROM financial_transactions WHERE id = ?', [ovrTxId]))[0];
    check(CAT, 'transaction ที่ approve แต่ไม่โพสต์: คง APPROVED, postedAt NULL, ไม่กระทบยอดคงค้าง', {
      input: 'financial_transactions row of the unposted override approval',
      expected: { status: 'APPROVED', postedAt: null },
      actual: { status: ovrTxRow?.status, postedAt: ovrTxRow?.postedAt },
      pass: ovrTxRow?.status === 'APPROVED' && ovrTxRow?.postedAt === null,
    });

    // ============================================ I. cleanup verification
    // The outbox row for the last payment can still be landing when this runs; purging too
    // early would leave it as "suite dirt" for the row-count check below and for suite 07.
    await settle();
    await purge();
    const after = {};
    for (const t of Object.keys(baseline)) {
      after[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    }
    const dirty = Object.keys(baseline).filter((t) => after[t] !== baseline[t]);
    check(CAT, 'หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(after),
      pass: dirty.length === 0,
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
    });
    const seededNow = (await api('GET', '/api/loans?limit=100')).json;
    check(CAT, 'ข้อมูล seed ยังครบ 21 loan และ aggregates คืนค่าเท่าเดิม', {
      input: 'GET /api/loans after cleanup',
      expected: `${expected.rowCounts.loans} loans, outstanding ${expected.totals.closingOutstanding}`,
      actual: `${seededNow.pagination?.total} loans, outstanding ${seededNow.aggregates?.outstandingTotal}`,
      pass: seededNow.pagination?.total === expected.rowCounts.loans && sameMoney(seededNow.aggregates?.outstandingTotal, expected.totals.closingOutstanding),
    });
    const goneProbe = await api('GET', `/api/loans/${probe.id}`);
    statusCheck(CAT, 'loan ของ suite หายไปจริงหลัง purge: 404', goneProbe, 404, { input: probe.id });
    const orphanLines = (
      await rows(
        conn,
        'SELECT COUNT(*) n FROM financial_transaction_lines WHERE transactionId NOT IN (SELECT id FROM financial_transactions)',
      )
    )[0].n;
    const orphanAlloc = (
      await rows(conn, 'SELECT COUNT(*) n FROM payment_allocations WHERE paymentRequestId NOT IN (SELECT id FROM payment_requests)')
    )[0].n;
    check(CAT, 'ไม่เหลือแถวกำพร้า (lines/allocations) หลังลบข้อมูลของ suite', {
      input: 'orphan financial_transaction_lines + payment_allocations',
      expected: '0 / 0',
      actual: `${orphanLines} / ${orphanAlloc}`,
      pass: orphanLines === 0 && orphanAlloc === 0,
    });
  } catch (err) {
    check(CAT, 'suite 06 ต้องรันจนจบโดยไม่ throw', {
      input: 'run',
      expected: 'no exception',
      actual: `${err?.message ?? err}`,
      pass: false,
      note: String(err?.stack ?? '').slice(0, 400),
    });
    await purge().catch(() => {});
    throw err;
  }
}
