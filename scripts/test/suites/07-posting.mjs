// 3.7 Posting engine actions: manual penalty, penalty accrual, waiver, write-off (+ their
// reversals), payment reversal and adjustment — each driven through the maker-checker workflow
// and verified against the independent oracle (component ledger, allocation order, loan status).
//
// Every loan and transaction this suite touches is created by the suite and removed in `purge`,
// because suites 10/15 compare the seeded ledger against expected.json. The two seeded loans are
// only read, never written to (their penalty probes are rejected and purged by transaction id).
//
// Accrual cases always pass an explicit `asOf` so the numbers stay deterministic on later reruns.
import { api as http, errorMessage, expected, payloadOf, rows, statusCheck, check, withPinnedPolicies } from '../lib/harness.mjs';
import { accruedPenaltyCents, billedInterestCents, fmt, postEvent, toCents, toLak, totalOf } from '../oracle.mjs';

const CAT = 'posting';

const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const LEVELS = ['CHECKER', 'HEAD', 'ADMIN'];
const RELIEF_TYPES = new Set(['PAYMENT', 'SETTLEMENT_PAYMENT', 'WAIVER', 'WRITE_OFF']);

const outstandingOf = (loan) => ({
  PENALTY: cent(loan.outstanding?.penalty ?? 0),
  PAST_INTEREST: cent(loan.outstanding?.pastInterest ?? 0),
  PAST_PRINCIPAL: cent(loan.outstanding?.pastPrincipal ?? 0),
});
const sumMoney = (c) => COMPS.reduce((acc, k) => acc + Number(c[k] ?? 0), 0);
const asLak = (c) => COMPS.map((k) => `${k}=${fmt(c[k])}`).join(' ');

export default async function suite(ctx) {
  // reset-db keeps system_config, so the payment policy is pinned to the shipped defaults for this
  // suite and put back afterwards: with the job switched on by an earlier run, the live auto-debit
  // timer would move money on the book while these cases are still counting it.
  return withPinnedPolicies(ctx.api, ['payment'], () => run(ctx));
}

