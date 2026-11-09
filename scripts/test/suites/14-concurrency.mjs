// 14-concurrency: what happens when two staff members press the button at the same instant.
//
// Every financial mutation that a race can corrupt is fired as parallel HTTP requests against the
// live server, then checked against the accounting invariant it must preserve: one post per
// transaction, one decision per approval step, credit spent once, no reversal beyond the original
// amount, no settlement paid twice, one OTP / one reset link.
//
// Where the server serialises correctly the case passes and the evidence is recorded (posting the
// same transaction, approving the same request, reversing the same payment, deciding an approval
// step at the right level). Where two parallel requests both take the same money or the same
// credential the case fails as a finding: F-CONC-1 (customer credit), F-CONC-3 (approval step),
// F-CONC-4 (OTP / reset link), F-CONC-5 (settlement agreement). Two further races — reversal and
// settlement-payment drafts created in the same instant — currently die on the requestNo/referenceNo
// unique index instead of a money guard, which is recorded as F-CONC-OBS-1/2: the collision hides
// the bug, it does not fix it, so both are re-tested sequentially.
// This suite only reports — no business rule, no locked formula and no system code is changed.
//
// Like suites 06/07/08 every loan, transaction, agreement and account created here is deleted
// again in `purge`, because suites 10/15 compare the seeded ledger against expected.json.
import { PASSWORD, api as http, check, errorMessage, login, rows, settle, unseal, withPinnedPolicies } from '../lib/harness.mjs';
import { billedInterestCents, fmt, postEvent, toCents, toLak, totalOf } from '../oracle.mjs';

const CAT = 'concurrency';
const RUN_TAG = String(Date.now()).slice(-6);

const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const LEVELS = ['CHECKER', 'HEAD', 'ADMIN'];
const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
const sumMoney = (c) => COMPS.reduce((acc, k) => acc + Number(c[k] ?? 0), 0);
const is2xx = (r) => r.status >= 200 && r.status < 300;
const is4xx = (r) => r.status >= 400 && r.status < 500;
const codesOf = (rs) => rs.map((r) => r.status).join(',');
const winsOf = (rs) => rs.filter(is2xx).length;

/** loan.outstanding (camelCase, LAK) -> components in cents */
const outstandingOf = (loan) => ({
  PENALTY: cent(loan.outstanding?.penalty ?? 0),
  PAST_INTEREST: cent(loan.outstanding?.pastInterest ?? 0),
  PAST_PRINCIPAL: cent(loan.outstanding?.pastPrincipal ?? 0),
});

// Dedicated seeded customers with no credit row of their own (same choice as suites 06/07), so
// every credit balance created here is fully reversible.
const C5 = '00000000-2000-4000-8000-000000000005';
const C6 = '00000000-2000-4000-8000-000000000006';
const C7 = '00000000-2000-4000-8000-000000000007';
const C8 = '00000000-2000-4000-8000-000000000008';
const CUSTS = [C5, C6, C7, C8];

const OTP_MAX = 5; // env.security.otpMaxAttempts (server/.env sets no override)

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
  'settlement_agreements',
  'audit_logs',
  'notification_outbox',
  'password_reset_tokens',
  'users',
  'system_config',
];

export default async function suite(ctx) {
  // This suite races on user creation and on money, and suite 13 edits the same policies right before
  // it, so both namespaces are pinned to the shipped defaults for the run and put back afterwards.
  return withPinnedPolicies(ctx.api, ['payment', 'password'], () => run(ctx));
}