async function run(ctx) {
  const { tokens, conn, api: adminApi } = ctx;
  // ctx.api fills in the admin token when none is given; an unauthenticated case must pass
  // token:null explicitly and bypass that default or it silently tests as admin.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);

  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';
  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';

  const seedClosed = expected.loans['LN-TST-000002'].loanId;
  const seedWrittenOff = expected.loans['LN-TST-000018'].loanId;

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

  const createdLoans = [];
  const createdTx = [];

  const purge = async () => {
    if (createdTx.length) {
      await conn.query('DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (?))', [createdTx]);
      await conn.query('DELETE FROM approval_workflows WHERE subjectId IN (?)', [createdTx]);
      await conn.query('DELETE FROM credit_ledger WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transaction_lines WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM audit_logs WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transactions WHERE id IN (?)', [createdTx]);
    }
    if (createdLoans.length) {
      const inTx = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';
      const custs = [C5, C6, C7, C8];
      await conn.query(`DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`, [createdLoans]);
      await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [createdLoans, custs]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [createdLoans]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM settlement_agreements WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [custs]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [createdLoans]);
    }
  };

  /** Independent oracle state per suite-created loan (cents). */
  const states = new Map();

  const newLoan = async ({ customerId, productCode, principal, disbursedAt, label }) => {
    const p = product(productCode);
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: { customerId, productId: p.id, principalAmount: principal, termValue: p.termValue, termUnit: p.termUnit, disbursedAt },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    createdLoans.push(loan.id);
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
    return { id: loan.id, loanNumber: loan.loanNumber, principal, productId: p.id, interestCents };
  };

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const txDetail = async (id) => (await api('GET', `/api/transactions/${id}`)).json?.data ?? null;
  const txLines = (id) => rows(conn, 'SELECT component, amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [id]);
  const schedule = (id, asOf) => api('GET', `/api/loans/${id}/schedule${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`).then((r) => r.json?.data);

  // Mail queued by a money event lives in the same transaction as the ledger write, so it is readable
  // immediately (transport=log: nothing leaves the machine, and payload is plain JSON for these types).
  const approverEmails = (
    await rows(
      conn,
      "SELECT email FROM users WHERE role IN ('CHECKER','HEAD_APPROVER','ADMIN') AND isActive = 1 AND email IS NOT NULL AND email <> '' ORDER BY email",
      [],
    )
  ).map((r) => r.email);
  const borrowerEmail = async (loanId) =>
    (await rows(conn, 'SELECT c.email FROM customers c JOIN loans l ON l.customerId = c.id WHERE l.id = ?', [loanId]))[0]?.email ?? null;
  /** formatAmount() ให้ค่าแบบ "100,000 LAK" จึงเทียบเป็นตัวเลขล้วน */
  const moneyOf = (value) => String(value ?? '').replace(/[^\d.]/g, '');
  const reaches = (mail, audience) =>
    audience.every((email) => mail.some((r) => String(r.recipientEmail).toLowerCase() === String(email).toLowerCase()));
  // payload is sealed for every event type, so the fields open in JS — JSON_EXTRACT on that text
  // is not valid JSON and answers NULL, which would compare nulls instead of the announced amounts.
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
            amount: payload.amount ?? null,
            reason: payload.reason ?? null,
            remaining: payload.remaining ?? null,
            components: payload.components ?? null,
          };
        }),
      )
      .then((rs) => (amount === null ? rs : rs.filter((r) => moneyOf(r.amount) === moneyOf(amount))));

  const levelToken = { CHECKER: tokens.checker1, HEAD: tokens.head, ADMIN: tokens.admin };
  const findStep = async (txId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=200', { token });
    return (pending.json.data ?? []).find((i) => i.subjectId === txId) ?? null;
  };
  const decide = (stepId, token, body) => api('POST', `/api/approvals/steps/${stepId}/decision`, { token, body });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });

  /** Walks the workflow level by level with the role that owns each level. */
  const approveWorkflow = async (txId, stopAfterLevel = 'ADMIN') => {
    const trail = [];
    for (const level of LEVELS) {
      const item = await findStep(txId, levelToken[level]);
      if (!item) break;
      const res = await decide(item.stepId, levelToken[level], { decision: 'APPROVE' });
      trail.push({ level, status: res.status, workflow: res.json?.data?.workflow });
      if (res.status !== 200) break;
      if (level === stopAfterLevel) break;
    }
    return trail;
  };

  /** create -> approve every required level -> post; returns whatever succeeded. */
  const runThrough = async (path, body, { stopAfterLevel } = {}) => {
    const made = await api('POST', path, { token: tokens.op1, body });
    if (made.status !== 201) return { made };
    const txId = made.json.data.transaction.id;
    createdTx.push(txId);
    const trail = await approveWorkflow(txId, stopAfterLevel);
    const last = trail.at(-1);
    const posted = last?.status === 200 && last?.workflow?.status === 'APPROVED' ? await postTx(txId) : null;
    return { made, txId, trail, posted };
  };

  /** Compares one posted event with the oracle: components, loan status, ledger lines. */
  const verifyPosted = async (loan, txId, event, label) => {
    const state = states.get(loan.id);
    const exp = postEvent(state, event);
    const after = await loanView(loan.id);
    const got = outstandingOf(after ?? {});
    check(CAT, `${label}: ยอดคงค้างรายส่วนหลังโพสต์ตรงกับ oracle`, {
      input: `${event.type} on ${loan.loanNumber}`,
      expected: `${asLak(state.components)} total ${fmt(totalOf(state.components))}`,
      actual: `${asLak(got)} total ${fmt(sumMoney(got))}`,
      pass: COMPS.every((c) => got[c] === state.components[c]) && sameMoney(after?.outstanding?.total, toLak(totalOf(state.components))),
    });
    check(CAT, `${label}: สถานะ loan = ${exp.statusAfter} ตามกฎปิดบัญชี (ทุกส่วนต้องเป็น 0)`, {
      input: 'loan.status after post',
      expected: exp.statusAfter,
      actual: String(after?.status),
      pass: after?.status === exp.statusAfter,
    });
    const lines = expectedLines(event, exp.allocation);
    const applied = COMPS.filter((c) => lines[c] !== 0);
    const dbLines = await txLines(txId);
    check(CAT, `${label}: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย (บวก=เพิ่มหนี้, ลบ=ลดหนี้)`, {
      input: 'financial_transaction_lines',
      expected: applied.map((c) => `${c}=${fmt(lines[c])}`).join(' '),
      actual: dbLines.map((r) => `${r.component}=${String(r.amount)}`).join(' '),
      pass: dbLines.length === applied.length && applied.every((c) => cent(dbLines.find((r) => r.component === c)?.amount ?? 0) === lines[c]),
    });
    return { exp, after, got };
  };

  const expectedLines = (event, allocation) => {
    if (event.type === 'PENALTY') return { PENALTY: event.amountCents ?? 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
    if (event.type === 'ADJUSTMENT') return { ...{ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, ...event.components };
    const sign = RELIEF_TYPES.has(event.type) ? -1 : 1;
    return Object.fromEntries(COMPS.map((c) => [c, sign * (allocation?.[c] ?? 0)]));
  };

  const pay = async (loan, cash) => {
    const made = await api('POST', '/api/payment-requests', { token: tokens.op1, body: { loanId: loan.id, cashAmount: cash } });
    if (made.status !== 201) throw new Error(`pay: create failed ${made.status} ${errorMessage(made)}`);
    const request = made.json.data.request;
    const approved = await api('POST', `/api/payment-requests/${request.id}/approve`, { token: tokens.checker1, body: {} });
    if (approved.status !== 200) throw new Error(`pay: approve failed ${approved.status} ${errorMessage(approved)}`);
    const txId = approved.json.data.transaction.id;
    const posted = await postTx(txId);
    if (posted.status !== 200) throw new Error(`pay: post failed ${posted.status} ${errorMessage(posted)}`);
    return { request, txId, posted };
  };

  try {
    // ================================================== fixtures
    const L = await newLoan({ customerId: C5, productCode: 'TST-FLAT-M6', principal: 1000000, disbursedAt: '2026-04-05T00:00:00.000Z', label: 'L' });
    const FIXED = await newLoan({ customerId: C6, productCode: 'TST-DAY-RATE', principal: 1000000, disbursedAt: '2026-09-05T00:00:00.000Z', label: 'FIXED' });
    const CAPPED = await newLoan({ customerId: C6, productCode: 'TST-DAY-RATE', principal: 100000, disbursedAt: '2026-08-05T00:00:00.000Z', label: 'CAPPED' });
    const NOPEN = await newLoan({ customerId: C7, productCode: 'TST-NOPEN-ZERO', principal: 300000, disbursedAt: '2026-05-05T00:00:00.000Z', label: 'NOPEN' });
    const RV = await newLoan({ customerId: C8, productCode: 'TST-FLAT-M6', principal: 2000000, disbursedAt: '2026-02-05T00:00:00.000Z', label: 'RV' });
    const WO = await newLoan({ customerId: C7, productCode: 'TST-FLAT-M6', principal: 1500000, disbursedAt: '2026-01-15T00:00:00.000Z', label: 'WO' });
    const AS_OF = '2026-10-13T00:00:00.000Z';

    // ================================================== A. roles on every posting endpoint
    const roleCases = [
      ['POST /transactions/penalties', '/api/transactions/penalties', { loanId: L.id, amount: 1000, reason: 'role probe' }],
      ['POST /transactions/penalties/accrue', '/api/transactions/penalties/accrue', { loanId: L.id, reason: 'role probe' }],
      ['POST /transactions/waivers', '/api/transactions/waivers', { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 1000 }, reason: 'role probe' }],
      ['POST /transactions/write-offs', '/api/transactions/write-offs', { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 1000 }, reason: 'role probe' }],
      ['POST /transactions/adjustments', '/api/transactions/adjustments', { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 1000, PAST_PRINCIPAL: 0 }, reason: 'role probe' }],
    ];
    for (const [label, path, body] of roleCases) {
      statusCheck(CAT, `${label} ไม่มี token: 401 (ไม่ใช่ 403)`, await api('POST', path, { token: null, body }), 401, { input: 'anonymous' });
      statusCheck(CAT, `${label} ด้วย VIEWER: 403`, await api('POST', path, { token: tokens.viewer, body }), 403, { input: 'viewer', messageIncludes: 'Requires role' });
    }

    // ================================================== B. validation + not-found contract
    statusCheck(CAT, 'penalties amount <= 0: 400', await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: L.id, amount: 0, reason: 'x' } }), 400, { input: 'amount=0' });
    statusCheck(CAT, 'penalties ไม่มี reason: 400', await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: L.id, amount: 1000 } }), 400, { input: 'no reason' });
    statusCheck(CAT, 'penalties loanId ไม่ใช่ uuid: 400', await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: 'not-a-uuid', amount: 1000, reason: 'x' } }), 400, { input: 'loanId=not-a-uuid' });
    statusCheck(CAT, 'penalties บน loan ที่ไม่มีจริง: 404', await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: '00000000-0000-4000-8000-000000000099', amount: 1000, reason: 'x' } }), 404, {
      input: 'unknown loan id',
      messageIncludes: 'Loan not found',
    });
    statusCheck(CAT, 'waiver ทุก component = 0: 400', await api('POST', '/api/transactions/waivers', { token: tokens.op1, body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'x' } }), 400, {
      input: 'sum = 0',
      messageIncludes: 'at least one component',
    });
    statusCheck(CAT, 'adjustment ทุก component = 0: 400', await api('POST', '/api/transactions/adjustments', { token: tokens.op1, body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'x' } }), 400, {
      input: 'sum of magnitudes = 0',
      messageIncludes: 'at least one component',
    });
    statusCheck(CAT, 'waiver เกินยอดคงค้าง: 422', await api('POST', '/api/transactions/waivers', { token: tokens.op1, body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 99999999 }, reason: 'x' } }), 422, {
      input: 'PAST_PRINCIPAL 99,999,999',
      messageIncludes: 'exceeds outstanding',
    });
    statusCheck(CAT, 'adjustment ที่ทำให้ component ติดลบ: 422', await api('POST', '/api/transactions/adjustments', { token: tokens.op1, body: { loanId: NOPEN.id, componentAmounts: { PENALTY: -1, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'x' } }), 422, {
      input: 'PENALTY −1 บน loan ที่ไม่มีค่าปรับ',
      messageIncludes: 'would make PENALTY outstanding negative',
    });
    statusCheck(CAT, 'reversal ของ txn ที่ไม่มีจริง: 404', await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: '00000000-0000-4000-8000-000000000099', amount: 1000, reason: 'x' } }), 404, {
      input: 'unknown reference id',
      messageIncludes: 'Original transaction not found',
    });

    // ================================================== C. amount thresholds decide the levels
    const thresholdCases = [
      ['<= checkerThreshold', 500000, ['CHECKER']],
      ['<= headThreshold', 5000000, ['CHECKER', 'HEAD']],
      ['> headThreshold', 20000000, ['CHECKER', 'HEAD', 'ADMIN']],
    ];
    for (const [label, amount, want] of thresholdCases) {
      const made = await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: L.id, amount, reason: `threshold probe ${label}` } });
      if (made.status !== 201) {
        check(CAT, `workflow ของ penalty ${label}`, { input: `amount ${amount}`, expected: '201', actual: `HTTP ${made.status} ${errorMessage(made)}`, pass: false });
        continue;
      }
      const txId = made.json.data.transaction.id;
      createdTx.push(txId);
      const detail = await txDetail(txId);
      check(CAT, `penalty ${label} (${fmt(toCents(amount))}): requiredLevels=${want.join('+')} และ txn PENDING_APPROVAL`, {
        input: `amount ${fmt(toCents(amount))}`,
        expected: `${want.join(',')} / PENDING_APPROVAL`,
        actual: `${(detail.workflow?.requiredLevels ?? []).join(',')} / ${detail.transaction?.status}`,
        pass: JSON.stringify(detail.workflow?.requiredLevels ?? []) === JSON.stringify(want) && detail.transaction?.status === 'PENDING_APPROVAL',
      });
      const step = await findStep(txId, tokens.checker1);
      await decide(step.stepId, tokens.checker1, { decision: 'REJECT', reason: 'threshold probe cleanup' });
      const balanceAfterReject = outstandingOf(await loanView(L.id));
      check(CAT, `penalty ${label} ที่ reject ไม่แตะยอดคงค้าง`, {
        input: 'loan outstanding',
        expected: asLak(states.get(L.id).components),
        actual: asLak(balanceAfterReject),
        pass: COMPS.every((c) => balanceAfterReject[c] === states.get(L.id).components[c]),
      });
    }

    // ================================================== D. maker-checker separation + idempotency
    const sep = await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: L.id, amount: 100000, reason: 'separation probe' } });
    const sepId = sep.json.data.transaction.id;
    createdTx.push(sepId);
    const asMaker = await findStep(sepId, tokens.op1);
    check(CAT, 'maker ไม่มี step ให้ตัดสินใจงานของตัวเอง (pending list ไม่ให้สิทธิ์)', {
      input: 'GET /api/approvals/pending as test_op1',
      expected: 'no decidable step',
      actual: asMaker ? `step listed, canDecide=${asMaker.canDecide}` : 'not listed',
      pass: !asMaker || asMaker.canDecide === false,
    });
    const checkerStep = await findStep(sepId, tokens.checker1);
    statusCheck(CAT, 'VIEWER ตัดสินใจ approval step: 403', await decide(checkerStep.stepId, tokens.viewer, { decision: 'APPROVE' }), 403, { input: 'viewer' });
    const headEarly = await decide(checkerStep.stepId, tokens.head, { decision: 'APPROVE' });
    check(CAT, 'HEAD จะข้ามขั้น CHECKER ไม่ได้', {
      input: 'decide the CHECKER step as head',
      expected: '403 หรือ 409',
      actual: `HTTP ${headEarly.status} ${errorMessage(headEarly)}`,
      pass: headEarly.status === 403 || headEarly.status === 409,
    });
    statusCheck(CAT, 'REJECT โดยไม่มีเหตุผล: 400', await decide(checkerStep.stepId, tokens.checker1, { decision: 'REJECT' }), 400, {
      input: 'decision=REJECT without reason',
      messageIncludes: 'rejection reason is required',
    });
    statusCheck(CAT, 'CHECKER ตัดสินใจ step ของตัวเอง: 200', await decide(checkerStep.stepId, tokens.checker1, { decision: 'APPROVE' }), 200, { input: 'decision=APPROVE' });
    statusCheck(CAT, 'ตัดสินใจ step เดิมซ้ำ: 409', await decide(checkerStep.stepId, tokens.checker1, { decision: 'APPROVE' }), 409, {
      input: 'same stepId twice',
      messageIncludes: 'already been decided',
    });
    statusCheck(CAT, 'โพสต์หลังอนุมัติครบ: 200', await postTx(sepId), 200, { input: 'POST /:id/post' });
    await verifyPosted(L, sepId, { type: 'PENALTY', amountCents: toCents(100000) }, 'penalty manual 100,000');
    const repost = await postTx(sepId);
    const sepLineCount = (await txLines(sepId)).length;
    check(CAT, 'โพสต์ซ้ำ (idempotency): ต้องถูกปฏิเสธ และไม่มี line ซ้ำ', {
      input: 'POST /api/transactions/:id/post x2',
      expected: '4xx + exactly 1 ledger line',
      actual: `HTTP ${repost.status} ${errorMessage(repost)}, lines=${sepLineCount}`,
      pass: repost.status >= 400 && sepLineCount === 1,
    });
    const sepMail = await mailFor(L.id, 'PENALTY_POSTED', 100000);
    const sepAudience = [await borrowerEmail(L.id), ...approverEmails];
    check(CAT, 'โพสต์ค่าปรับเกิดเมล PENALTY_POSTED ถึงผู้กู้ +ผู้มีอำนาจ และโพสต์ซ้ำไม่เพิ่มเมล', {
      input: 'notification_outbox type=PENALTY_POSTED ของ L, amount 100,000',
      expected: `${sepAudience.length} แถว = ${sepAudience.join(', ')} | reason 'separation probe' | remaining ไม่ใช่ค่าว่าง`,
      actual: `${sepMail.length} แถว ${JSON.stringify(sepMail.map((r) => [r.recipientEmail, r.amount, r.reason, r.remaining]))}`,
      pass:
        sepMail.length === sepAudience.length &&
        reaches(sepMail, sepAudience) &&
        sepMail.every((r) => r.reason === 'separation probe' && !!r.remaining),
      note: 'เมลถูกคิวใน transaction เดียวกับการโพสต์ (transactional outbox) จึงไม่มีทางหลุดเมื่อ process ล่มกลางคัน ส่วน retry เป็นหน้าที่ dispatcher ที่ suite 11 ตรวจ',
    });

    // ================================================== E. rejected work never touch the ledger
    const rejected = await api('POST', '/api/transactions/waivers', { token: tokens.op1, body: { loanId: L.id, componentAmounts: { PENALTY: 50000, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'reject probe' } });
    const rejectedId = rejected.json.data.transaction.id;
    createdTx.push(rejectedId);
    const rejStep = await findStep(rejectedId, tokens.checker1);
    statusCheck(CAT, 'REJECT พร้อมเหตุผล: 200', await decide(rejStep.stepId, tokens.checker1, { decision: 'REJECT', reason: 'ไม่ถูกต้องตามเอกสาร' }), 200, { input: 'decision=REJECT + reason' });
    const rejDetail = await txDetail(rejectedId);
    check(CAT, 'txn ที่ reject: REJECTED + workflow REJECTED + เก็บเหตุผลไว้', {
      input: 'GET /api/transactions/:id',
      expected: { transaction: 'REJECTED', workflow: 'REJECTED', reason: 'ไม่ถูกต้องตามเอกสาร' },
      actual: { transaction: rejDetail.transaction?.status, workflow: rejDetail.workflow?.status, reason: rejDetail.transaction?.rejectionReason },
      pass:
        rejDetail.transaction?.status === 'REJECTED' &&
        rejDetail.workflow?.status === 'REJECTED' &&
        rejDetail.transaction?.rejectionReason === 'ไม่ถูกต้องตามเอกสาร',
    });
    const afterReject = outstandingOf(await loanView(L.id));
    check(CAT, 'txn ที่ reject ไม่แตะยอดคงค้างเลย (invariant #1: POSTED เท่านั้นคือความจริง)', {
      input: 'outstanding after a rejected waiver of 50,000',
      expected: asLak(states.get(L.id).components),
      actual: asLak(afterReject),
      pass: COMPS.every((c) => afterReject[c] === states.get(L.id).components[c]),
    });
    statusCheck(CAT, 'post txn ที่ reject แล้ว: 422', await postTx(rejectedId), 422, { input: 'POST /:id/post on REJECTED', messageIncludes: 'Only APPROVED transactions can be posted' });
    const rejectedLines = (await txLines(rejectedId)).length;
    check(CAT, 'txn ที่ reject ไม่มี ledger line เลย', { input: 'lines of the rejected waiver', expected: 0, actual: String(rejectedLines), pass: rejectedLines === 0 });
    const rejectedWaiverMail = await mailFor(L.id, 'WAIVER_POSTED');
    check(CAT, 'waiver ที่ถูกปฏิเสธต้องไม่มีเมล WAIVER_POSTED (คิวเฉพาะตอนโพสต์)', {
      input: 'notification_outbox type=WAIVER_POSTED ของ L',
      expected: '0 แถว',
      actual: `${rejectedWaiverMail.length} แถว ${JSON.stringify(rejectedWaiverMail.map((r) => r.amount))}`,
      pass: rejectedWaiverMail.length === 0,
    });

    // ================================================== F. penalty accrual (FIXED_PER_PERIOD + grace + cap)
    const notOverdue = await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: RV.id, asOf: '2026-02-06T00:00:00.000Z', reason: 'not overdue' } });
    check(CAT, 'accrue ก่อนถึงวันครบกำหนด: 422 ไม่มีค่าปรับให้เรียกเก็บ', {
      input: 'asOf one day after disbursement',
      expected: '422 No penalty left to charge',
      actual: `HTTP ${notOverdue.status} ${errorMessage(notOverdue)}`,
      pass: notOverdue.status === 422 && errorMessage(notOverdue).includes('No penalty left to charge'),
    });
    const noneMode = await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: NOPEN.id, reason: 'mode NONE' } });
    check(CAT, 'ผลิตภัณฑ์ penaltyMode=NONE: accrue ไม่ได้แม้ loan ค้างชำระ', {
      input: `${NOPEN.loanNumber} overdue, policy NONE`,
      expected: '422 No penalty left to charge',
      actual: `HTTP ${noneMode.status} ${errorMessage(noneMode)}`,
      pass: noneMode.status === 422 && errorMessage(noneMode).includes('No penalty left to charge'),
    });

    const fixedSchedule = await schedule(FIXED.id, AS_OF);
    const fixedExpected = accruedPenaltyCents({
      overdueBaseCents: toCents(348333.34),
      principalCents: toCents(1000000),
      firstOverdueIso: '2026-10-05',
      asOfIso: AS_OF.slice(0, 10),
      policy: { mode: 'FIXED_PER_PERIOD', amount: 5000, period: 'DAY', graceDays: 3, maxPercentOfPrincipal: 10 },
    });
    check(CAT, 'schedule เสนอค่าปรับ FIXED_PER_PERIOD = 25,000.00 (5,000/วัน x 5 วันหลัง grace 3 วัน)', {
      input: `GET ${FIXED.loanNumber} schedule asOf ${AS_OF.slice(0, 10)}`,
      expected: fmt(fixedExpected),
      actual: String(fixedSchedule?.totals?.penaltySuggested),
      pass: sameMoney(fixedSchedule?.totals?.penaltySuggested ?? -1, toLak(fixedExpected)),
      note: 'คำนวณอิสระจากข้อกำหนด: amount ต่อหน่วยเวลา x จำนวนหน่วยที่ค้าง (ปัดขึ้น) แล้วตรึงด้วย cap',
    });
    const fixedAccrual = await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: FIXED.id, asOf: AS_OF } });
    statusCheck(CAT, 'accrue บน loan ที่ค้างจริง: 201', fixedAccrual, 201, { input: `asOf ${AS_OF}` });
    const fixedTxId = fixedAccrual.json.data.transaction.id;
    createdTx.push(fixedTxId);
    const accrualAmount = fixedAccrual.json.data.transaction.amount;
    check(CAT, 'จำนวนที่ accrue = ค่าที่ระบบเสนอใน schedule (ไม่ได้เดายอดเอง)', {
      input: 'transaction.amount vs totals.penaltySuggested',
      expected: String(fixedSchedule?.totals?.penaltySuggested),
      actual: String(accrualAmount),
      pass: sameMoney(accrualAmount, fixedSchedule?.totals?.penaltySuggested ?? -1),
    });
    await approveWorkflow(fixedTxId);
    statusCheck(CAT, 'accrual ที่อนุมัติครบแล้วโพสต์ได้: 200', await postTx(fixedTxId), 200, { input: 'POST /:id/post' });
    await verifyPosted(FIXED, fixedTxId, { type: 'PENALTY', amountCents: fixedExpected }, 'accrual FIXED 25,000');
    const accrualMail = await mailFor(FIXED.id, 'PENALTY_POSTED', toLak(fixedExpected));
    const accrualAudience = [await borrowerEmail(FIXED.id), ...approverEmails];
    check(CAT, 'ค่าปรับแบบ accrual ที่โพสต์แล้วเกิดเมล PENALTY_POSTED แบบเดียวกับค่าปรับ manual', {
      input: 'notification_outbox type=PENALTY_POSTED ของ FIXED, amount = ยอด accrual',
      expected: `${accrualAudience.length} แถวถึงผู้กู้ +ผู้มีอำนาจครบ, remaining ไม่ใช่ค่าว่าง`,
      actual: `${accrualMail.length} แถว ${JSON.stringify(accrualMail.map((r) => [r.recipientEmail, r.amount, r.remaining]))}`,
      pass: accrualMail.length === accrualAudience.length && reaches(accrualMail, accrualAudience) && accrualMail.every((r) => !!r.remaining),
      note: 'ทั้ง manual และ accrual ผ่าน postTransaction ตัวเดียวกัน จึงได้เมลชนิดเดียวกัน — หน้านี้คือช่องว่างเดิมที่การเรียกเก็บค่าปรับไม่เคยแจ้งผู้กู้อย่างเป็นทางการ',
    });
    const doubleAccrual = await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: FIXED.id, asOf: AS_OF } });
    check(CAT, 'accrue ซ้ำที่ asOf เดิม: ไม่เกิด billed ซ้ำ (422 ไม่มีค่าปรับเหลือ)', {
      input: 'second accrual, same asOf',
      expected: '422 No penalty left to charge',
      actual: `HTTP ${doubleAccrual.status} ${errorMessage(doubleAccrual)}`,
      pass: doubleAccrual.status === 422,
      note: 'suggested = accrued − charged − relieved → charged ครบแล้วจึงเป็น 0 (กัน F-PEN-2 ในฝั่ง auto)',
    });

    const cappedSchedule = await schedule(CAPPED.id, AS_OF);
    const capLak = (100000 * 10) / 100;
    check(CAT, 'cap = 10% ของเงินต้น (10,000.00) และตัดงวดใหม่สุดออกก่อน', {
      input: `${CAPPED.loanNumber} totals + per-period penaltyAccrued`,
      expected: { total: capLak, secondPeriodPenalty: 0, firstPeriodPenalty: capLak },
      actual: { total: cappedSchedule?.totals?.penaltyAccrued, p2: cappedSchedule?.periods?.[1]?.penaltyAccrued, p1: cappedSchedule?.periods?.[0]?.penaltyAccrued },
      pass:
        sameMoney(cappedSchedule?.totals?.penaltyAccrued ?? -1, capLak) &&
        sameMoney(cappedSchedule?.periods?.[1]?.penaltyAccrued ?? -1, 0) &&
        sameMoney(cappedSchedule?.periods?.[0]?.penaltyAccrued ?? -1, capLak),
      note: 'raw = 175,000 (งวด 1) + 25,000 (งวด 2) → เหลือ 10,000 โดยตัดงวด 2 ทิ้งทั้งงวด',
    });

    // relief-aware suggestion: waive part of the billed penalty, suggested must not rise again
    const reliefProbe = await runThrough('/api/transactions/waivers', { loanId: FIXED.id, componentAmounts: { PENALTY: 10000, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'relief-aware accrual' });
    if (reliefProbe.posted?.status === 200) {
      await verifyPosted(FIXED, reliefProbe.txId, { type: 'WAIVER', components: { PENALTY: toCents(10000), PAST_INTEREST: 0, PAST_PRINCIPAL: 0 } }, 'waive penalty 10,000');
      const afterRelief = await schedule(FIXED.id, AS_OF);
      const expectedSuggested = Math.max(0, afterRelief.totals.penaltyAccrued - afterRelief.totals.penaltyCharged - afterRelief.totals.penaltyRelieved);
      const retryAccrual = await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: FIXED.id, asOf: AS_OF } });
      check(CAT, 'หลัง waive ค่าปรับ: suggested = accrued − charged − relieved และไม่ออก billed ใหม่', {
        input: `accrued ${afterRelief.totals.penaltyAccrued} − charged ${afterRelief.totals.penaltyCharged} − relieved ${afterRelief.totals.penaltyRelieved}`,
        expected: `suggested ${fmt(toCents(expectedSuggested))} + accrual refused`,
        actual: `suggested=${afterRelief.totals.penaltySuggested}, accrual HTTP ${retryAccrual.status}`,
        pass: sameMoney(afterRelief.totals.penaltySuggested, expectedSuggested) && retryAccrual.status === 422,
      });
    }

    // ================================================== G. penalty rules on non-ACTIVE loans + cap gap
    statusCheck(CAT, 'penalty manual บน loan CLOSED: 422', await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: seedClosed, amount: 1000, reason: 'closed loan probe' } }), 422, {
      input: 'seeded LN-TST-000002 (CLOSED)',
      messageIncludes: 'Cannot add penalty to a CLOSED loan',
    });
    statusCheck(CAT, 'accrue บน loan CLOSED: 422', await api('POST', '/api/transactions/penalties/accrue', { token: tokens.op1, body: { loanId: seedClosed, reason: 'closed accrue' } }), 422, {
      input: 'seeded LN-TST-000002 (CLOSED)',
      messageIncludes: 'Cannot add penalty to a CLOSED loan',
    });
    const woProbe = await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: seedWrittenOff, amount: 1000, reason: 'WRITTEN_OFF probe' } });
    const woProbeId = woProbe.status === 201 ? woProbe.json.data.transaction.id : null;
    check(CAT, 'penalty manual บน loan WRITTEN_OFF: ต้องถูกปฏิเสธเหมือน CLOSED (F-PEN-1)', {
      input: 'seeded LN-TST-000018 (WRITTEN_OFF)',
      expected: '422 refused, a written-off book must not grow new charges',
      actual: `HTTP ${woProbe.status} ${woProbeId ? `txn ${woProbeId} created in ${woProbe.json.data.transaction.status}` : errorMessage(woProbe)}`,
      pass: woProbe.status === 422,
      note: 'F-PEN-1: transactions.router กันได้เฉพาะ CLOSED ไม่ได้กัน WRITTEN_OFF',
    });
    if (woProbeId) {
      // No approval decision here on purpose: a decision writes an audit row keyed by the
      // seeded loan with a NULL transactionId, which purge cannot remove without touching
      // seed history. The pending transaction itself is deleted by id.
      createdTx.push(woProbeId);
    }

    const billedBeforeBig = states.get(FIXED.id).components.PENALTY;
    const capOfFixed = (1000000 * 10) / 100;
    const manualBig = await runThrough('/api/transactions/penalties', { loanId: FIXED.id, amount: 500000, reason: 'manual penalty beyond the product cap' });
    const bigView = outstandingOf(await loanView(FIXED.id) ?? {});
    check(CAT, 'manual penalty เกิน cap ของผลิตภัณฑ์: โพสต์ไม่ผ่าน 422 ยอดคงค้างไม่ขยับ (F-PEN-2)', {
      input: `manual 500,000 on a product capped at ${fmt(toCents(capOfFixed))}, already billed ${fmt(billedBeforeBig)}`,
      expected: `422 refused at posting time, penalty stays ${fmt(billedBeforeBig)} (<= ${fmt(toCents(capOfFixed))})`,
      actual: `post HTTP ${manualBig.posted?.status ?? 'not reached'} ${errorMessage(manualBig.posted ?? manualBig.made).slice(0, 90)} | penalty ${fmt(bigView.PENALTY)}`,
      pass: manualBig.posted?.status === 422 && bigView.PENALTY === billedBeforeBig && bigView.PENALTY <= cent(capOfFixed),
      note: 'F-PEN-2: เพดาน maxPercentOfPrincipal ตรวจสอบตอนโพสต์ เพดานคือยอดที่เรียกเก็บสะสม (waiver ไม่ซื้อสิทธิ์คืน)',
    });

    // ================================================== H. waiver + original transaction stays immutable
    const penaltyBefore = states.get(FIXED.id).components.PENALTY;
    const fullWaiver = await runThrough('/api/transactions/waivers', { loanId: FIXED.id, componentAmounts: { PENALTY: toLak(penaltyBefore), PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'waive all penalty' });
    if (fullWaiver.posted?.status === 200) {
      const before = await txLines(fixedTxId);
      await verifyPosted(FIXED, fullWaiver.txId, { type: 'WAIVER', components: { PENALTY: penaltyBefore, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 } }, 'waive penalty ทั้งยอด');
      const after = await txLines(fixedTxId);
      const originalTx = (await txDetail(fixedTxId)).transaction;
      check(CAT, 'waiver ไม่แก้ transaction ต้นฉบับ (invariant: originals immutable)', {
        input: 'the original accrual transaction and its ledger line',
        expected: { amount: fmt(fixedExpected), line: String(before[0]?.amount) },
        actual: { amount: String(originalTx?.amount), line: String(after[0]?.amount) },
        pass: sameMoney(originalTx?.amount, toLak(fixedExpected)) && String(after[0]?.amount) === String(before[0]?.amount),
      });
      const nowOutstanding = outstandingOf(await loanView(FIXED.id));
      check(CAT, 'หลัง waive ค่าปรับหมด: PENALTY = 0 ส่วนอื่นไม่เปลี่ยน', {
        input: FIXED.loanNumber,
        expected: asLak(states.get(FIXED.id).components),
        actual: asLak(nowOutstanding),
        pass: COMPS.every((c) => nowOutstanding[c] === states.get(FIXED.id).components[c]) && nowOutstanding.PENALTY === 0,
      });
      const waiverMail = await mailFor(FIXED.id, 'WAIVER_POSTED', toLak(penaltyBefore));
      const waiverAudience = [await borrowerEmail(FIXED.id), ...approverEmails];
      check(CAT, 'waiver ที่โพสต์แล้วเกิดเมล WAIVER_POSTED ระบุส่วนที่ยกและยอดคงเหลือใหม่', {
        input: 'notification_outbox type=WAIVER_POSTED ของ FIXED, amount = ค่าปรับที่ยกทั้งก้อน',
        expected: `${waiverAudience.length} แถวถึงผู้กู้ +ผู้มีอำนาจ, components + remaining ไม่ใช่ค่าว่าง`,
        actual: `${waiverMail.length} แถว ${JSON.stringify(waiverMail.map((r) => [r.recipientEmail, r.amount, r.components, r.remaining]))}`,
        pass:
          waiverMail.length === waiverAudience.length &&
          reaches(waiverMail, waiverAudience) &&
          waiverMail.every((r) => !!r.components && !!r.remaining),
        note: 'การยกหนี้คือเหตุการณ์ที่เปลี่ยนจำนวนเงินที่ลูกหนี้ต้องจ่าย จึงต้องถึงผู้มีอำนาจทุกคนด้วย ไม่ใช่เฉพาะผู้กู้',
      });
    }

    // ================================================== I. payment reversal
    const paid = await pay(RV, 400000);
    await verifyPosted(RV, paid.txId, { type: 'PAYMENT', amountCents: toCents(400000) }, 'ชำระ 400,000');
    const originalAllocation = Object.fromEntries(COMPS.map((c) => [c, cent(paid.posted.json.data.allocation[c])]));
    const partial = await runThrough('/api/transactions/reversals', { referenceTransactionId: paid.txId, amount: 150000, reason: 'ลูกค้าจ่ายซ้ำบัญชี' });
    if (partial.posted?.status === 200) {
      await verifyPosted(RV, partial.txId, { type: 'PAYMENT_REVERSAL', amountCents: toCents(150000), originalAllocation }, 'reverse 150,000 บางส่วน');
      const revLines = await txLines(partial.txId);
      const revTotal = revLines.reduce((a, r) => a + cent(r.amount), 0);
      check(CAT, 'reversal บางส่วนไล่ตามลำดับ allocation เดิม (ไม่ใช่ pro-rata) และบรรทัดเป็นบวก', {
        input: `original allocation ${JSON.stringify(originalAllocation)}, reversal 150,000`,
        expected: 'Σ lines = 150,000 ทุกบรรทัดเป็นบวก',
        actual: `${revLines.map((r) => `${r.component}=${String(r.amount)}`).join(' ')} total ${fmt(revTotal)}`,
        pass: revLines.every((r) => Number(r.amount) > 0) && revTotal === toCents(150000),
      });
    }
    const tooMuch = await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: paid.txId, amount: 900000, reason: 'over reversal' } });
    check(CAT, 'reverse เกินส่วนที่ยัง reverse ได้: 422', {
      input: 'amount 900,000 against a 400,000 payment with 150,000 already reversed',
      expected: '422 exceeds remaining reversible',
      actual: `HTTP ${tooMuch.status} ${errorMessage(tooMuch)}`,
      pass: tooMuch.status === 422 && errorMessage(tooMuch).includes('exceeds remaining reversible'),
    });
    statusCheck(CAT, 'reverse transaction ที่ไม่ใช่ payment: 422', await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: partial.txId, amount: 1000, reason: 'reverse a reversal' } }), 422, {
      input: 'reference a PAYMENT_REVERSAL',
      messageIncludes: 'Only payments and settlement payments can be reversed',
    });
    const pendingRef = await api('POST', '/api/transactions/penalties', { token: tokens.op1, body: { loanId: RV.id, amount: 20000, reason: 'pending, not posted' } });
    const pendingRefId = pendingRef.json.data.transaction.id;
    createdTx.push(pendingRefId);
    statusCheck(CAT, 'reverse txn ที่ยัง PENDING_APPROVAL: 422', await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: pendingRefId, amount: 1000, reason: 'unposted original' } }), 422, {
      input: 'reference a PENDING_APPROVAL transaction',
      messageIncludes: 'only POSTED payments can be reversed',
    });
    const pendingStep = await findStep(pendingRefId, tokens.checker1);
    await decide(pendingStep.stepId, tokens.checker1, { decision: 'REJECT', reason: 'probe cleanup' });

    // a posted adjustment that depends on a payment blocks direct reversal (locked section 11)
    const adjOnPaid = await runThrough('/api/transactions/adjustments', { loanId: RV.id, referenceTransactionId: paid.txId, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 50000 }, reason: 'correction that depends on the payment' });
    if (adjOnPaid.posted?.status === 200) {
      await verifyPosted(RV, adjOnPaid.txId, { type: 'ADJUSTMENT', components: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: toCents(50000) } }, 'adjustment +50,000 เงินต้น');
      statusCheck(CAT, 'payment ที่มี adjustment พิงอยู่: ห้าม reverse ตรง (ชี้ไป Adjustment Workflow)', await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: paid.txId, amount: 1000, reason: 'should be blocked' } }), 422, {
        input: 'reverse a payment that a posted ADJUSTMENT depends on',
        messageIncludes: 'Adjustment Workflow',
      });
    }

    // ================================================== J. write-off + write-off reversal
    const partialWriteOff = await runThrough('/api/transactions/write-offs', { loanId: WO.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 60000, PAST_PRINCIPAL: 0 }, reason: 'ลดดอกเบี้ยบางส่วน' });
    if (partialWriteOff.posted?.status === 200) {
      await verifyPosted(WO, partialWriteOff.txId, { type: 'WRITE_OFF', components: { PENALTY: 0, PAST_INTEREST: toCents(60000), PAST_PRINCIPAL: 0 } }, 'write-off บางส่วน 60,000');
      const statusNow = (await loanView(WO.id))?.status;
      check(CAT, 'write-off บางส่วน: loan ยัง ACTIVE (ยังไม่ล้างทั้งบัญชี)', {
        input: WO.loanNumber,
        expected: 'ACTIVE',
        actual: String(statusNow),
        pass: statusNow === 'ACTIVE',
      });
    }
    statusCheck(CAT, 'write-off เกินยอดคงค้าง: 422', await api('POST', '/api/transactions/write-offs', { token: tokens.op1, body: { loanId: WO.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 99999999 }, reason: 'too much' } }), 422, {
      input: 'PAST_PRINCIPAL 99,999,999',
      messageIncludes: 'exceeds outstanding',
    });
    const woZero = await runThrough('/api/transactions/write-offs', { loanId: WO.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, reason: 'zero write-off' });
    check(CAT, 'write-off ยอด 0: ปฏิเสธ 400 ก่อนเข้า workflow', {
      input: 'all components zero',
      expected: '400 and no transaction row',
      actual: `HTTP ${woZero.made.status} ${errorMessage(woZero.made)} (txn: ${woZero.txId ? 'created' : 'none'})`,
      pass: woZero.made.status === 400 && !woZero.txId,
    });
    const fullWriteOff = await runThrough('/api/transactions/write-offs', { loanId: WO.id, reason: 'ล้างบัญชีทั้งหมด' });
    let writeOffComposition = null;
    if (fullWriteOff.posted?.status === 200) {
      const snapshot = { ...states.get(WO.id).components };
      writeOffComposition = snapshot;
      await verifyPosted(WO, fullWriteOff.txId, { type: 'WRITE_OFF', components: snapshot }, 'write-off ทั้งจำนวน (default = ยอดคงค้าง)');
      const woTx = (await txDetail(fullWriteOff.txId)).transaction;
      const zeroNow = outstandingOf(await loanView(WO.id));
      const statusNow = (await loanView(WO.id))?.status;
      check(CAT, 'write-off แบบไม่ระบุ component = ยอดคงค้างทุกส่วนพอดี แล้ว loan เป็น WRITTEN_OFF', {
        input: 'POST /write-offs without componentAmounts',
        expected: { status: 'WRITTEN_OFF', outstandingTotal: 0, amount: fmt(totalOf(snapshot)) },
        actual: { status: statusNow, outstandingTotal: sumMoney(zeroNow), amount: String(woTx?.amount) },
        pass: statusNow === 'WRITTEN_OFF' && sumMoney(zeroNow) === 0 && cent(woTx?.amount ?? -1) === totalOf(snapshot),
      });
      const woMails = await mailFor(WO.id, 'WRITE_OFF_POSTED');
      const woAudience = [await borrowerEmail(WO.id), ...approverEmails];
      check(CAT, 'write-off ทั้งสองครั้งเกิดเมล WRITE_OFF_POSTED ถึงผู้กู้ +ผู้มีอำนาจ พร้อมส่วนที่ล้าง', {
        input: 'notification_outbox type=WRITE_OFF_POSTED ของ WO (บางส่วน 60,000 + ทั้งจำนวน)',
        expected: `${woAudience.length * 2} แถว = ${woAudience.length} ที่อยู่ x 2 เหตุการณ์, components + remaining ไม่ใช่ค่าว่าง`,
        actual: `${woMails.length} แถว ${JSON.stringify(woMails.map((r) => [r.recipientEmail, r.amount, r.components, r.remaining]))}`,
        pass:
          woMails.length === woAudience.length * 2 &&
          reaches(woMails.filter((r) => moneyOf(r.amount) === '60000'), woAudience) &&
          reaches(woMails.filter((r) => moneyOf(r.amount) === moneyOf(toLak(totalOf(snapshot)))), woAudience) &&
          woMails.every((r) => !!r.components && !!r.remaining),
        note: 'เมลล้างหนี้ระบุว่ายอดคงเหลือเป็น 0 แต่สิทธิ์ติดตามหนี้อย่างเดิมยังอยู่ — จึงต่างจาก WAIVER_POSTED ชัดเจนในเนื้อหา แม้ผู้รับชุดเดียวกัน',
      });
    }
    const revWo = await runThrough('/api/transactions/write-off-reversals', { referenceTransactionId: fullWriteOff.txId, amount: 200000, reason: 'กลับมาเป็นหนี้บางส่วน' });
    if (revWo.posted?.status === 200) {
      // locked rule: a partial reversal restores the original write-off composition in order,
      // so 200,000 comes back as interest 102,000 first and only then principal.
      await verifyPosted(WO, revWo.txId, { type: 'WRITE_OFF_REVERSAL', amountCents: toCents(200000), originalAllocation: writeOffComposition }, 'write-off reversal 200,000');
      const statusNow = (await loanView(WO.id))?.status;
      check(CAT, 'write-off reversal ที่ยังมียอดคงค้างใหม่: loan กลับเป็น ACTIVE', {
        input: WO.loanNumber,
        expected: 'ACTIVE',
        actual: String(statusNow),
        pass: statusNow === 'ACTIVE',
      });
    }
    statusCheck(CAT, 'write-off reversal เกินจำนวนที่ล้างไว้: 422', await api('POST', '/api/transactions/write-off-reversals', { token: tokens.op1, body: { referenceTransactionId: fullWriteOff.txId, amount: 99999999, reason: 'over' } }), 422, {
      input: 'amount 99,999,999',
      messageIncludes: 'exceeds remaining reversible',
    });
    statusCheck(CAT, 'write-off reversal โดยชี้ txn ที่ไม่ใช่ write-off: 422', await api('POST', '/api/transactions/write-off-reversals', { token: tokens.op1, body: { referenceTransactionId: paid.txId, amount: 1000, reason: 'wrong type' } }), 422, {
      input: 'reference a POSTED payment',
      messageIncludes: 'not a write-off',
    });

    // ================================================== K. adjustment signs + threshold magnitude
    const minus = await runThrough('/api/transactions/adjustments', { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: -20000, PAST_PRINCIPAL: 0 }, reason: 'แก้ดอกเบี้ยที่บันทึกเกิน' });
    if (minus.posted?.status === 200) {
      await verifyPosted(L, minus.txId, { type: 'ADJUSTMENT', components: { PENALTY: 0, PAST_INTEREST: -toCents(20000), PAST_PRINCIPAL: 0 } }, 'adjustment −20,000 ดอกเบี้ย');
    }
    const mixed = await runThrough('/api/transactions/adjustments', { loanId: L.id, componentAmounts: { PENALTY: 5000, PAST_INTEREST: -5000, PAST_PRINCIPAL: 0 }, reason: 'ย้ายยอดระหว่างส่วน' });
    if (mixed.posted?.status === 200) {
      await verifyPosted(L, mixed.txId, { type: 'ADJUSTMENT', components: { PENALTY: toCents(5000), PAST_INTEREST: -toCents(5000), PAST_PRINCIPAL: 0 } }, 'adjustment +5,000 ค่าปรับ / −5,000 ดอกเบี้ย');
      const detail = await txDetail(mixed.txId);
      check(CAT, 'amount ของ adjustment = Σ|component| (magnitude) ไม่ใช่ net → ระดับอนุมัติถูกต้อง', {
        input: 'PENALTY +5,000 และ PAST_INTEREST −5,000 (net 0)',
        expected: { amount: 10000, levels: ['CHECKER'] },
        actual: { amount: detail.transaction?.amount, levels: detail.workflow?.requiredLevels },
        pass: sameMoney(detail.transaction?.amount ?? -1, 10000) && JSON.stringify(detail.workflow?.requiredLevels ?? []) === '["CHECKER"]',
      });
    }
    const bigAdj = await api('POST', '/api/transactions/adjustments', { token: tokens.op1, body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 12000000 }, reason: 'cross head threshold' } });
    if (bigAdj.status === 201) {
      const bigId = bigAdj.json.data.transaction.id;
      createdTx.push(bigId);
      const detail = await txDetail(bigId);
      check(CAT, 'adjustment magnitude > 10,000,000 ต้องผ่าน 3 ระดับ', {
        input: 'PAST_PRINCIPAL +12,000,000',
        expected: ['CHECKER', 'HEAD', 'ADMIN'],
        actual: detail.workflow?.requiredLevels,
        pass: JSON.stringify(detail.workflow?.requiredLevels ?? []) === JSON.stringify(['CHECKER', 'HEAD', 'ADMIN']),
      });
      const trail = await approveWorkflow(bigId, 'HEAD');
      const stillPending = (await txDetail(bigId)).transaction;
      check(CAT, 'อนุมัติถึงแค่ HEAD: txn ยัง PENDING_APPROVAL และ post ไม่ได้', {
        input: `trail ${trail.map((s) => `${s.level}:${s.status}`).join(' ')}`,
        expected: 'PENDING_APPROVAL + 422 on post',
        actual: `${stillPending.status} / post HTTP ${(await postTx(bigId)).status}`,
        pass: stillPending.status === 'PENDING_APPROVAL',
      });
      const bigLines = (await txLines(bigId)).length;
      const balanceL = outstandingOf(await loanView(L.id));
      check(CAT, 'txn ที่ค้างกลางทาง (อนุมัติไม่ครบระดับ) ไม่กระทบยอดคงค้างและไม่มี line', {
        input: L.loanNumber,
        expected: `${asLak(states.get(L.id).components)} / 0 lines`,
        actual: `${asLak(balanceL)} / ${bigLines} lines`,
        pass: COMPS.every((c) => balanceL[c] === states.get(L.id).components[c]) && bigLines === 0,
      });
    }

    // ================================================== L. closing then reopening through the ledger
    // the closing payment is the whole debt, so the loan is disbursed a full term back: the
    // collection gate only lets staff settle instalments that have arrived
    const CLOSE = await newLoan({ customerId: C5, productCode: 'TST-FLAT-M6', principal: 500000, disbursedAt: '2025-06-05T00:00:00.000Z', label: 'CLOSE' });
    const closeTotalLak = toLak(totalOf(states.get(CLOSE.id).components));
    const exactPay = await pay(CLOSE, closeTotalLak);
    await verifyPosted(CLOSE, exactPay.txId, { type: 'PAYMENT', amountCents: toCents(closeTotalLak) }, `ชำระปิดบัญชีพอดี ${fmt(toCents(closeTotalLak))}`);
    const closeAllocation = Object.fromEntries(COMPS.map((c) => [c, cent(exactPay.posted.json.data.allocation[c])]));
    const reopen = await runThrough('/api/transactions/reversals', { referenceTransactionId: exactPay.txId, amount: 10000, reason: 'reverse หลังปิดบัญชี' });
    if (reopen.posted?.status === 200) {
      await verifyPosted(CLOSE, reopen.txId, { type: 'PAYMENT_REVERSAL', amountCents: toCents(10000), originalAllocation: closeAllocation }, 'reverse 10,000 ของรายการปิดบัญชี');
      const statusNow = (await loanView(CLOSE.id))?.status;
      check(CAT, 'reversal ที่ทำให้เกิดยอดคงค้างใหม่: loan ที่ CLOSED แล้วกลับเป็น ACTIVE', {
        input: CLOSE.loanNumber,
        expected: 'ACTIVE',
        actual: String(statusNow),
        pass: statusNow === 'ACTIVE',
      });
    } else {
      check(CAT, 'reversal ของ txn บน loan CLOSED ต้องสร้างได้ (ปิดบัญชีแล้วแก้ได้ถ้ามีเหตุผล)', {
        input: `${CLOSE.loanNumber} reversal 10,000 after closure`,
        expected: 'posted successfully',
        actual: `create HTTP ${reopen.made.status} ${errorMessage(reopen.made)}`,
        pass: false,
      });
    }

    // ================================================== M. ledger is the only truth
    const mismatches = [];
    for (const [id, state] of states) {
      const perComponent = await rows(
        conn,
        "SELECT l.component c, SUM(l.amount) s FROM financial_transaction_lines l JOIN financial_transactions t ON t.id=l.transactionId WHERE t.loanId=? AND t.status='POSTED' GROUP BY l.component",
        [id],
      );
      const fromLedger = Object.fromEntries(COMPS.map((c) => [c, cent(perComponent.find((r) => r.c === c)?.s ?? 0)]));
      if (COMPS.some((c) => Math.abs(fromLedger[c] - state.components[c]) > 0)) {
        mismatches.push(`${id.slice(0, 8)}: Σ lines ${JSON.stringify(fromLedger)} vs expected ${JSON.stringify(state.components)}`);
      }
    }
    check(CAT, 'ทุก loan ของ suite: ยอดคงค้าง = Σ signed lines ของ txn ที่ POSTED เท่านั้น (invariant #1)', {
      input: 'financial_transaction_lines joined to POSTED transactions',
      expected: 'no mismatch',
      actual: mismatches.length ? mismatches.join(' | ') : `${states.size} loans reconciled`,
      pass: mismatches.length === 0,
    });
    const linesOfNonPosted = (
      await rows(conn, "SELECT COUNT(*) n FROM financial_transaction_lines l JOIN financial_transactions t ON t.id=l.transactionId WHERE t.status <> 'POSTED'")
    )[0].n;
    check(CAT, 'ไม่มี ledger line ของ txn ที่ยังไม่ได้โพสต์', {
      input: 'lines joined to non-POSTED transactions',
      expected: 0,
      actual: String(linesOfNonPosted),
      pass: linesOfNonPosted === 0,
    });

    // ================================================== N. cleanup
    await purge();
    const counts = {};
    for (const t of Object.keys(baseline)) counts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const dirty = Object.keys(baseline).filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      pass: dirty.length === 0,
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
    });
    const seededNow = (await api('GET', '/api/loans?limit=100')).json;
    check(CAT, 'ข้อมูล seed ยังครบตาม expected.json', {
      input: 'GET /api/loans after cleanup',
      expected: `${expected.rowCounts.loans} loans, outstanding ${expected.totals.closingOutstanding}`,
      actual: `${seededNow.pagination?.total} loans, outstanding ${seededNow.aggregates?.outstandingTotal}`,
      pass: seededNow.pagination?.total === expected.rowCounts.loans && sameMoney(seededNow.aggregates?.outstandingTotal, expected.totals.closingOutstanding),
    });
    statusCheck(CAT, 'loan ของ suite หายไปจริงหลัง purge: 404', await api('GET', `/api/loans/${L.id}`), 404, { input: L.id });
    const orphanLines = (await rows(conn, 'SELECT COUNT(*) n FROM financial_transaction_lines WHERE transactionId NOT IN (SELECT id FROM financial_transactions)'))[0].n;
    const orphanWorkflows = (
      await rows(conn, 'SELECT COUNT(*) n FROM approval_workflows WHERE subjectType="FINANCIAL_TRANSACTION" AND subjectId NOT IN (SELECT id FROM financial_transactions)')
    )[0].n;
    check(CAT, 'ไม่เหลือแถวกำพร้า (lines / workflows) หลัง purge', {
      input: 'orphan lines + orphan approval workflows',
      expected: '0 / 0',
      actual: `${orphanLines} / ${orphanWorkflows}`,
      pass: orphanLines === 0 && orphanWorkflows === 0,
    });
  } catch (err) {
    check(CAT, 'suite 07 ต้องรันจนจบโดยไม่ throw', {
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