async function run(ctx) {
  const { tokens, conn, api: adminApi } = ctx;
  // ctx.api defaults to the admin token; a case that means "unauthenticated" must pass token:null.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));

  const ok = (name, cond, { input, expected: e = 'true', actual: a = '', note = '' } = {}) =>
    check(CAT, name, { input, expected: e, actual: typeof a === 'string' ? a : JSON.stringify(a), pass: !!cond, note });

  /** Fires n copies of `make()` at the same instant and returns every response. */
  const race = (n, make) => Promise.all(Array.from({ length: n }, () => make()));

  // --------------------------------------------------------------------- baselines
  const baselineCounts = {};
  for (const t of TABLES) baselineCounts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`, []))[0].n);
  /** Every audit id that already exists, so this suite can delete exactly the trail it adds. */
  const auditIdsBefore = new Set((await rows(conn, 'SELECT id FROM audit_logs', [])).map((r) => r.id));

  /** Customers whose credit ledger already disagrees with the stored balance, before this suite. */
  const creditDriftSet = async () =>
    (
      await rows(
        conn,
        `SELECT cc.customerId id, CAST(cc.balance AS CHAR) bal,
                COALESCE((SELECT SUM(CASE WHEN cl.type='ACCRUED' THEN cl.amount ELSE -cl.amount END)
                          FROM credit_ledger cl WHERE cl.customerId = cc.customerId), 0) derived
         FROM customer_credits cc`,
        [],
      )
    )
      .filter((r) => Math.abs(Number(r.bal) - Number(r.derived)) > 0.005)
      .map((r) => `${String(r.id).slice(-12)}:${r.bal}/${r.derived}`)
      .sort()
      .join('|');

  const negativeComponentLoans = () =>
    rows(
      conn,
      `SELECT loanNumber, CAST(outstandingPenalty AS CHAR) p, CAST(outstandingPastInterest AS CHAR) i,
              CAST(outstandingPastPrincipal AS CHAR) pr
       FROM loans
       WHERE outstandingPenalty < 0 OR outstandingPastInterest < 0 OR outstandingPastPrincipal < 0`,
      [],
    );

  const thresholdRowsSql =
    'SELECT id, `key`, CAST(value AS CHAR) AS value, valueText, description, updatedBy, CAST(updatedAt AS CHAR) AS updatedAt ' +
    "FROM system_config WHERE `key` IN ('approval.checkerThreshold', 'approval.headThreshold') ORDER BY `key`";
  const thSnapshot = await rows(conn, thresholdRowsSql, []);
  const restoreThresholds = async () => {
    for (const r of thSnapshot) {
      await conn.query(
        'UPDATE system_config SET value=?, valueText=?, description=?, updatedBy=?, updatedAt=? WHERE `key`=?',
        [r.value, r.valueText, r.description, r.updatedBy, r.updatedAt, r.key],
      );
    }
  };
  const thresholdsNow = async () => (await api('GET', '/api/config/thresholds')).json;
  const fpBefore = JSON.stringify(await thresholdsNow());

  const creditDriftBefore = await creditDriftSet();
  const negativesBefore = (await negativeComponentLoans()).length;

  // --------------------------------------------------------------------- bookkeeping + purge
  const createdLoans = [];
  const createdTx = [];
  const createdRequests = [];
  const createdAgreements = [];
  const createdUsers = [];
  const states = new Map();

  const purge = async () => {
    const loanIds = createdLoans.length ? createdLoans : ['00000000-0000-4000-8000-000000000000'];
    const agIds = createdAgreements.length ? createdAgreements : ['00000000-0000-4000-8000-000000000000'];
    const userIds = createdUsers.length ? createdUsers.map((u) => u.id) : ['00000000-0000-4000-8000-000000000000'];
    const inTx = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';

    await conn.query(
      'DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (' + inTx + ') OR subjectId IN (?))',
      [loanIds, agIds],
    );
    await conn.query('DELETE FROM approval_workflows WHERE subjectId IN (' + inTx + ') OR subjectId IN (?)', [loanIds, agIds]);
    await conn.query('DELETE FROM credit_ledger WHERE transactionId IN (' + inTx + ') OR customerId IN (?)', [loanIds, CUSTS]);
    await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [loanIds]);
    await conn.query('DELETE FROM financial_transaction_lines WHERE transactionId IN (SELECT id FROM financial_transactions WHERE loanId IN (?))', [loanIds]);
    await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [loanIds]);
    await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [loanIds]);
    await conn.query('DELETE FROM settlement_agreements WHERE id IN (?)', [agIds]);
    await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [CUSTS]);
    await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?) OR userId IN (?)', [loanIds, userIds]);
    await conn.query('DELETE FROM audit_logs WHERE loanId IN (?) OR transactionId IN (' + inTx + ') OR userId IN (?)', [loanIds, loanIds, userIds]);
    await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [userIds]);
    await conn.query('DELETE FROM user_avatar_contents WHERE avatarId IN (SELECT id FROM user_avatars WHERE userId IN (?))', [userIds]);
    await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [userIds]);
    await conn.query('DELETE FROM users WHERE id IN (?)', [userIds]);
    await conn.query('DELETE FROM loans WHERE id IN (?)', [loanIds]);
  };

  // --------------------------------------------------------------------- fixtures over HTTP
  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const flat = products.find((p) => p.code === 'TST-FLAT-M6');

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const txLines = (id) =>
    rows(conn, 'SELECT component, CAST(amount AS CHAR) amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [id]);

  async function newLoan({ customerId, principal, disbursedAt, label }) {
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: {
        customerId,
        productId: flat.id,
        principalAmount: principal,
        termValue: flat.termValue,
        termUnit: flat.termUnit,
        disbursedAt,
      },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    createdLoans.push(loan.id);
    const interestCents = billedInterestCents({
      principalCents: toCents(principal),
      ratePercent: flat.interestRate,
      rateUnit: flat.interestRatePeriod,
      termValue: flat.termValue,
      termUnit: flat.termUnit,
    });
    states.set(loan.id, {
      id: loan.id,
      customerId,
      principalCents: toCents(principal),
      components: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: toCents(principal) },
      status: 'ACTIVE',
      history: [],
    });
    return { id: loan.id, loanNumber: loan.loanNumber, label, principal };
  }

  /** Compares one loan's live outstanding with the oracle state (only the events that should have landed). */
  const compareToOracle = async (loan, note = '') => {
    const st = states.get(loan.id);
    const after = await loanView(loan.id);
    const got = outstandingOf(after ?? {});
    ok(
      `${loan.label}: ยอดคงค้างจริง = oracle ทุกทศนิยม (race ไม่ทำให้เงินงอกหรือหาย)`,
      COMPS.every((c) => got[c] === st.components[c]) && sameMoney(after?.outstanding?.total, toLak(totalOf(st.components))),
      {
        input: `GET /api/loans/${loan.loanNumber}`,
        expected: COMPS.map((c) => `${c}=${fmt(st.components[c])}`).join(' ') + ` total ${fmt(totalOf(st.components))}`,
        actual: COMPS.map((c) => `${c}=${fmt(got[c])}`).join(' ') + ` total ${fmt(sumMoney(got))}` + (note ? ` | ${note}` : ''),
      },
    );
  };

  const createReq = (body, token = tokens.op1) => api('POST', '/api/payment-requests', { token, body });
  const approveReq = (id, body = {}, token = tokens.checker1) => api('POST', `/api/payment-requests/${id}/approve`, { token, body });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });
  const levelToken = { CHECKER: tokens.checker1, HEAD: tokens.head, ADMIN: tokens.admin };
  const findStep = async (subjectId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=200', { token });
    return (pending.json.data ?? []).find((i) => i.subjectId === subjectId) ?? null;
  };
  const decide = (stepId, token, body) => api('POST', `/api/approvals/steps/${stepId}/decision`, { token, body });
  const workflowRow = (subjectId) =>
    rows(
      conn,
      'SELECT id, CAST(currentLevelIndex AS CHAR) idx, requiredLevels, status FROM approval_workflows WHERE subjectId=? ORDER BY createdAt DESC LIMIT 1',
      [subjectId],
    ).then((r) => r[0] ?? null);
  const auditCount = (action, where, params) =>
    rows(conn, `SELECT COUNT(*) n FROM audit_logs WHERE action=? AND ${where}`, [action, ...params]).then((r) => Number(r[0].n));

  /** maker -> checker; returns the APPROVED transaction id (deliberately not posted). */
  async function approvedPaymentTx(loan, { cash = 0, credit = 0, purpose, checker = tokens.checker1 } = {}) {
    const made = await createReq({
      loanId: loan.id,
      cashAmount: cash,
      ...(purpose ? { purpose } : {}),
      ...(credit ? { creditToApply: credit } : {}),
    });
    if (made.status !== 201) throw new Error(`create request failed ${made.status} ${errorMessage(made)}`);
    const request = made.json.data.request;
    createdRequests.push(request.id);
    const approved = await approveReq(request.id, {}, checker);
    if (approved.status !== 200) throw new Error(`approve failed ${approved.status} ${errorMessage(approved)}`);
    const txId = approved.json.data.transaction.id;
    createdTx.push(txId);
    return { request, txId, approved };
  }

  /** create (+ optionally walk the approval levels) -> a draft transaction, no posting. */
  async function pendingDraft(path, body, { stopAfterLevel = 'ADMIN' } = {}) {
    const made = await api('POST', path, { token: tokens.op1, body });
    if (made.status !== 201) return { made };
    const txId = made.json.data.transaction.id;
    createdTx.push(txId);
    if (stopAfterLevel === 'NONE') return { made, txId, trail: [] };
    const trail = [];
    for (const level of LEVELS) {
      const item = await findStep(txId, levelToken[level]);
      if (!item) break;
      const res = await decide(item.stepId, levelToken[level], { decision: 'APPROVE' });
      trail.push({ level, stepId: item.stepId, status: res.status, workflow: res.json?.data?.workflow });
      if (res.status !== 200) break;
      if (level === stopAfterLevel) break;
    }
    return { made, txId, trail };
  }

  const creditState = async (customerId) => {
    const ledger = await rows(
      conn,
      'SELECT type, CAST(amount AS CHAR) amount, CAST(balanceAfter AS CHAR) balanceAfter FROM credit_ledger WHERE customerId=? ORDER BY createdAt',
      [customerId],
    );
    const acc = ledger.filter((r) => r.type === 'ACCRUED').reduce((s, r) => s + Number(r.amount), 0);
    const used = ledger.filter((r) => r.type === 'USED').reduce((s, r) => s + Number(r.amount), 0);
    const bal = Number((await rows(conn, 'SELECT CAST(balance AS CHAR) b FROM customer_credits WHERE customerId=?', [customerId]))[0]?.b ?? 0);
    return { ledger, acc, used, bal };
  };

  // --------------------------------------------------------------------- reset-secret helpers
  const openOutbox = async (userId, type) => {
    const rs = await rows(conn, 'SELECT payload FROM notification_outbox WHERE type=? AND userId=? ORDER BY createdAt DESC LIMIT 1', [type, userId]);
    if (!rs.length) return null;
    let payload = {};
    try {
      payload = JSON.parse(unseal(String(rs[0].payload)));
    } catch {
      payload = {};
    }
    return payload;
  };
  const resetRows = (userId, kind) =>
    rows(
      conn,
      `SELECT id, CAST(attempts AS CHAR) attempts, usedAt, CAST(createdAt AS CHAR) createdAt FROM password_reset_tokens
       WHERE userId=? ${kind ? `AND kind='${kind}'` : ''} ORDER BY createdAt DESC`,
      [userId],
    );
  /** Clears the 60s per-account cooldown and the per-IP throttle for this tester's address. */
  const ageResetRows = async (userId) => {
    await conn.query(
      'UPDATE password_reset_tokens SET createdAt = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE userId=? AND createdAt > DATE_SUB(NOW(), INTERVAL 20 MINUTE)',
      [userId],
    );
    const ip = (await rows(conn, 'SELECT requestedIp ip FROM password_reset_tokens ORDER BY createdAt DESC LIMIT 1'))[0]?.ip;
    if (ip) {
      await conn.query(
        'UPDATE password_reset_tokens SET createdAt = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE requestedIp=? AND createdAt > DATE_SUB(NOW(), INTERVAL 20 MINUTE)',
        [ip],
      );
    }
  };

  try {
    // ==================================================================== fixtures
    const LP = await newLoan({ customerId: C6, principal: 3000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LP' });
    const LC1 = await newLoan({ customerId: C5, principal: 1000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LC1' });
    const LC2 = await newLoan({ customerId: C5, principal: 1000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LC2' });
    const LC3 = await newLoan({ customerId: C5, principal: 1000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LC3' });
    // Principal is deliberately large: this loan only feeds the double-decision race below, whose
    // penalty has to stay under the product ceiling (30% of principal) so the guard itself is not
    // what the case is testing.
    const LA = await newLoan({ customerId: C7, principal: 20000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LA' });
    const LS = await newLoan({ customerId: C8, principal: 1500000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'LS' });

    const th = await thresholdsNow();
    ok(
      'fixture: สร้างเงินกู้ 6 ฉบับสำหรับแข่งยิง + อ่าน threshold ที่ใช้งานจริงมาคำนวณระดับอนุมัติ',
      [LP, LC1, LC2, LC3, LA, LS].every((l) => l.id) && Number(th.checkerThreshold) > 0 && Number(th.headThreshold) >= Number(th.checkerThreshold),
      {
        input: `checker=${th.checkerThreshold} head=${th.headThreshold}`,
        expected: 'ทุก loan สร้างสำเร็จ (ACTIVE, DISBURSEMENT โพสต์แล้ว) และ head >= checker',
        actual: `${createdLoans.length} loans / checker ${th.checkerThreshold} head ${th.headThreshold}`,
        note: 'ใช้ผลิตภัณฑ์ TST-FLAT-M6 ลูกค้า C5-C8 (KYC VERIFIED จาก seed) จึงออกกู้ได้ทันที',
      },
    );

    // ==================================================================== A. same APPROVED tx posted 4x
    const A = await approvedPaymentTx(LP, { cash: 500000 });
    const aPosts = await race(4, () => postTx(A.txId));
    ok('A: โพสต์ transaction APPROVED เดียวพร้อมกัน 4 ครั้ง — สำเร็จครั้งเดียว ที่เหลือ 4xx (มี loan+tx lock)',
      winsOf(aPosts) === 1 && aPosts.filter(is4xx).length === 3, {
        input: 'Promise.all x4 POST /api/transactions/:id/post (admin)',
        expected: '2xx=1 และอีก 3 เป็น 4xx',
        actual: `2xx=${winsOf(aPosts)} codes=${codesOf(aPosts)} ${errorMessage(aPosts.find((r) => !is2xx(r)) ?? aPosts[0]).slice(0, 90)}`,
        note: 'posting-engine.service.ts:322-334 เขียน lock ทั้ง transaction และ loan ก่อนเช็คสถานะ — จุดนี้ป้องกันได้จริง',
      });
    const aLines = await txLines(A.txId);
    const aTxRow = (await rows(conn, 'SELECT status FROM financial_transactions WHERE id=?', [A.txId]))[0];
    ok('A: ledger lines ของ transaction ที่ถูกโพสต์ซ้ำ 4 ครั้งมีชุดเดียว (allocation ไม่ถูกเขียนทบ)',
      aLines.length >= 1 && aLines.length <= 2 && aTxRow?.status === 'POSTED', {
        input: 'financial_transaction_lines ของ tx ที่โพสต์แข่งกัน',
        expected: '1-2 แถว (500,000 กระจายไป PAST_INTEREST/PAST_PRINCIPAL)',
        actual: `${aLines.length} แถว: ${aLines.map((r) => `${r.component}=${r.amount}`).join(' ')} / status=${aTxRow?.status}`,
      });
    const aPostedAudit = await auditCount('TRANSACTION_POSTED', 'transactionId=?', [A.txId]);
    ok('A: audit TRANSACTION_POSTED มีแถวเดียวต่อ transaction (trail ไม่ซ้ำ)', aPostedAudit === 1, {
      input: 'COUNT audit_logs TRANSACTION_POSTED',
      expected: '1',
      actual: `${aPostedAudit}`,
    });
    postEvent(states.get(LP.id), { type: 'PAYMENT', amountCents: toCents(500000), creditAppliedCents: 0 });
    await compareToOracle(LP, 'payment 500,000 โพสต์ครั้งเดียว');

    // ==================================================================== B. same PENDING request approved 3x
    const bMade = await createReq({ loanId: LP.id, cashAmount: 300000 });
    const bId = bMade.json.data.request.id;
    createdRequests.push(bId);
    const bApproves = await race(3, () => approveReq(bId, {}, tokens.checker1));
    ok('B: approve payment request PENDING เดียวพร้อมกัน 3 ครั้ง — สำเร็จครั้งเดียว (request row ถูก write-lock)',
      winsOf(bApproves) === 1 && bApproves.filter(is4xx).length === 2, {
        input: 'Promise.all x3 POST /api/payment-requests/:id/approve',
        expected: '2xx=1 อีก 2 เป็น 4xx "Request is already APPROVED"',
        actual: `2xx=${winsOf(bApproves)} codes=${codesOf(bApproves)}`,
        note: 'payment-requests.router.ts:233-239 lock แถว request แบบ pessimistic_write ก่อนเช็ค status',
      });
    const bTxCount = Number((await rows(conn, 'SELECT COUNT(*) n FROM financial_transactions WHERE sourceRequestId=?', [bId]))[0]?.n ?? -1);
    ok('B: ไม่เกิด transaction ซ้ำจาก request เดียว (เงินไม่ถูกบันทึกลง ledger สองรอบ)', bTxCount === 1, {
      input: 'COUNT financial_transactions WHERE sourceRequestId = request ที่ approve พร้อมกัน 3 ครั้ง',
      expected: '1',
      actual: `${bTxCount} transactions`,
    });
    const bReqRow = (await rows(conn, 'SELECT status, approvedBy FROM payment_requests WHERE id=?', [bId]))[0];
    const bApprovedAudit = await auditCount('PAYMENT_REQUEST_APPROVED', 'sourceRequestId=?', [bId]);
    ok('B: request จบที่ APPROVED ครั้งเดียว + audit PAYMENT_REQUEST_APPROVED 1 แถว',
      bReqRow?.status === 'APPROVED' && bApprovedAudit === 1, {
        input: 'payment_requests.status + COUNT audit',
        expected: 'APPROVED / 1 แถว',
        actual: `${bReqRow?.status} approvedBy=${bReqRow?.approvedBy ? 'set' : 'null'} audit=${bApprovedAudit}`,
      });
    const bTxId = (await rows(conn, 'SELECT id FROM financial_transactions WHERE sourceRequestId=?', [bId]))[0]?.id;
    if (bTxId) createdTx.push(bTxId);

    // ==================================================================== C. two checkers decide the SAME step
    const penAmount = Math.max(1100000, Math.min(5000000, Number(th.checkerThreshold) * 5));
    const cDraft = await pendingDraft('/api/transactions/penalties', { loanId: LA.id, amount: penAmount, reason: 'race: ค่าปรับที่ Checker สองคนกดพร้อมกัน' }, { stopAfterLevel: 'NONE' });
    const cStep = await findStep(cDraft.txId, tokens.checker1);
    const cRace = await Promise.all([
      decide(cStep?.stepId, tokens.checker1, { decision: 'APPROVE' }),
      decide(cStep?.stepId, tokens.checker2, { decision: 'APPROVE' }),
    ]);
    ok('F-CONC-3: Checker สองคนอนุมัติ approval step เดียวกันพร้อมกัน — ต้องมีผู้ชนะคนเดียว', winsOf(cRace) === 1, {
      input: `penalty ${fmt(toCents(penAmount))} (ระดับ CHECKER -> HEAD) แล้ว POST /api/approvals/steps/${cStep?.stepId}/decision x2 (checker1, checker2)`,
      expected: '2xx=1 และอีกครั้ง 409 "This approval step has already been decided"',
      actual: `2xx=${winsOf(cRace)} codes=${codesOf(cRace)} ${errorMessage(cRace.find((r) => !is2xx(r)) ?? cRace[0]).slice(0, 90)}`,
      note: 'approval.service.ts:132-143 อ่าน step/workflow โดยไม่มี lock — ถ้าผ่านทั้งคู่ ระดับ HEAD อาจถูกข้าม (ตรวจ case ถัดไป)',
    });
    const cWf = await workflowRow(cDraft.txId);
    ok('C: workflow ไม่ข้ามระดับ — currentLevelIndex เพิ่มครั้งเดียวและยังไม่ APPROVED',
      Number(cWf?.idx) === 1 && cWf?.status === 'PENDING', {
        input: 'approval_workflows ของ penalty ที่ถูกกดซ้ำ',
        expected: 'idx=1 (ยังต้องรอ HEAD), status=PENDING',
        actual: `idx=${cWf?.idx} required=${cWf?.requiredLevels} status=${cWf?.status}`,
      });
    const cStepAudit = await auditCount('APPROVAL_STEP_APPROVED', 'transactionId=?', [cDraft.txId]);
    ok('C: หลักฐานการอนุมัติระดับ CHECKER มีครั้งเดียวใน audit trail', cStepAudit <= 1, {
      input: 'COUNT audit APPROVAL_STEP_APPROVED ของ transaction ที่กดซ้ำพร้อมกัน',
      expected: '<= 1',
      actual: `${cStepAudit} แถว`,
    });
    const cEarlyPost = await postTx(cDraft.txId);
    ok('C: ยังโพสต์ไม่ได้ถ้า HEAD ไม่ได้ approve (ลำดับชั้นอนุมัติยังบังคับจริงหลัง race)', is4xx(cEarlyPost), {
      input: 'POST /transactions/:id/post หลัง race ที่ระดับ CHECKER',
      expected: '4xx (transaction ยัง PENDING_APPROVAL)',
      actual: `${cEarlyPost.status} ${errorMessage(cEarlyPost).slice(0, 90)}`,
    });
    const cHeadStep = await findStep(cDraft.txId, tokens.head);
    const cHead = await decide(cHeadStep?.stepId, tokens.head, { decision: 'APPROVE' });
    const cPost = await postTx(cDraft.txId);
    postEvent(states.get(LA.id), { type: 'PENALTY', amountCents: toCents(penAmount) });
    ok('C: หลัง HEAD approve ตามทางเดินจริงจึงโพสต์ได้ และค่าปรับเข้าบัญชีครั้งเดียว',
      cHead.status === 200 && is2xx(cPost) && Number((await workflowRow(cDraft.txId))?.idx) === 1, {
        input: 'HEAD decision + POST /transactions/:id/post',
        expected: '200 + 2xx และ idx = 1',
        actual: `head=${cHead.status} post=${cPost.status} idx=${(await workflowRow(cDraft.txId))?.idx}`,
      });
    await compareToOracle(LA, 'penalty เข้าบัญชีครั้งเดียว');

    // ==================================================================== D. one credit balance, two loans, two postings
    const lc1State = states.get(LC1.id);
    const lc1Owed = totalOf(lc1State.components);
    // The gate will not take cash above the instalments that have arrived, so the 400,000 that has to
    // sit in customer credit is brought as a deposit and the payoff then matches the book exactly.
    const dDeposit = await approvedPaymentTx(LC1, { cash: 400000, purpose: 'DEPOSIT_TO_CREDIT' });
    const dDepositPosted = await postTx(dDeposit.txId);
    const lc1AfterDeposit = outstandingOf((await loanView(LC1.id)) ?? {});
    const dCreditRow = (await rows(conn, 'SELECT CAST(balance AS CHAR) b FROM customer_credits WHERE customerId=?', [C5]))[0];
    ok('D fixture: ฝาก 400,000 เป็น deposit -> credit คงเหลือ 400,000 ส่วนหนี้ LC1 ไม่ขยับ',
      is2xx(dDepositPosted) && sameMoney(dCreditRow?.b ?? -1, 400000) && COMPS.every((c) => lc1AfterDeposit[c] === lc1State.components[c]), {
        input: `cash 400000.00 purpose DEPOSIT_TO_CREDIT บนยอดค้าง ${fmt(lc1Owed)}`,
        expected: 'customer_credits.balance = 400000.00 และ outstanding เท่า oracle',
        actual: `post=${dDepositPosted.status} balance=${dCreditRow?.b} outstanding=${COMPS.map((c) => fmt(lc1AfterDeposit[c])).join(',')}`,
      });
    const dOver = await approvedPaymentTx(LC1, { cash: toLak(lc1Owed) });
    const dOverPosted = await postTx(dOver.txId);
    postEvent(lc1State, { type: 'PAYMENT', amountCents: lc1Owed, creditAppliedCents: 0 });
    const lc1Closed = await loanView(LC1.id);
    const dCreditAfterPayoff = (await rows(conn, 'SELECT CAST(balance AS CHAR) b FROM customer_credits WHERE customerId=?', [C5]))[0];
    ok('D fixture: จ่ายปิด LC1 พอดีทุกส่วน -> CLOSED และ credit 400,000 ยังอยู่ (ไม่ถูกดึงไปปิดหนี้เอง)',
      is2xx(dOverPosted) && lc1Closed?.status === 'CLOSED' && sameMoney(dCreditAfterPayoff?.b ?? -1, 400000), {
        input: `cash ${fmt(lc1Owed)} บนยอดค้าง ${fmt(lc1Owed)}`,
        expected: 'status CLOSED + balance 400000.00',
        actual: `post=${dOverPosted.status} loan=${lc1Closed?.status} balance=${dCreditAfterPayoff?.b}`,
      });

    const dR1 = await createReq({ loanId: LC2.id, cashAmount: 0, creditToApply: 400000 });
    const dR2 = await createReq({ loanId: LC3.id, cashAmount: 0, creditToApply: 400000 });
    [dR1, dR2].forEach((r) => r.json?.data?.request?.id && createdRequests.push(r.json.data.request.id));
    ok('D: ตอนสร้างคำขอ ระบบยอมรับให้ใช้ credit 400,000 ซ้ำสองรอบ (ไม่มีการกันวงเงิน)',
      winsOf([dR1, dR2]) === 2, {
        input: 'POST /api/payment-requests x2 (คนละ loan, ลูกค้าเดียวกัน) creditToApply 400,000 เท่ากัน',
        expected: '201 ทั้งคู่ (ตอนสร้างยังไม่มีใครใช้ credit) — ต้นเหตุของ race',
        actual: `codes=${codesOf([dR1, dR2])}`,
        note: 'payment-requests.router.ts:88 อ่าน CustomerCredit แบบไม่มี lock และไม่มี reservation ของวงเงิน',
      });
    const dA1 = await approveReq(dR1.json.data.request.id, {}, tokens.checker1);
    const dA2 = await approveReq(dR2.json.data.request.id, {}, tokens.checker1);
    const dTx1 = dA1.json?.data?.transaction?.id;
    const dTx2 = dA2.json?.data?.transaction?.id;
    [dTx1, dTx2].forEach((t) => t && createdTx.push(t));
    const dPosts = await Promise.all([postTx(dTx1), postTx(dTx2)]);
    ok('F-CONC-1: ใช้ credit 400,000 บนเงินกู้ 2 ฉบับพร้อมกัน — ต้องมีอย่างน้อยหนึ่งครั้งที่ถูกปฏิเสธ',
      winsOf(dPosts) <= 1, {
        input: `Promise.all POST /transactions/:id/post x2 (approve codes=${dA1.status}/${dA2.status})`,
        expected: '2xx <= 1 (ครั้งถัดไปต้อง 422 Insufficient customer credit)',
        actual: `2xx=${winsOf(dPosts)} codes=${codesOf(dPosts)} ${errorMessage(dPosts.find((r) => !is2xx(r)) ?? dPosts[0]).slice(0, 90)}`,
        note: 'posting-engine.service.ts:198-207 อ่าน/ปรับ credit โดย lock เฉพาะ loan ของตัวเอง (คนละแถว) -> แถว CustomerCredit ไม่มี lock',
      });
    const dFinal = await creditState(C5);
    ok('F-CONC-1: บัญชี credit ปิดยอด — ACCRUED - USED ต้องเท่ากับ balance ที่เก็บไว้',
      Math.abs(dFinal.acc - dFinal.used - dFinal.bal) < 0.005, {
        input: 'SUM(credit_ledger ACCRUED/USED) vs customer_credits.balance ของ C5',
        expected: `${fmt(toCents(dFinal.acc - dFinal.used))} = balance`,
        actual: `accrued=${fmt(toCents(dFinal.acc))} used=${fmt(toCents(dFinal.used))} balance=${fmt(toCents(dFinal.bal))} ledger=${JSON.stringify(
          dFinal.ledger.map((r) => [r.type, r.amount, r.balanceAfter]),
        ).slice(0, 160)}`,
      });
    ok('F-CONC-1: ยอด credit ที่ใช้รวม (USED) ต้องไม่เกิน 400,000 ที่มีอยู่จริง (เงินไม่ถูกเสกขึ้น)',
      dFinal.used <= 400000.005, {
        input: 'SUM(amount) ของ credit_ledger type=USED',
        expected: '<= 400000.00',
        actual: `${fmt(toCents(dFinal.used))}`,
      });
    ok('D: balance ของลูกค้าไม่ติดลบ (invariant ที่ล็อกไว้)', dFinal.bal >= -0.005, {
      input: 'customer_credits.balance',
      expected: '>= 0',
      actual: `${fmt(toCents(dFinal.bal))}`,
    });
    // only the first successful post may move money; a second winner must not change any balance
    const dWinner = dPosts.findIndex(is2xx);
    if (dWinner >= 0) {
      postEvent(states.get(dWinner === 0 ? LC2.id : LC3.id), { type: 'PAYMENT', amountCents: 0, creditAppliedCents: toCents(400000) });
    }
    await compareToOracle(LC2, 'credit บน LC2');
    await compareToOracle(LC3, 'credit บน LC3');

    // ==================================================================== E. two full reversals of one payment
    const E = await approvedPaymentTx(LP, { cash: 600000 });
    const ePosted = await postTx(E.txId);
    ok('E fixture: โพสต์ payment 600,000 ของต้นทางที่จะถูกกลับรายการ (ต้อง POSTED reversal ถึงสร้างได้)',
      is2xx(ePosted), {
        input: 'POST /api/transactions/:id/post ของ payment ที่ approve แล้ว',
        expected: '2xx + สถานะ POSTED',
        actual: `${ePosted.status} ${errorMessage(ePosted).slice(0, 90)}`,
      });
    if (is2xx(ePosted)) postEvent(states.get(LP.id), { type: 'PAYMENT', amountCents: toCents(600000), creditAppliedCents: 0 });
    await compareToOracle(LP, 'payment 600,000 โพสต์ปกติ');
    const eOriginalLines = await txLines(E.txId);
    const eOriginalAllocation = Object.fromEntries(eOriginalLines.map((r) => [r.component, Math.abs(cent(r.amount))]));
    const eCreates = await race(2, () =>
      api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: E.txId, amount: 600000, reason: 'race: กลับรายการทั้งจำนวนซ้ำ' } }),
    );
    const eParallel = eCreates.filter(is2xx).map((r) => r.json.data.transaction.id);
    eParallel.forEach((t) => createdTx.push(t));
    ok('F-CONC-OBS-2: ยิงสร้างคำขอกลับรายการทั้งจำนวนพร้อมกัน 2 ครั้ง — อีกครั้งล้มเหลวด้วย 409 (ชนเลข referenceNo ไม่ใช่การกันยอด)',
      winsOf(eCreates) === 1 && eCreates.some((r) => r.status === 409), {
        input: 'Promise.all x2 POST /api/transactions/reversals amount=600,000 (ทั้งจำนวนของต้นทาง)',
        expected: '2xx=1 + อีกครั้ง 409 "That record already exists"',
        actual: `2xx=${winsOf(eCreates)} codes=${codesOf(eCreates)} ${errorMessage(eCreates.find((r) => !is2xx(r)) ?? eCreates[0]).slice(0, 70)}`,
        note: 'reference.service.ts:14-15 นับแถว+1 แล้วผูก unique index — race นี้ถูกบังไว้โดยบังเอิญ จึงต้องพิสูจน์ต่อด้วยลำดับถัดไป',
      });

    const eSecond = await api('POST', '/api/transactions/reversals', {
      token: tokens.op1,
      body: { referenceTransactionId: E.txId, amount: 600000, reason: 'race: กลับรายการทั้งจำนวนซ้ำครั้งที่สอง (ยิงตามหลัง)' },
    });
    if (eSecond.status === 201) createdTx.push(eSecond.json.data.transaction.id);
    ok('E: ระบบยอมให้สร้าง reversal ทั้งจำนวนอีกฉบับ ทั้งที่มี draft 600,000 ค้างอยู่ (นับเฉพาะยอดที่ POSTED)',
      eSecond.status === 201, {
        input: `POST /api/transactions/reversals amount=600,000 ตามหลังคำขอแรก (${codesOf(eCreates)})`,
        expected: 'จะถูกต้องกว่าถ้าตอบ 422 เพราะยอดถูก draft ค้างไว้เต็มจำนวนแล้ว',
        actual: `${eSecond.status} ${errorMessage(eSecond).slice(0, 70)}`,
        note: 'transactions.router.ts:283 alreadyReversedComponents นับเฉพาะสถานะ POSTED',
      });

    const eDraftIds = [...eParallel, ...(eSecond.status === 201 ? [eSecond.json.data.transaction.id] : [])];
    for (const [i, txId] of eDraftIds.entries()) {
      const item = await findStep(txId, levelToken.CHECKER);
      if (item) await decide(item.stepId, i === 0 ? tokens.checker1 : tokens.checker2, { decision: 'APPROVE' });
    }
    const ePosts = await Promise.all(eDraftIds.map((txId) => postTx(txId)));
    ok('E: reversal ทั้งจำนวนของ payment เดียวถูกโพสต์พร้อมกัน — สำเร็จครั้งเดียว (จุดนี้ระบบป้องกันได้จริง)',
      winsOf(ePosts) <= 1, {
        input: `POST /transactions/:id/post x${eDraftIds.length} สำหรับ reversal ที่อนุมัติแล้ว codes=${codesOf(ePosts)}`,
        expected: '2xx <= 1 (ฉบับที่สองต้อง 422 เพราะยอด reversible หมดแล้ว)',
        actual: `2xx=${winsOf(ePosts)} codes=${codesOf(ePosts)}`,
        note: 'posting-engine lock แถว loan แบบ pessimistic_write ก่อนตรวจยอด reversible -> ฉบับที่สองเห็น reversal ที่ POSTED แล้วจึงถูกปฏิเสธ (ต่างจาก F-CONC-1/F-CONC-5 ที่แถวที่ต้อง lock เป็นแถวคนละตัว)',
      });
    const eReversedSum = Number(
      (
        await rows(
          conn,
          `SELECT COALESCE(SUM(ABS(l.amount)),0) s FROM financial_transactions t
           JOIN financial_transaction_lines l ON l.transactionId = t.id
           WHERE t.referenceTransactionId=? AND t.transactionType='PAYMENT_REVERSAL' AND t.status='POSTED'`,
          [E.txId],
        )
      )[0]?.s ?? 0,
    );
    ok('E: ยอดรวมที่กลับรายการ (POSTED) ต้องไม่เกิน 600,000 ของรายการต้นทาง', eReversedSum <= 600000.005, {
      input: 'SUM |lines| ของ PAYMENT_REVERSAL ที่ POSTED ซึ่งอ้างถึง payment เดียว',
      expected: '<= 600000.00',
      actual: `${fmt(toCents(eReversedSum))} (ต้นทาง 600000.00)`,
    });
    if (ePosts.length && is2xx(ePosts[0])) {
      postEvent(states.get(LP.id), { type: 'PAYMENT_REVERSAL', amountCents: toCents(600000), originalAllocation: eOriginalAllocation });
    }
    await compareToOracle(LP, 'reversal กระทบยอดคงค้างครั้งเดียว');

    // ==================================================================== F. OTP / reset link races
    const pwUser = await api('POST', '/api/users', {
      token: tokens.admin,
      body: {
        username: `tst_cj_${RUN_TAG}_pw`,
        password: PASSWORD,
        fullName: 'Race Reset User',
        email: `tst_cj_${RUN_TAG}_pw@test.local`,
        role: 'VIEWER',
      },
    });
    const pwId = pwUser.json?.user?.id;
    const pwName = pwUser.json?.user?.username;
    if (pwId) createdUsers.push(pwUser.json.user);
    const pwEmail = `tst_cj_${RUN_TAG}_pw@test.local`;
    const fIssue = await api('POST', '/api/auth/forgot-password', { token: null, body: { email: pwEmail } });
    await settle(600);
    const fOtp = (await openOutbox(pwId, 'PASSWORD_RESET_OTP'))?.otp;
    ok('F fixture: ขอ OTP ผ่าน forgot-password แล้วอ่านรหัสจาก outbox แบบซีลได้',
      pwUser.status === 201 && fIssue.status === 202 && /^\d{6}$/.test(String(fOtp ?? '')), {
        input: `POST /api/users (${pwName}) แล้ว POST /api/auth/forgot-password`,
        expected: '201 + 202 + outbox PASSWORD_RESET_OTP มี otp 6 หลัก',
        actual: `user=${pwUser.status} issue=${fIssue.status} otp=${fOtp ? 'found' : 'missing'}`,
      });
    const fVerify = await race(3, () => api('POST', '/api/auth/verify-otp', { token: null, body: { email: pwEmail, otp: fOtp } }));
    const fVerifyWins = winsOf(fVerify);
    ok('F-CONC-4: OTP เดียวถูกนำไป verify พร้อมกัน 3 ครั้ง — ต้องแลก reset link ได้ครั้งเดียว (single use)',
      !!fOtp && fVerifyWins <= 1, {
        input: 'Promise.all x3 POST /api/auth/verify-otp ด้วยรหัสที่ถูก',
        expected: '2xx <= 1',
        actual: `2xx=${fVerifyWins} codes=${codesOf(fVerify)}`,
        note: 'auth.router.ts:145 อ่าน secret ด้วย ds.manager (นอก transaction) แล้วค่อย consumeSecret ที่ :161 -> ทุก request เห็น usedAt=NULL',
      });
    const fLinkRows = await resetRows(pwId, 'LINK');
    ok('F: จำนวนแถว LINK ที่เกิดจากการ verify พร้อมกัน เท่ากับจำนวนครั้งที่ระบบตอบ 200', fLinkRows.length === fVerifyWins, {
      input: 'password_reset_tokens kind=LINK ของบัญชีทดสอบ',
      expected: `${fVerifyWins} แถว`,
      actual: `${fLinkRows.length} แถว`,
    });
    const fReplay = await api('POST', '/api/auth/verify-otp', { token: null, body: { email: pwEmail, otp: fOtp } });
    ok('F: ใช้ OTP เดียวซ้ำแบบตามหลัง (ไม่ใช่พร้อมกัน) ถูกปฏิเสธ 400', is4xx(fReplay), {
      input: 'verify-otp ด้วยรหัสเดิมหลัง burst',
      expected: '400 Invalid or expired verification code',
      actual: `${fReplay.status} ${errorMessage(fReplay).slice(0, 80)}`,
    });

    await ageResetRows(pwId);
    await api('POST', '/api/auth/forgot-password', { token: null, body: { email: pwEmail } });
    await settle(600);
    const fOtp2 = (await openOutbox(pwId, 'PASSWORD_RESET_OTP'))?.otp;
    const badGuess = fOtp2 === '000000' ? '000001' : '000000';
    const fBad = await race(8, () => api('POST', '/api/auth/verify-otp', { token: null, body: { email: pwEmail, otp: badGuess } }));
    const fBadAccepted = fBad.filter((r) => r.status === 400).length;
    const fBadThrottled = fBad.filter((r) => r.status === 429).length;
    const fRow2 = (await resetRows(pwId, 'OTP'))[0];
    ok('F-CONC-4: การเดารหัสผิดพร้อมกัน 8 ครั้งต้องถูกนับครบและ burn ภายใน 5 ครั้ง',
      !!fOtp2 && Number(fRow2?.attempts ?? 0) >= Math.min(fBadAccepted, OTP_MAX) && (fBadAccepted < OTP_MAX || !!fRow2?.usedAt), {
        input: `Promise.all x8 verify-otp ด้วยรหัสผิด (400=${fBadAccepted}, 429=${fBadThrottled})`,
        expected: `attempts >= ${Math.min(fBadAccepted, OTP_MAX)}${fBadAccepted >= OTP_MAX ? ' และแถวถูก burn (usedAt != NULL)' : ''}`,
        actual: `attempts=${fRow2?.attempts} usedAt=${fRow2?.usedAt ? 'set' : 'NULL'}`,
        note: 'password-reset.service.ts:111 row.attempts += 1 แล้ว save ด้วย ds.manager (ไม่มี transaction/lock) -> lost update',
      });
    const fAfterBurn = await api('POST', '/api/auth/verify-otp', { token: null, body: { email: pwEmail, otp: fOtp2 } });
    ok('F-CONC-4: หลังเดารหัสผิดครบ 5 ครั้ง OTP ต้องใช้ไม่ได้แม้ใส่รหัสที่ถูก', is4xx(fAfterBurn), {
      input: 'verify-otp ด้วยรหัสที่ถูกหลัง burst ของรหัสผิด',
      expected: '400 (ถูก burn แล้ว)',
      actual: `${fAfterBurn.status} ${errorMessage(fAfterBurn).slice(0, 80)}`,
      note: 'ถ้าตอบ 2xx แปลว่าขอบเขต brute-force กว้างกว่ากติกา 5 ครั้งที่ล็อกไว้',
    });

    await ageResetRows(pwId);
    await api('POST', '/api/auth/forgot-password', { token: null, body: { email: pwEmail } });
    await settle(600);
    const fOtp3 = (await openOutbox(pwId, 'PASSWORD_RESET_OTP'))?.otp;
    const fVerified = await api('POST', '/api/auth/verify-otp', { token: null, body: { email: pwEmail, otp: fOtp3 } });
    const fToken = String(fVerified.json?.resetUrl ?? '').split('token=').pop();
    const PW_A = 'Race@2026aaa';
    const PW_B = 'Race@2026bbb';
    const fReset = await Promise.all([
      api('POST', '/api/auth/reset-password', { token: null, body: { token: fToken, password: PW_A } }),
      api('POST', '/api/auth/reset-password', { token: null, body: { token: fToken, password: PW_B } }),
    ]);
    ok('F-CONC-4: reset link ใช้ครั้งเดียว — ส่ง 2 รหัสผ่านต่างกันไปพร้อมกันต้องมีผู้ชนะคนเดียว',
      !!fToken && winsOf(fReset) <= 1, {
        input: 'Promise.all x2 POST /api/auth/reset-password ด้วย link เดียว (password ต่างกัน)',
        expected: '2xx <= 1',
        actual: `2xx=${winsOf(fReset)} codes=${codesOf(fReset)}`,
        note: 'auth.router.ts:212 findActiveSecret อ่านนอก transaction -> ผ่านทั้งคู่แล้วเขียน passwordHash ทับกัน',
      });
    const loginA = await login(pwName ?? 'none', PW_A);
    const loginB = await login(pwName ?? 'none', PW_B);
    ok('F: รหัสผ่านที่ระบบ "ยืนยันว่าตั้งสำเร็จ" ต้องเป็นรหัสที่ login ได้จริง',
      !is2xx(fReset[0]) || !is2xx(fReset[1]) ? (is2xx(fReset[0]) ? is2xx(loginA) && !is2xx(loginB) : is2xx(loginB)) : false,
      {
        input: `POST /api/auth/login x2 (A=${loginA.status}, B=${loginB.status}) หลัง race reset`,
        expected: 'รหัสจากรายการที่ตอบ 200 เท่านั้นที่ login ผ่าน',
        actual: `reset codes=${codesOf(fReset)} loginA=${loginA.status} loginB=${loginB.status}`,
      });

    // ==================================================================== G. settlement agreement paid twice
    const gAg = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: LS.id, agreedAmount: 300000, reason: 'race: ปิดบัญชีตามข้อตกลง' } });
    const gAgId = gAg.json?.data?.id;
    if (gAgId) createdAgreements.push(gAgId);
    const gStep = await findStep(gAgId, tokens.checker1);
    await decide(gStep?.stepId, tokens.checker1, { decision: 'APPROVE' });
    const gAgRow = (await rows(conn, 'SELECT status, CAST(agreedAmount AS CHAR) a FROM settlement_agreements WHERE id=?', [gAgId]))[0];
    ok('G fixture: ข้อตกลงปิดบัญชี 300,000 ผ่าน approval เป็น APPROVED แล้ว', gAgRow?.status === 'APPROVED', {
      input: 'POST /api/settlements + CHECKER decision',
      expected: 'APPROVED',
      actual: `${gAg.status} -> ${gAgRow?.status} agreed=${gAgRow?.a}`,
    });
    const gPays = await race(2, () => api('POST', `/api/settlements/${gAgId}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 300000 } }));
    const gParallel = gPays.filter(is2xx).map((r) => r.json.data.request.id);
    gParallel.forEach((id) => createdRequests.push(id));
    ok('F-CONC-OBS-1: ยิงสร้างคำขอชำระตามข้อตกลงพร้อมกัน 2 ครั้ง — อีกครั้งล้มเหลวด้วย 409 "That record already exists" (ชนเลข requestNo ไม่ใช่การกันเงิน)',
      winsOf(gPays) === 1 && gPays.some((r) => r.status === 409), {
        input: 'Promise.all x2 POST /api/settlements/:id/settlement-payment cash=300,000',
        expected: '201 หนึ่งครั้ง + 409 หนึ่งครั้ง (numberNo เป็น count+1 แบบไม่มี lock)',
        actual: `codes=${codesOf(gPays)} 2xx=${winsOf(gPays)} ${errorMessage(gPays.find((r) => !is2xx(r)) ?? gPays[0]).slice(0, 70)}`,
        note: 'reference.service.ts:14-15 นับแถว+1 แล้วผูกด้วย unique index — race นี้จึงถูกบังไว้โดยบังเอิญ ต้องพิสูจน์เรื่องเงินด้วยลำดับถัดไป',
      });

    const gSecond = await api('POST', `/api/settlements/${gAgId}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 300000 } });
    if (gSecond.status === 201) createdRequests.push(gSecond.json.data.request.id);
    ok('G: ระบบยอมให้สร้างคำขอชำระตามข้อตกลงเต็มจำนวนอีกคำขอ ทั้งที่มีคำขอ 300,000 ค้างอยู่ (ไม่มีการกันวงเงิน)',
      gSecond.status === 201, {
        input: `POST /api/settlements/:id/settlement-payment cash=300,000 (ตามหลังคำขอแรก ${codesOf(gPays)})`,
        expected: 'จะถูกต้องกว่าถ้าตอบ 422 เพราะยอดที่ขอไปแล้ว = agreedAmount',
        actual: `${gSecond.status} ${errorMessage(gSecond).slice(0, 70)}`,
        note: 'settlement.service.ts:6-23 ตรวจแค่ว่า agreement APPROVED และยอดต่อครั้ง <= agreedAmount',
      });

    const gReqIds = [...gParallel, ...(gSecond.status === 201 ? [gSecond.json.data.request.id] : [])];
    const gTxIds = [];
    for (const id of gReqIds) {
      const ap = await approveReq(id, {}, tokens.checker1);
      if (ap.status === 200) {
        gTxIds.push(ap.json.data.transaction.id);
        createdTx.push(ap.json.data.transaction.id);
      }
    }
    const gPosts = await Promise.all(gTxIds.map((id) => postTx(id)));
    const gPosted = await rows(
      conn,
      `SELECT COALESCE(SUM(amount),0) s, COUNT(*) n FROM financial_transactions
       WHERE settlementAgreementId=? AND transactionType='SETTLEMENT_PAYMENT' AND status='POSTED'`,
      [gAgId],
    );
    ok('F-CONC-5: ยอดที่ POSTED ตามข้อตกลงปิดบัญชีต้อง <= agreedAmount 300,000 (จ่ายซ้ำไม่ได้)',
      Number(gPosted[0]?.s ?? 0) <= 300000.005 && Number(gPosted[0]?.n ?? 0) <= 1, {
        input: `SUM(amount) ของ SETTLEMENT_PAYMENT ที่ POSTED (${gTxIds.length} โพสต์แข่งกัน codes=${codesOf(gPosts)})`,
        expected: '<= 300000.00 และ 1 transaction',
        actual: `${fmt(toCents(Number(gPosted[0]?.s ?? 0)))} จาก ${gPosted[0]?.n} transactions`,
        note: 'settlements.router.ts:170-181 อ่าน agreement/loan นอก transaction ส่วน createPaymentRequestRecord มี lock เฉพาะแถว loan ของตัวเอง',
      });
    if (gPosts.length && is2xx(gPosts[0])) {
      postEvent(states.get(LS.id), { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(300000), creditAppliedCents: 0 });
    }
    await compareToOracle(LS, 'settlement payment กระทบยอดครั้งเดียว');

    // ==================================================================== H. two admins write the thresholds
    const auditIdsBeforeH = new Set((await rows(conn, 'SELECT id FROM audit_logs', [])).map((r) => r.id));
    const hPutA = { checkerThreshold: Number(th.checkerThreshold) + 200000, headThreshold: Number(th.headThreshold) + 200000 };
    const hPutB = { checkerThreshold: Math.max(1, Number(th.checkerThreshold) - 300000), headThreshold: Math.max(2, Number(th.checkerThreshold) - 100000) };
    const hRace = await Promise.all([
      api('PUT', '/api/config/thresholds', { token: tokens.admin, body: hPutA }),
      api('PUT', '/api/config/thresholds', { token: tokens.admin, body: hPutB }),
    ]);
    const hLive = await thresholdsNow();
    ok('H: สอง admin ตั้ง approval threshold พร้อมกัน — ค่าที่ใช้งานจริงต้องยัง head >= checker (race ไม่คงที่: run ใดสลับแถวจะผิดทันที)',
      Number(hLive.headThreshold) >= Number(hLive.checkerThreshold), {
        input: `Promise.all PUT {checker:${hPutA.checkerThreshold}, head:${hPutA.headThreshold}} และ {checker:${hPutB.checkerThreshold}, head:${hPutB.headThreshold}}`,
        expected: 'head >= checker หลัง race',
        actual: `codes=${codesOf(hRace)} live checker=${hLive.checkerThreshold} head=${hLive.headThreshold}`,
        note: 'config.router.ts:58-73 upsert สองแถวโดยไม่มี transaction/lock จึงสลับกันเขียนข้าม request ได้ (มิติเดียวกันกับ F-CFG-2 ใน suite 13)',
      });
    const hConfigAudit = (await rows(conn, "SELECT id FROM audit_logs WHERE action='CONFIG_UPDATED'", [])).filter((r) => !auditIdsBeforeH.has(r.id));
    if (hConfigAudit.length) await conn.query('DELETE FROM audit_logs WHERE id IN (?)', [hConfigAudit.map((r) => r.id)]);
    await restoreThresholds();
    ok('H: คืน threshold ด้วย snapshot แล้ว GET ได้ค่าเดิมเป๊ะ (config กลางไม่เสียหายจาก suite นี้)',
      JSON.stringify(await thresholdsNow()) === fpBefore, {
        input: 'restore จากแถว approval.* ใน system_config',
        expected: fpBefore,
        actual: JSON.stringify(await thresholdsNow()),
      });

    // ==================================================================== I. global integrity after the races
    const negativesNow = await negativeComponentLoans();
    ok('I: ไม่มี loan ใด (รวม 21 สินทรัพย์จาก seed) มียอดคงค้างติดลบหลังจบทุก race',
      negativesNow.length === 0 && negativesBefore === 0, {
        input: 'SELECT loans WHERE outstandingPenalty/PastInterest/PastPrincipal < 0',
        expected: '0 แถว',
        actual: `${negativesNow.length} แถว (ก่อนเริ่ม suite ${negativesBefore})${negativesNow.length ? `: ${JSON.stringify(negativesNow).slice(0, 140)}` : ''}`,
      });
    await purge();
    await settle(1200);
    await purge();

    // purge() deletes by loanId/transactionId/userId; rows such as USER_CREATED carry the acting
    // admin instead of the throwaway account, so the trail is finished off by id differencing.
    const freshAudit = (await rows(conn, 'SELECT id, action, userId, loanId, transactionId FROM audit_logs', [])).filter(
      (r) => !auditIdsBefore.has(r.id),
    );
    const ownActions = [
      'APPROVAL_STEP_APPROVED',
      'APPROVAL_STEP_REJECTED',
      'CONFIG_UPDATED',
      'LOAN_DISBURSED',
      'LOAN_STATUS_CHANGED',
      'PAYMENT_REQUEST_APPROVED',
      'PAYMENT_REQUEST_REJECTED',
      'SETTLEMENT_AGREEMENT_APPROVED',
      'SETTLEMENT_AGREEMENT_CREATED',
      'TRANSACTION_APPROVED',
      'TRANSACTION_CREATED',
      'TRANSACTION_POSTED',
      'USER_CREATED',
      'USER_LOGIN',
      'USER_PASSWORD_RESET',
      'USER_RESET_BURNED',
      'USER_RESET_REQUESTED',
      'USER_RESET_SENT',
      'USER_RESET_VERIFIED',
    ];
    const mine = freshAudit.filter((r) => ownActions.includes(r.action));
    const unexpectedAudit = freshAudit.filter((r) => !mine.includes(r));
    if (mine.length) await conn.query('DELETE FROM audit_logs WHERE id IN (?)', [mine.map((r) => r.id)]);
    ok('I: ลบ audit trail ที่ suite นี้ก่อออกครบ (id differencing) และไม่มี action แปลกปลอมเจือ', mine.length > 0 && unexpectedAudit.length === 0, {
      input: 'id-set differencing บน audit_logs เทียบกับก่อนเริ่ม suite',
      expected: `แถวใหม่ทั้งหมดอยู่ใน ${ownActions.length} actions ของ suite นี้`,
      actual: `new=${freshAudit.length} deleted=${mine.length} unexpected=${unexpectedAudit.length}${
        unexpectedAudit.length ? ` [${unexpectedAudit.map((r) => r.action).join(',')}]` : ''
      }`,
      note: 'audit ของ production ต้องคงไว้ — DB ชุดนี้ถูกล้างก่อนขึ้นจริงอยู่แล้ว suite จึงเก็บแค่หลักว่า trail เดิมไม่เสียหาย',
    });

    const creditDriftAfter = await creditDriftSet();
    ok('I: บัญชี credit ทุกรายปิดยอด (SUM ledger = balance) เท่ากับสถานะก่อนเริ่ม suite', creditDriftAfter === creditDriftBefore, {
      input: 'เทียบ set ของลูกค้าที่ ledger ไม่ตรงกับ balance หลัง purge',
      expected: creditDriftBefore || '(ไม่มี)',
      actual: creditDriftAfter || '(ไม่มี)',
      note: 'ระหว่าง suite เกิด drift จาก F-CONC-1 ชัดเจน (case 017-019) — check นี้ดูแค่่ว่าข้อมูล seed ไม่พังตาม',
    });

    const afterCounts = {};
    for (const t of TABLES) afterCounts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`, []))[0].n);
    const drift = TABLES.filter((t) => afterCounts[t] !== baselineCounts[t]).map((t) => `${t}: ${baselineCounts[t]} -> ${afterCounts[t]}`);
    ok('I: จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline (suite ไม่ทิ้งข้อมูลไว้)', drift.length === 0, {
      input: TABLES.join(','),
      expected: TABLES.map((t) => `${t}=${baselineCounts[t]}`).join(','),
      actual: TABLES.map((t) => `${t}=${afterCounts[t]}`).join(','),
      note: drift.length ? drift.join(' | ') : 'no drift',
    });

    const leftovers = await rows(
      conn,
      `SELECT
         (SELECT COUNT(*) FROM loans WHERE id IN (?)) l,
         (SELECT COUNT(*) FROM users WHERE username LIKE ?) u,
         (SELECT COUNT(*) FROM customer_credits WHERE customerId IN (?)) c,
         (SELECT COUNT(*) FROM settlement_agreements WHERE id IN (?)) a`,
      [
        createdLoans.length ? createdLoans : ['00000000-0000-4000-8000-000000000000'],
        `tst_cj_${RUN_TAG}%`,
        CUSTS,
        createdAgreements.length ? createdAgreements : ['00000000-0000-4000-8000-000000000000'],
      ],
    );
    ok('I: ไม่มี loan / user / credit / agreement ของ suite ค้างในตาราง',
      Number(leftovers[0].l) === 0 && Number(leftovers[0].u) === 0 && Number(leftovers[0].c) === 0 && Number(leftovers[0].a) === 0, {
        input: 'COUNT ตาม id ที่ suite สร้าง',
        expected: '0/0/0/0',
        actual: `loans=${leftovers[0].l} users=${leftovers[0].u} credits=${leftovers[0].c} agreements=${leftovers[0].a}`,
      });
    const seedCredits = await rows(conn, 'SELECT customerId, CAST(balance AS CHAR) b FROM customer_credits WHERE customerId IN (?)', [CUSTS]);
    ok('I: ลูกค้า C5-C8 กลับไปไม่มีแถว credit (สถานะเดียวกับที่ suite ก่อนหน้าทิ้งไว้)', seedCredits.length === 0, {
      input: 'customer_credits WHERE customerId IN (C5,C6,C7,C8)',
      expected: '0 แถว',
      actual: `${seedCredits.length} แถว: ${seedCredits.map((r) => `${String(r.customerId).slice(0, 8)}=${r.b}`).join(' ')}`,
    });
  } finally {
    await purge().catch(() => {});
    await restoreThresholds().catch(() => {});
  }
}
