// 3.8 Settlement (account closure) agreements: create -> approve -> settlement payment ->
// shortfall waiver, plus the locked rule that the agreement itself never moves money.
//
// Same discipline as suites 06/07: every loan, agreement and transaction here is created by the
// suite and removed in `purge`, because the reporting/invariant suites compare the seeded ledger
// against expected.json. The seeded agreements (SA-TST-000001..4) are only read.
import {
  api as http,
  errorMessage,
  expected,
  isSealed,
  payloadOf,
  rows,
  settle,
  statusCheck,
  unseal,
  check,
  withPinnedPolicies,
} from '../lib/harness.mjs';
import { allocateComponents, billedInterestCents, earlySettlementFeeCents, fmt, postEvent, toCents, toLak, totalOf } from '../oracle.mjs';

const CAT = 'settlement';

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
  // ctx.api injects the admin token when none is given; anonymous cases must pass token:null
  // explicitly so they really test 401 instead of silently running as admin.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);

  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';
  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';
  const suiteCustomers = [C5, C6, C7, C8];

  // The maker recorded on an agreement must be the real user id of test_op1, not just "any id".
  const op1UserId = (await rows(conn, "SELECT id FROM users WHERE username = 'test_op1'"))[0]?.id;

  const seedClosed = expected.loans['LN-TST-000002'].loanId;
  const seedWrittenOff = expected.loans['LN-TST-000018'].loanId;
  const seedAgreements = (await rows(conn, "SELECT id, agreementNo, status, agreedAmount FROM settlement_agreements WHERE agreementNo LIKE 'SA-TST-%' ORDER BY agreementNo"))
    .map((r) => ({ id: r.id, no: r.agreementNo, status: r.status, amount: String(r.agreedAmount) }));

  const baseline = {};
  for (const t of [
    'loans',
    'payment_requests',
    'payment_allocations',
    'financial_transactions',
    'financial_transaction_lines',
    'settlement_agreements',
    'credit_ledger',
    'customer_credits',
    'approval_workflows',
    'approval_steps',
    'audit_logs',
    'notification_outbox',
    'reconciliation_records',
  ]) {
    baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  }

  const createdLoans = [];
  const createdTx = [];
  const createdAgreements = [];
  const createdProducts = [];

  const purge = async () => {
    const subjects = [...createdTx, ...createdAgreements];
    if (subjects.length) {
      await conn.query('DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (?))', [subjects]);
      await conn.query('DELETE FROM approval_workflows WHERE subjectId IN (?)', [subjects]);
      await conn.query('DELETE FROM audit_logs WHERE sourceRequestId IN (?)', [subjects]);
    }
    if (createdTx.length) {
      await conn.query('DELETE FROM credit_ledger WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transaction_lines WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM audit_logs WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transactions WHERE id IN (?)', [createdTx]);
    }
    if (createdAgreements.length) {
      await conn.query('DELETE FROM settlement_agreements WHERE id IN (?)', [createdAgreements]);
    }
    if (createdLoans.length) {
      const inTx = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';
      await conn.query(`DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`, [createdLoans]);
      await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [createdLoans, suiteCustomers]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [createdLoans]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM audit_logs WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM settlement_agreements WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM reconciliation_records WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [suiteCustomers]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [createdLoans]);
    }
    if (createdProducts.length) {
      await conn.query("DELETE FROM audit_logs WHERE action LIKE 'LOAN_PRODUCT_%' AND reason LIKE '%TST-S08-%'");
      // LOAN_PRODUCT_CREATED ไม่มี loanId ให้กรองแบบที่ suite นี้ใช้กับแถวอื่น -- จับจาก code ของตัวเอง
      // ใน payload (ซึ่งถูก seal จึงต้องเปิดใน JS) แล้วลบด้วย id
      const productMailIds = (
        await rows(conn, "SELECT id, payload FROM notification_outbox WHERE type = 'LOAN_PRODUCT_CREATED'", [])
      )
        .filter((row) => String(payloadOf(row).productCode ?? '').startsWith('TST-S08-'))
        .map((row) => row.id);
      if (productMailIds.length) await conn.query('DELETE FROM notification_outbox WHERE id IN (?)', [productMailIds]);
      await conn.query('DELETE FROM loan_products WHERE id IN (?)', [createdProducts]);
    }
  };

  const states = new Map();

  /**
   * Products priced before this feature all carry fee 0, so the fee stories need their own product.
   * It is deleted in `purge` (code prefix TST-S08-), never a seeded one.
   */
  const newProduct = async ({ code, name, interestRate, termValue, termUnit, earlySettlementFeePercent }) => {
    const res = await api('POST', '/api/loan-products', {
      token: tokens.admin,
      body: {
        code,
        name,
        interestRate,
        interestRatePeriod: 'MONTH',
        termValue,
        termUnit,
        penaltyPolicy: { mode: 'NONE' },
        ...(earlySettlementFeePercent === undefined ? {} : { earlySettlementFeePercent }),
      },
    });
    if (res.status !== 201) throw new Error(`product ${code} failed ${res.status} ${errorMessage(res)}`);
    createdProducts.push(res.json.product.id);
    products.push(res.json.product);
    return res.json.product;
  };

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
    return { id: loan.id, loanNumber: loan.loanNumber, customerId, principal, productId: p.id, interestCents };
  };

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const agreementView = async (id) => (await api('GET', `/api/settlements/${id}`)).json?.data ?? null;
  const feeQuote = async (loanId, token = tokens.admin) => (await api('GET', `/api/settlements/early-settlement-fee/${loanId}`, { token })).json?.data ?? null;
  const txLines = (id) => rows(conn, 'SELECT component, amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [id]);
  const txTypes = (loanId) =>
    rows(conn, 'SELECT transactionType, status, COUNT(*) n FROM financial_transactions WHERE loanId = ? GROUP BY transactionType, status', [loanId]);
  const txCount = async (loanId) => (await rows(conn, 'SELECT COUNT(*) n FROM financial_transactions WHERE loanId = ?', [loanId]))[0].n;
  const agreementCount = async (loanId) => (await rows(conn, 'SELECT COUNT(*) n FROM settlement_agreements WHERE loanId = ?', [loanId]))[0].n;

  const levelToken = { CHECKER: tokens.checker1, HEAD: tokens.head, ADMIN: tokens.admin };
  const findStep = async (subjectId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=200', { token });
    return (pending.json.data ?? []).find((i) => i.subjectId === subjectId) ?? null;
  };
  const decide = (stepId, token, body) => api('POST', `/api/approvals/steps/${stepId}/decision`, { token, body });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });

  /** Walks an approval trail level by level with the role that owns that level. */
  const approveLevels = async (subjectId, stopAfterLevel = 'ADMIN') => {
    const trail = [];
    for (const level of LEVELS) {
      const item = await findStep(subjectId, levelToken[level]);
      if (!item) break;
      const res = await decide(item.stepId, levelToken[level], { decision: 'APPROVE' });
      trail.push({ level, status: res.status, workflow: res.json?.data?.workflow });
      if (res.status !== 200) break;
      if (level === stopAfterLevel) break;
    }
    return trail;
  };

  /** Agreement -> fully approved (no posting: an agreement never moves money by itself). */
  const newAgreement = async (loan, agreedAmount, { token, reason = 'ปิดบัญชีตามข้อตกลง', stopAfterLevel = 'ADMIN' } = {}) => {
    const maker = token ?? tokens.op1;
    const made = await api('POST', '/api/settlements', { token: maker, body: { loanId: loan.id, agreedAmount, reason } });
    if (made.status !== 201) return { made };
    const agreement = made.json.data;
    createdAgreements.push(agreement.id);
    // 'NONE' keeps the agreement in PENDING_APPROVAL so the suite can probe an open workflow.
    const trail = stopAfterLevel === 'NONE' ? [] : await approveLevels(agreement.id, stopAfterLevel);
    const last = trail.at(-1);
    const approved = last?.status === 200 && last?.workflow?.status === 'APPROVED';
    return { made, agreement, trail, approved, id: agreement.id };
  };

  /** settlement-payment request -> checker approval -> post. */
  const settlePay = async (agreementId, body, { makerToken, approverToken } = {}) => {
    const made = await api('POST', `/api/settlements/${agreementId}/settlement-payment`, { token: makerToken ?? tokens.op1, body });
    if (made.status !== 201) return { made };
    const request = made.json.data.request;
    const approved = await api('POST', `/api/payment-requests/${request.id}/approve`, { token: approverToken ?? tokens.checker1, body: {} });
    if (approved.status !== 200) return { made, request, approved };
    const txId = approved.json.data.transaction.id;
    createdTx.push(txId);
    const posted = await postTx(txId);
    return { made, request, approved, txId, posted };
  };

  /** settlement-payment draft approved but deliberately left unposted (the post-time ceiling needs two). */
  const settleDraft = async (agreementId, body, { makerToken, approverToken } = {}) => {
    const made = await api('POST', `/api/settlements/${agreementId}/settlement-payment`, { token: makerToken ?? tokens.op1, body });
    if (made.status !== 201) return { made };
    const request = made.json.data.request;
    const approved = await api('POST', `/api/payment-requests/${request.id}/approve`, { token: approverToken ?? tokens.checker1, body: {} });
    const txId = approved.json?.data?.transaction?.id;
    if (txId) createdTx.push(txId);
    return { made, request, approved, txId };
  };

  /** A transaction already created in PENDING_APPROVAL (waiver from settle-shortfall) -> approve -> post. */
  const approveAndPost = async (txId, stopAfterLevel = 'ADMIN') => {
    const trail = await approveLevels(txId, stopAfterLevel);
    const last = trail.at(-1);
    const posted = last?.status === 200 && last?.workflow?.status === 'APPROVED' ? await postTx(txId) : null;
    return { trail, posted };
  };

  const expectedLines = (event, allocation) => {
    if (event.type === 'PENALTY') return { PENALTY: event.amountCents ?? 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
    if (event.type === 'ADJUSTMENT') return { ...{ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 }, ...event.components };
    const sign = RELIEF_TYPES.has(event.type) ? -1 : 1;
    return Object.fromEntries(COMPS.map((c) => [c, sign * (allocation?.[c] ?? 0)]));
  };

  /** Compares one posted event with the oracle: components, loan status and ledger lines. */
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
    check(CAT, `${label}: สถานะ loan = ${exp.statusAfter} (ปิดบัญชีเมื่อยอดคงค้างทุกส่วนเป็น 0)`, {
      input: 'loan.status after post',
      expected: exp.statusAfter,
      actual: String(after?.status),
      pass: after?.status === exp.statusAfter,
    });
    const lines = expectedLines(event, exp.allocation);
    const applied = COMPS.filter((c) => lines[c] !== 0);
    const dbLines = await txLines(txId);
    check(CAT, `${label}: ledger lines มีเฉพาะส่วนที่ไม่ใช่ 0 และถูกเครื่องหมาย`, {
      input: 'financial_transaction_lines',
      expected: applied.map((c) => `${c}=${fmt(lines[c])}`).join(' '),
      actual: dbLines.map((r) => `${r.component}=${String(r.amount)}`).join(' '),
      pass: dbLines.length === applied.length && applied.every((c) => cent(dbLines.find((r) => r.component === c)?.amount ?? 0) === lines[c]),
    });
    return { exp, after, got };
  };

  // Mail that a money event queued inside its own business transaction (transactional outbox), read
  // back here to prove the settlement flows announce themselves. transport=log = nothing leaves the box.
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
  const makerEmail = async (username) =>
    (await rows(conn, 'SELECT email FROM users WHERE username = ?', [username]))[0]?.email ?? null;
  /** formatAmount() ให้ค่าแบบ "1,000,000 LAK" จึงเทียบเป็นตัวเลขล้วน */
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
            remaining: payload.remaining ?? null,
            components: payload.components ?? null,
            creditBalance: payload.creditBalance ?? null,
          };
        }),
      )
      .then((rs) => (amount === null ? rs : rs.filter((r) => moneyOf(r.amount) === moneyOf(amount))));

  try {
    // ============================================================ fixtures
    const A1 = await newLoan({ customerId: C5, productCode: 'TST-NOPEN-ZERO', principal: 300000, disbursedAt: '2026-05-05T00:00:00.000Z', label: 'A1' });
    const A2 = await newLoan({ customerId: C6, productCode: 'TST-FLAT-M6', principal: 2000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'A2' });
    const A3 = await newLoan({ customerId: C7, productCode: 'TST-FLAT-M12', principal: 500000, disbursedAt: '2026-06-05T00:00:00.000Z', label: 'A3' });
    const A4 = await newLoan({ customerId: C8, productCode: 'TST-FLAT-M12', principal: 20000000, disbursedAt: '2026-01-05T00:00:00.000Z', label: 'A4' });
    const A5 = await newLoan({ customerId: C6, productCode: 'TST-DAY-RATE', principal: 1000000, disbursedAt: '2026-01-05T00:00:00.000Z', label: 'A5' });

    const outCents = (loan) => totalOf(states.get(loan.id).components);

    // ============================================================ A. authentication + roles
    const roleRead = [];
    for (const [key, token] of Object.entries(tokens)) {
      const res = await api('GET', '/api/settlements?limit=5', { token });
      roleRead.push(`${key}:${res.status}`);
    }
    check(CAT, 'ทุก role ที่มีอยู่อ่าน list of settlements ได้ (200)', {
      input: 'GET /api/settlements as each role',
      expected: 'all 200',
      actual: roleRead.join(' '),
      pass: roleRead.every((r) => r.endsWith(':200')),
    });
    statusCheck(CAT, 'ไม่มี token: 401', await api('GET', '/api/settlements', { token: null }), 401, { input: 'no bearer' });
    statusCheck(CAT, 'token ปลอม: 401', await api('GET', '/api/settlements', { token: 'not-a-jwt' }), 401, { input: 'garbage bearer', messageIncludes: 'Invalid or expired token' });
    for (const [label, path, body] of [
      ['สร้างข้อตกลง', '/api/settlements', { loanId: A1.id, agreedAmount: 1000, reason: 'role probe' }],
      ['ชำระเงินตามข้อตกลง', `/api/settlements/${seedAgreements[0].id}/settlement-payment`, { cashAmount: 1000 }],
      ['ขอยกยอดขาด', `/api/settlements/${seedAgreements[0].id}/waive-shortfall`, { reason: 'role probe' }],
    ]) {
      statusCheck(CAT, `VIEWER ไม่สามารถ${label}: 403`, await api('POST', path, { token: tokens.viewer, body }), 403, {
        input: `POST ${path} as VIEWER`,
        messageIncludes: 'Requires role: MAKER or CHECKER or HEAD_APPROVER or ADMIN',
      });
    }

    // ============================================================ B. creating an agreement
    statusCheck(CAT, 'ส่ง body ว่าง: 400 Validation failed', await api('POST', '/api/settlements', { token: tokens.op1, body: {} }), 400, { input: '{}', messageIncludes: 'Validation failed' });
    statusCheck(CAT, 'loanId ไม่ใช่ uuid: 400', await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: 'LN-1', agreedAmount: 1000, reason: 'x' } }), 400, { messageIncludes: 'Validation failed' });
    statusCheck(CAT, 'loanId ไม่มีอยู่ในระบบ: 404', await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: '00000000-9999-4000-8000-000000000099', agreedAmount: 1000, reason: 'x' } }), 404, { messageIncludes: 'Loan not found' });
    for (const bad of [0, -1000, 'abc']) {
      statusCheck(CAT, `agreedAmount = ${bad}: 400 (ต้องเป็นจำนวนบวกเท่านั้น)`, await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A1.id, agreedAmount: bad, reason: 'x' } }), 400, { input: String(bad) });
    }
    statusCheck(CAT, 'reason ว่าง: 400', await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A1.id, agreedAmount: 1000, reason: '' } }), 400, { input: "reason ''" });
    statusCheck(CAT, 'reason ยาวเกิน 1000 ตัวอักษร: 400', await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A1.id, agreedAmount: 1000, reason: 'r'.repeat(1001) } }), 400, { input: 'reason length 1001' });
    const tooBig = toLak(outCents(A1)) + 1;
    const bigRes = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A1.id, agreedAmount: tooBig, reason: 'เกินยอดคงค้าง' } });
    check(CAT, 'agreedAmount มากกว่ายอดคงค้าง: 422 และข้อความบอกยอดทั้งสองข้าง', {
      input: `agreedAmount ${tooBig} on outstanding ${toLak(outCents(A1))}`,
      expected: `422 "exceeds outstanding (${toLak(outCents(A1))})"`,
      actual: `HTTP ${bigRes.status} ${errorMessage(bigRes)}`,
      pass: bigRes.status === 422 && errorMessage(bigRes).includes('exceeds outstanding'),
    });
    for (const [label, id] of [['CLOSED', seedClosed], ['WRITTEN_OFF', seedWrittenOff]]) {
      const res = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: id, agreedAmount: 1000, reason: 'inactive loan' } });
      check(CAT, `ข้อตกลงบน loan สถานะ ${label}: 422 ต้องเป็น ACTIVE เท่านั้น`, {
        input: `POST /api/settlements on a ${label} loan`,
        expected: `422 "settlements require an ACTIVE loan"`,
        actual: `HTTP ${res.status} ${errorMessage(res)}`,
        pass: res.status === 422 && errorMessage(res).includes('settlements require an ACTIVE loan'),
      });
    }

    const exact = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A1.id, agreedAmount: toLak(outCents(A1)), reason: 'ปิดบัญชีเต็มจำนวน' } });
    if (exact.status === 201) createdAgreements.push(exact.json.data.id);
    check(CAT, 'agreedAmount = ยอดคงค้างพอดี: 201 (อนุญาต ไม่มียอดขาดให้ยก)', {
      input: `agreedAmount ${toLak(outCents(A1))} == outstanding`,
      expected: '201 status PENDING_APPROVAL',
      actual: `HTTP ${exact.status} ${exact.json?.data?.status ?? errorMessage(exact)}`,
      pass: exact.status === 201 && exact.json.data.status === 'PENDING_APPROVAL',
    });
    const created = exact.json?.data ?? {};
    check(CAT, 'โครงสร้าง agreement ที่ตอบกลับครบตาม entity', {
      input: 'POST /api/settlements response data',
      expected: { agreementNo: 'SA-######', currency: 'LAK', createdBy: op1UserId, customerId: C5, agreedAmount: fmt(outCents(A1)) },
      actual: {
        agreementNo: created.agreementNo,
        currency: created.currency,
        createdBy: created.createdBy,
        customerId: created.customerId,
        agreedAmount: String(created.agreedAmount),
      },
      pass:
        /^SA-\d{6}$/.test(String(created.agreementNo)) &&
        created.currency === 'LAK' &&
        created.createdBy === op1UserId &&
        created.customerId === C5 &&
        sameMoney(created.agreedAmount, toLak(outCents(A1))),
    });
    const belowRes = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A2.id, agreedAmount: 1000, reason: 'ต่ำกว่ายอดคงค้างมาก' } });
    if (belowRes.status === 201) createdAgreements.push(belowRes.json.data.id);
    check(CAT, 'agreedAmount ต่ำกว่ายอดคงค้าง: 201 (ไม่มีกฎขั้นต่ำ/ส่วนลด — ที่เหลือกลายเป็นยอดขาด)', {
      input: 'agreedAmount 1,000 on outstanding 2,216,000',
      expected: '201 created, no minimum rule applied',
      actual: `HTTP ${belowRes.status} ${errorMessage(belowRes)}`,
      pass: belowRes.status === 201,
      note: 'บันทึกเป็นข้อสังเกต: ระบบไม่บังคับ %-ส่วนลดขั้นต่ำของยอดคงค้าง',
    });
    const roundRes = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A2.id, agreedAmount: 1234.567, reason: 'ทดสอบปัดตัวเลข' } });
    if (roundRes.status === 201) createdAgreements.push(roundRes.json.data.id);
    check(CAT, 'agreedAmount ถูกปัดเป็น 2 ตำแหน่ง (round2) ก่อนเก็บ', {
      input: 'agreedAmount 1234.567',
      expected: '1234.57',
      actual: String(roundRes.json?.data?.agreedAmount),
      pass: String(roundRes.json?.data?.agreedAmount) === '1234.57',
    });
    const dupProbe = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A2.id, agreedAmount: 200000, reason: 'ข้อตกลงที่สองบน loan เดียวกัน' } });
    if (dupProbe.status === 201) createdAgreements.push(dupProbe.json.data.id);
    check(CAT, 'loan เดียวกันมีข้อตกลง PENDING ได้หลายฉบับ (ไม่มีกฎกันซ้ำ — ข้อสังเกต F-SET-1)', {
      input: 'second agreement on a loan that already has two',
      expected: '201 (การคุมความเสี่ยงอยู่ที่ amount vs outstanding ไม่ใช่จำนวนสัญญา)',
      actual: `HTTP ${dupProbe.status} ${errorMessage(dupProbe)}`,
      pass: dupProbe.status === 201,
      note: 'F-SET-1: ไม่ปฏิเสธข้อตกลงซ้ำ แต่ยอดที่เรียกเก็บถูกบังคับด้วย agreedAmount และยอดคงค้างจริงทุกครั้ง',
    });

    const agreementRows = await rows(conn, 'SELECT transactionType, COUNT(*) n FROM financial_transactions WHERE loanId IN (?) GROUP BY transactionType', [createdLoans]);
    check(CAT, 'การสร้างข้อตกลงไม่สร้าง financial transaction ใด ๆ (document ล้วน ๆ)', {
      input: 'transaction types on suite loans after 4 agreement creations',
      expected: 'DISBURSEMENT only',
      actual: agreementRows.map((r) => `${r.transactionType}=${r.n}`).join(' '),
      pass: agreementRows.length === 1 && agreementRows[0].transactionType === 'DISBURSEMENT',
    });
    const wfRows = await rows(conn, 'SELECT subjectType, status, requiredLevels FROM approval_workflows WHERE subjectId = ?', [exact.json.data.id]);
    const wfLevels = (() => {
      const raw = wfRows[0]?.requiredLevels;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return (parsed ?? []).join('+');
    })();
    check(CAT, 'ข้อตกลงเข้า approval_workflows แบบ subjectType=SETTLEMENT_AGREEMENT และระดับตาม threshold', {
      input: 'approval_workflows row of the new agreement (300,000)',
      expected: { subjectType: 'SETTLEMENT_AGREEMENT', status: 'PENDING', requiredLevels: 'CHECKER' },
      actual: { subjectType: wfRows[0]?.subjectType, status: wfRows[0]?.status, requiredLevels: wfLevels },
      pass: wfRows.length === 1 && wfRows[0].subjectType === 'SETTLEMENT_AGREEMENT' && wfRows[0].status === 'PENDING' && wfLevels === 'CHECKER',
    });

    // ============================================================ C. approval levels by amount
    const small = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A4.id, agreedAmount: 500000, reason: 'ระดับ CHECKER' } });
    const mid = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A4.id, agreedAmount: 2000000, reason: 'ระดับ CHECKER+HEAD' } });
    const large = await api('POST', '/api/settlements', { token: tokens.op1, body: { loanId: A4.id, agreedAmount: 12000000, reason: 'ระดับ CHECKER+HEAD+ADMIN' } });
    for (const r of [small, mid, large]) if (r.status === 201) createdAgreements.push(r.json.data.id);
    const levelOf = async (r) => {
      const wf = (await rows(conn, 'SELECT requiredLevels FROM approval_workflows WHERE subjectId = ?', [r.json?.data?.id]))[0];
      const levels = typeof wf?.requiredLevels === 'string' ? JSON.parse(wf.requiredLevels) : wf?.requiredLevels;
      return (levels ?? []).join('+');
    };
    for (const [label, res, exp] of [
      ['500,000 (<= checkerThreshold 1,000,000)', small, 'CHECKER'],
      ['2,000,000 (<= headThreshold 10,000,000)', mid, 'CHECKER+HEAD'],
      ['12,000,000 (> headThreshold)', large, 'CHECKER+HEAD+ADMIN'],
    ]) {
      check(CAT, `ข้อตกลงมูลค่า ${label}: requiredLevels = ${exp}`, {
        input: 'approval_workflows.requiredLevels',
        expected: exp,
        actual: await levelOf(res),
        pass: (await levelOf(res)) === exp,
      });
    }

    const selfMaker = await api('POST', '/api/settlements', { token: tokens.checker1, body: { loanId: A4.id, agreedAmount: 900000, reason: 'maker คือ checker1 เอง' } });
    if (selfMaker.status === 201) createdAgreements.push(selfMaker.json.data.id);
    const selfStep = await findStep(selfMaker.json.data.id, tokens.checker1);
    statusCheck(CAT, 'maker ตัดสินใจขั้นตอนของคำขอตัวเอง: 422 Maker-Checker separation', await decide(selfStep.stepId, tokens.checker1, { decision: 'APPROVE' }), 422, {
      input: 'checker1 approves an agreement they created',
      messageIncludes: 'Maker-Checker separation',
    });

    const twoLevel = await newAgreement(A4, 1800000, { stopAfterLevel: 'NONE' });
    check(CAT, 'ข้อตกลง 1,800,000 ยังไม่อนุมัติ: สถานะ PENDING_APPROVAL', {
      input: twoLevel.agreement?.agreementNo,
      expected: 'PENDING_APPROVAL',
      actual: String(twoLevel.agreement?.status),
      pass: twoLevel.agreement?.status === 'PENDING_APPROVAL',
    });
    const checkerStep = await findStep(twoLevel.id, tokens.checker1);
    const headSees = await findStep(twoLevel.id, tokens.head);
    check(CAT, 'คิว /approvals/pending คืนขั้นตอนปัจจุบันให้ทุก role (ไม่ได้กรองตาม role — UI ต้องกรองเอง)', {
      input: 'pending item for the same subject as HEAD while CHECKER is the current level',
      expected: { currentLevel: 'CHECKER', stepIdSameAsCheckerStep: true, canDecideForHead: false },
      actual: { currentLevel: headSees?.currentLevel, stepIdSameAsCheckerStep: headSees?.stepId === checkerStep?.stepId, canDecideForHead: headSees?.canDecide },
      pass: headSees?.currentLevel === 'CHECKER' && headSees?.stepId === checkerStep?.stepId && headSees?.canDecide === false,
    });
    statusCheck(CAT, 'HEAD พยายามตัดสินขั้นตอนระดับ CHECKER ที่ถึงตาอยู่: 403 role cannot decide (role guard ทำงานก่อน)', await decide(headSees.stepId, tokens.head, { decision: 'APPROVE' }), 403, {
      input: 'HEAD decides the current CHECKER-level step',
      messageIncludes: 'Your role cannot decide a CHECKER approval step',
    });
    // The not-yet-due level is only reachable by its own step id, because the queue shows one step per workflow.
    const futureHeadStep = (
      await rows(conn, "SELECT s.id FROM approval_steps s JOIN approval_workflows w ON w.id = s.workflowId WHERE w.subjectId = ? AND s.level = 'HEAD'", [twoLevel.id])
    )[0]?.id;
    statusCheck(CAT, 'ข้ามไปตัดสินขั้นตอน HEAD ก่อนถึงตา: 409 waiting for CHECKER', await decide(futureHeadStep, tokens.head, { decision: 'APPROVE' }), 409, {
      input: 'HEAD decides the HEAD-level step while currentLevel is CHECKER',
      messageIncludes: 'This step is not the current level; waiting for CHECKER',
    });
    const approvedFirst = await decide(checkerStep.stepId, tokens.checker1, { decision: 'APPROVE' });
    statusCheck(CAT, 'ตัดสินขั้นเดิมซ้ำ: 409 already been decided', await decide(checkerStep.stepId, tokens.checker1, { decision: 'APPROVE' }), 409, {
      input: 'same stepId twice',
      messageIncludes: 'already been decided',
    });
    const headNow = await findStep(twoLevel.id, tokens.head);
    statusCheck(CAT, 'CHECKER พยายามตัดสินขั้นตอน HEAD ที่ถึงตาแล้ว: 403 role cannot decide', await decide(headNow.stepId, tokens.checker1, { decision: 'APPROVE' }), 403, {
      input: 'checker1 decides the HEAD level step',
      messageIncludes: 'Your role cannot decide a HEAD approval step',
    });
    // The missing-reason probe needs its own untouched step: reusing a step that was already
    // decided would answer 409 and prove nothing about the reason guard.
    const reasonProbe = await newAgreement(A4, 300000, { stopAfterLevel: 'NONE' });
    const reasonStep = await findStep(reasonProbe.id, tokens.checker2);
    statusCheck(CAT, 'REJECT โดยไม่ใส่ reason: 400', await decide(reasonStep.stepId, tokens.checker2, { decision: 'REJECT' }), 400, {
      input: 'REJECT without reason',
      messageIncludes: 'A rejection reason is required',
    });
    check(CAT, 'ขั้น CHECKER ผ่านแล้ว workflow ยังเปิด (currentLevelIndex เลื่อนไป HEAD)', {
      input: 'workflow after first approval',
      expected: 'PENDING with CHECKER approved',
      actual: `${approvedFirst.json?.data?.workflow?.status} / steps ${JSON.stringify((approvedFirst.json?.data?.steps ?? []).map((s) => `${s.level}:${s.status}`))}`,
      pass: approvedFirst.status === 200 && approvedFirst.json.data.workflow.status === 'PENDING',
    });

    const rejectAgreement = await newAgreement(A4, 700000, { stopAfterLevel: 'NONE' });
    const rejectStep = await findStep(rejectAgreement.id, tokens.checker1);
    const rejected = await decide(rejectStep.stepId, tokens.checker1, { decision: 'REJECT', reason: 'ลูกค้าผิดเงื่อนไข' });
    const afterReject = (await agreementView(rejectAgreement.id))?.agreement;
    check(CAT, 'REJECT ทำ agreement เป็น REJECTED พร้อม decidedBy/decidedAt/decisionReason', {
      input: 'GET /api/settlements/:id after rejection',
      expected: { status: 'REJECTED', reason: 'ลูกค้าผิดเงื่อนไข' },
      actual: { status: afterReject?.status, reason: afterReject?.decisionReason },
      pass: afterReject?.status === 'REJECTED' && afterReject?.decisionReason === 'ลูกค้าผิดเงื่อนไข' && !!afterReject?.decidedAt && !!afterReject?.decidedBy,
    });
    const badPay = await api('POST', `/api/settlements/${rejectAgreement.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 1000 } });
    check(CAT, 'ข้อตกลงที่ถูกปฏิเสธ: ห้ามรับชำระเงิน (422 must be APPROVED first)', {
      input: `settlement-payment on a ${afterReject?.status} agreement`,
      expected: '422 "must be APPROVED first"',
      actual: `HTTP ${badPay.status} ${errorMessage(badPay)}`,
      pass: badPay.status === 422 && errorMessage(badPay).includes('must be APPROVED first'),
    });
    statusCheck(CAT, 'workflow ที่ปิดแล้ว: ตัดสินเพิ่มไม่ได้ 409', await decide(rejectStep.stepId, tokens.checker2, { decision: 'APPROVE' }), 409, {
      input: 'decide a step of a rejected workflow',
      messageIncludes: 'already',
    });

    // ============================================================ D. settlement payment rules
    const pendingAg = await newAgreement(A3, 100000, { stopAfterLevel: 'NONE' });
    statusCheck(CAT, 'ชำระเงินตามข้อตกลงที่ยัง PENDING_APPROVAL: 422', await api('POST', `/api/settlements/${pendingAg.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 50000 } }), 422, {
      input: 'agreement still pending',
      messageIncludes: 'must be APPROVED first',
    });
    statusCheck(CAT, 'agreement id ไม่รู้จัก: 404', await api('POST', `/api/settlements/00000000-9999-4000-8000-000000000098/settlement-payment`, { token: tokens.op1, body: { cashAmount: 50000 } }), 404, { messageIncludes: 'Settlement agreement not found' });
    statusCheck(CAT, 'cashAmount ติดลบ: 400 (zod min 0)', await api('POST', `/api/settlements/${rejectAgreement.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: -1 } }), 400, { input: 'cashAmount -1' });
    const zeroPay = await api('POST', `/api/settlements/${rejectAgreement.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 0, creditToApply: 0 } });
    statusCheck(CAT, 'cash + credit = 0: 400 "Settlement payment amount must be greater than zero"', zeroPay, 400, {
      input: 'cashAmount 0 with a REJECTED agreement on an ACTIVE loan',
      messageIncludes: 'Settlement payment amount must be greater than zero',
      note: 'ลำดับการตรวจจริง: loan status -> amount > 0 (400) -> สถานะ agreement (422); ยอด 0 จึงไม่ได้เข้าไปถึงเงื่อนไขของ agreement',
    });

    const approvedMid = await newAgreement(A2, 1500000);
    check(CAT, 'ข้อตกลง 1,500,000 อนุมัติครบ 2 ระดับแล้ว', {
      input: 'newAgreement(A2, 1500000)',
      expected: { approved: true, trail: 'CHECKER,HEAD' },
      actual: { approved: approvedMid.approved, trail: approvedMid.trail.map((t) => `${t.level}:${t.status}`).join(',') },
      pass: approvedMid.approved === true,
    });
    const loanBefore = await loanView(A2.id);
    const beforeMoney = outstandingOf(loanBefore ?? {});
    check(CAT, 'อนุมัติ agreement ไม่ขยับเงิน: ยอดคงค้างเท่าเดิมก่อนชำระเงิน (locked: ข้อตกลงไม่ใช่รายการการเงิน)', {
      input: 'loan outstanding before/after agreement approval',
      expected: asLak(states.get(A2.id).components),
      actual: `${asLak(beforeMoney)} (loan still ${loanBefore?.status})`,
      pass: COMPS.every((c) => beforeMoney[c] === states.get(A2.id).components[c]) && loanBefore?.status === 'ACTIVE',
    });
    const overPay = await api('POST', `/api/settlements/${approvedMid.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 1500001 } });
    check(CAT, 'ชำระเงินมากกว่า agreedAmount: 422 exceeds the agreed amount', {
      input: 'cashAmount 1,500,001 vs agreed 1,500,000',
      expected: '422 "exceeds the agreed amount"',
      actual: `HTTP ${overPay.status} ${errorMessage(overPay)}`,
      pass: overPay.status === 422 && errorMessage(overPay).includes('exceeds the agreed amount'),
    });
    const noCredit = await api('POST', `/api/settlements/${approvedMid.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 0, creditToApply: 100000 } });
    check(CAT, 'ใช้ credit ลูกค้าเมื่อไม่มีวงเงิน: 422 Insufficient customer credit', {
      input: 'creditToApply 100,000 on a customer with no credit',
      expected: '422 "Insufficient customer credit"',
      actual: `HTTP ${noCredit.status} ${errorMessage(noCredit)}`,
      pass: noCredit.status === 422 && errorMessage(noCredit).includes('Insufficient customer credit'),
    });
    const crossLoan = await api('POST', '/api/payment-requests', { token: tokens.op1, body: { loanId: A3.id, cashAmount: 1000, settlementAgreementId: approvedMid.id } });
    check(CAT, 'เอารหัส agreement ของ loan อื่นมาจ่ายกับ loan นี้: 422 belongs to a different loan', {
      input: 'POST /api/payment-requests with mismatched settlementAgreementId',
      expected: '422 "belongs to a different loan"',
      actual: `HTTP ${crossLoan.status} ${errorMessage(crossLoan)}`,
      pass: crossLoan.status === 422 && errorMessage(crossLoan).includes('belongs to a different loan'),
    });

    const firstPay = await settlePay(approvedMid.id, { cashAmount: 700000 });
    check(CAT, 'settlement-payment สร้าง payment request พร้อม settlementAgreementId + note เริ่มต้น', {
      input: 'POST /api/settlements/:id/settlement-payment',
      expected: { status: 201, settlementAgreementId: approvedMid.id, note: `Settlement payment for agreement ${approvedMid.agreement.agreementNo}` },
      actual: { status: firstPay.made.status, settlementAgreementId: firstPay.request?.settlementAgreementId, note: firstPay.request?.note },
      pass: firstPay.made.status === 201 && firstPay.request?.settlementAgreementId === approvedMid.id && String(firstPay.request?.note).startsWith('Settlement payment for agreement'),
    });
    const expectedFirst = allocateComponents(toCents(700000), states.get(A2.id).components);
    check(CAT, 'proposed allocation ของ settlement payment เป็นแบบเรียงส่วน (penalty→interest→principal)', {
      input: `700,000 against ${asLak(states.get(A2.id).components)}`,
      expected: asLak(expectedFirst.allocation),
      actual: asLak(Object.fromEntries(COMPS.map((c) => [c, cent(firstPay.made.json?.data?.proposed?.[c] ?? 0)]))),
      pass: COMPS.every((c) => cent(firstPay.made.json?.data?.proposed?.[c] ?? 0) === expectedFirst.allocation[c]),
    });
    check(CAT, 'อนุมัติ settlement payment แล้วเกิด transaction ชนิด SETTLEMENT_PAYMENT (ไม่ใช่ PAYMENT)', {
      input: 'payment request approve -> financial_transactions row',
      expected: 'SETTLEMENT_PAYMENT',
      actual: String(firstPay.posted ? (await rows(conn, 'SELECT transactionType FROM financial_transactions WHERE id = ?', [firstPay.txId]))[0]?.transactionType : 'not posted'),
      pass: (await rows(conn, 'SELECT transactionType FROM financial_transactions WHERE id = ?', [firstPay.txId]))[0]?.transactionType === 'SETTLEMENT_PAYMENT',
    });
    await verifyPosted(A2, firstPay.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(700000) }, 'settlement payment 700,000');
    statusCheck(CAT, 'โพสต์ซ้ำ: 422 Only APPROVED transactions can be posted', await postTx(firstPay.txId), 422, {
      input: 'POST /transactions/:id/post twice',
      messageIncludes: 'Only APPROVED transactions can be posted',
    });
    const secondPay = await settlePay(approvedMid.id, { cashAmount: 800000 });
    await verifyPosted(A2, secondPay.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(800000) }, 'settlement payment 800,000 (รวมครบ agreedAmount)');
    const detailAfterPays = await agreementView(approvedMid.id);
    check(CAT, 'GET /api/settlements/:id แสดง paymentRequests และ transactions ที่เชื่อมกันครบ', {
      input: approvedMid.agreement.agreementNo,
      expected: { paymentRequests: 2, transactions: 2 },
      actual: { paymentRequests: detailAfterPays?.paymentRequests?.length, transactions: detailAfterPays?.transactions?.length },
      pass: detailAfterPays?.paymentRequests?.length === 2 && detailAfterPays?.transactions?.length === 2,
    });
    check(CAT, 'transactions ที่เชื่อม agreement มี settlementAgreementId ตรงกันทุกรายการ', {
      input: 'financial_transactions of the agreement',
      expected: approvedMid.id,
      actual: [...new Set((detailAfterPays?.transactions ?? []).map((t) => t.settlementAgreementId))].join(','),
      pass: (detailAfterPays?.transactions ?? []).every((t) => t.settlementAgreementId === approvedMid.id),
    });

    // ============================================================ E. shortfall waiver
    const waiveEarly = await api('POST', `/api/settlements/${pendingAg.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'ยังไมได้อนุมัติ' } });
    check(CAT, 'waive-shortfall บน agreement ที่ยังไม่ APPROVED: 422 ระบุสถานะปัจจุบัน', {
      input: 'waive on PENDING_APPROVAL agreement',
      expected: '422 "Settlement agreement is PENDING_APPROVAL"',
      actual: `HTTP ${waiveEarly.status} ${errorMessage(waiveEarly)}`,
      pass: waiveEarly.status === 422 && errorMessage(waiveEarly).includes('Settlement agreement is PENDING_APPROVAL'),
    });
    const waiveNoPay = await api('POST', `/api/settlements/${approvedMid.id}`, { token: tokens.op1, body: {} });
    statusCheck(CAT, 'path ผิดของ agreement (ไม่มี route นี้): 404', waiveNoPay, 404, { input: 'POST /api/settlements/:id', messageIncludes: 'Not found' });
    const earlyWaive = await api('POST', `/api/settlements/${approvedMid.id}/waive-shortfall`, { token: tokens.viewer, body: { reason: 'viewer' } });
    statusCheck(CAT, 'VIEWER ขอ waive-shortfall: 403', earlyWaive, 403, { messageIncludes: 'Requires role' });
    const noReason = await api('POST', `/api/settlements/${approvedMid.id}/waive-shortfall`, { token: tokens.op1, body: { reason: '' } });
    statusCheck(CAT, 'waive-shortfall โดย reason ว่าง: 400', noReason, 400, { input: "reason ''" });

    const A3ag = await newAgreement(A3, 400000);
    const unpaidWaive = await api('POST', `/api/settlements/${A3ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'ยังไม่ได้จ่ายเลย' } });
    check(CAT, 'ยังไม่ชำระเงินตามข้อตกลง: waive ได้แต่ "ยอดที่จ่ายจริง (0) ต่ำกว่ายอดที่ข้อตกลงเรียก (agreed + ค่าปรับ)" = 422', {
      input: 'waive right after approval, nothing posted',
      expected: '422 "are below what the agreement asks for"',
      actual: `HTTP ${unpaidWaive.status} ${errorMessage(unpaidWaive)}`,
      pass: unpaidWaive.status === 422 && errorMessage(unpaidWaive).includes('are below what the agreement asks for'),
    });
    const A3part = await settlePay(A3ag.id, { cashAmount: 250000 });
    await verifyPosted(A3, A3part.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(250000) }, 'settlement payment 250,000 (จ่ายไม่ครบ agreed)');
    const partWaive = await api('POST', `/api/settlements/${A3ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'จ่ายไม่ครบ' } });
    check(CAT, 'จ่ายไม่ครบตาม agreedAmount: waive ยังถูกปฏิเสธ พร้อมตัวเลข netPaid ที่ถูกต้อง', {
      input: 'netPaid 250,000 vs agreed 400,000',
      expected: '422 "Settlement payments posted (250000) are below what the agreement asks for (400000: 400000 agreed plus 0 early-settlement fee)"',
      actual: `HTTP ${partWaive.status} ${errorMessage(partWaive)}`,
      pass: partWaive.status === 422 && errorMessage(partWaive).includes('250000') && errorMessage(partWaive).includes('400000'),
    });
    const A3rest = await settlePay(A3ag.id, { cashAmount: 150000 });
    await verifyPosted(A3, A3rest.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(150000) }, 'settlement payment 150,000 (netPaid ครบ 400,000)');
    const shortfallNow = { ...states.get(A3.id).components };
    const A3waive = await api('POST', `/api/settlements/${A3ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'ปิดบัญชีตามข้อตกลง' } });
    if (A3waive.status === 201) createdTx.push(A3waive.json.data.transaction.id);
    check(CAT, 'netPaid ครบตาม agreedAmount แล้ว: waive-shortfall สร้าง WAIVER transaction PENDING_APPROVAL', {
      input: 'POST /api/settlements/:id/waive-shortfall',
      expected: { status: 201, txType: 'WAIVER', status2: 'PENDING_APPROVAL', amount: fmt(shortfallNow.PAST_PRINCIPAL + shortfallNow.PAST_INTEREST) },
      actual: {
        status: A3waive.status,
        txType: A3waive.json?.data?.transaction?.transactionType,
        status2: A3waive.json?.data?.transaction?.status,
        amount: String(A3waive.json?.data?.transaction?.amount),
      },
      pass: A3waive.status === 201 && A3waive.json.data.transaction.transactionType === 'WAIVER' && A3waive.json.data.transaction.status === 'PENDING_APPROVAL',
    });
    const waiveTxRow = A3waive.status === 201 ? (await rows(conn, 'SELECT reason, settlementAgreementId, componentAmounts FROM financial_transactions WHERE id = ?', [A3waive.json.data.transaction.id]))[0] : null;
    check(CAT, 'WAIVER จาก settlement มี settlementAgreementId และ reason อ้างอิงเลข agreement', {
      input: 'financial_transactions row of the settlement waiver',
      expected: { settlementAgreementId: A3ag.id, reasonIncludes: `(settlement shortfall for agreement ${A3ag.agreement.agreementNo})` },
      actual: { settlementAgreementId: waiveTxRow?.settlementAgreementId, reason: String(waiveTxRow?.reason) },
      pass: waiveTxRow?.settlementAgreementId === A3ag.id && String(waiveTxRow?.reason).includes(`settlement shortfall for agreement ${A3ag.agreement.agreementNo}`),
    });
    const waivePosted = await approveAndPost(A3waive.json?.data?.transaction?.id);
    check(CAT, 'waiver ผ่าน approval แล้วโพสต์ได้: loan ปิดบัญชี (CLOSED) ยอดคงค้างเป็น 0 ทุกส่วน', {
      input: A3.loanNumber,
      expected: 'posted 200',
      actual: `HTTP ${waivePosted.posted?.status ?? 'not posted'} ${waivePosted.posted ? errorMessage(waivePosted.posted) : errorMessage(A3waive)}`,
      pass: waivePosted.posted?.status === 200,
    });
    if (waivePosted.posted?.status === 200) {
      await verifyPosted(A3, A3waive.json.data.transaction.id, { type: 'WAIVER', components: shortfallNow }, 'waive shortfall of settlement');
      const a3WaiveMail = await mailFor(A3.id, 'WAIVER_POSTED', toLak(totalOf(shortfallNow)));
      const a3Audience = [await borrowerEmail(A3.id), ...approverEmails];
      check(CAT, 'ยกยอดขาดตามข้อตกลงแล้วเกิดเมล WAIVER_POSTED ถึงผู้กู้ +ผู้มีอำนาจ', {
        input: `notification_outbox type=WAIVER_POSTED ของ ${A3.loanNumber}, ยอดที่ยก = shortfall`,
        expected: `${a3Audience.length} แถวครบทุกที่อยู่, components + remaining ไม่ใช่ค่าว่าง`,
        actual: `${a3WaiveMail.length} แถว ${JSON.stringify(a3WaiveMail.map((r) => [r.recipientEmail, r.amount, r.components, r.remaining]))}`,
        pass: a3WaiveMail.length === a3Audience.length && reaches(a3WaiveMail, a3Audience) && a3WaiveMail.every((r) => !!r.components && !!r.remaining),
        note: 'ยอดขาดที่ waiver ให้คือเงินที่เจ้าหนี้สละสิทธิ์จริง ผู้มีอำนาจจึงต้องได้สำเนาทุกครั้งที่ข้อตกลงถูกปิดด้วยวิธีนี้',
      });
    }
    const afterClose = await loanView(A3.id);
    check(CAT, 'หลัง settlement payment ครบ + waive ยอดขาด: สถานะ CLOSED และ outstanding 0.00', {
      input: A3.loanNumber,
      expected: { status: 'CLOSED', outstanding: '0.00' },
      actual: { status: afterClose?.status, outstanding: String(afterClose?.outstanding?.total) },
      pass: afterClose?.status === 'CLOSED' && sameMoney(afterClose?.outstanding?.total, 0),
    });
    const reWaive = await api('POST', `/api/settlements/${A3ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'ยอดขาดหมดแล้ว' } });
    check(CAT, 'waive ซ้ำเมื่อไม่มียอดขาด: 422 no outstanding shortfall', {
      input: 'second waive-shortfall on a closed settlement',
      expected: '422 "There is no outstanding shortfall to waive"',
      actual: `HTTP ${reWaive.status} ${errorMessage(reWaive)}`,
      pass: reWaive.status === 422 && errorMessage(reWaive).includes('no outstanding shortfall to waive'),
    });

    // ---- reversal awareness: netPaid must drop when a settlement payment is reversed
    // A1 owes 300,000; the agreement settles 200,000, so 100,000 is the shortfall to waive.
    const A1ag = await newAgreement(A1, 200000);
    check(CAT, 'ข้อตกลง 200,000 บนหนี้ 300,000 อนุมัติครบระดับ CHECKER', {
      input: 'newAgreement(A1, 200000)',
      expected: { approved: true, levels: 'CHECKER' },
      actual: { approved: A1ag.approved, levels: A1ag.trail.map((t) => t.level).join('+') || 'none' },
      pass: A1ag.approved === true,
    });
    const A1pay = await settlePay(A1ag.id, { cashAmount: 200000 });
    await verifyPosted(A1, A1pay.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(200000) }, 'settlement payment 200,000 ของ A1');
    const A1originalAllocation = Object.fromEntries(COMPS.map((c) => [c, cent(A1pay.posted?.json?.data?.allocation?.[c] ?? 0)]));
    const reversal = await api('POST', '/api/transactions/reversals', { token: tokens.op1, body: { referenceTransactionId: A1pay.txId, amount: 100000, reason: 'จ่ายซ้ำบัญชี' } });
    if (reversal.status === 201) createdTx.push(reversal.json.data.transaction.id);
    const reversalPosted = reversal.status === 201 ? await approveAndPost(reversal.json.data.transaction.id) : null;
    if (reversalPosted?.posted?.status === 200) {
      await verifyPosted(A1, reversal.json.data.transaction.id, { type: 'PAYMENT_REVERSAL', amountCents: toCents(100000), originalAllocation: A1originalAllocation }, 'reverse settlement payment 100,000');
      const blocked = await api('POST', `/api/settlements/${A1ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'หลัง reverse' } });
      check(CAT, 'reverse settlement payment แล้ว: waive ถูกปฏิเสธเพราะ netPaid ต่ำกว่ายอดที่ข้อตกลงเรียก', {
        input: 'netPaid = 200,000 - 100,000 = 100,000 vs agreed 200,000',
        expected: '422 "Settlement payments posted (100000) are below what the agreement asks for (200000: 200000 agreed plus 0 early-settlement fee)"',
        actual: `HTTP ${blocked.status} ${errorMessage(blocked)}`,
        pass: blocked.status === 422 && errorMessage(blocked).includes('are below what the agreement asks for') && errorMessage(blocked).includes('100000') && errorMessage(blocked).includes('200000'),
      });
      const topUp = await settlePay(A1ag.id, { cashAmount: 100000 });
      await verifyPosted(A1, topUp.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(100000) }, 'settlement payment เพิ่ม 100,000 ให้ netPaid ครบ');
      const shortfallNow2 = { ...states.get(A1.id).components };
      const okWaive = await api('POST', `/api/settlements/${A1ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'netPaid ครบแล้ว' } });
      if (okWaive.status === 201) createdTx.push(okWaive.json.data.transaction.id);
      check(CAT, 'เมื่อ netPaid กลับมาครบ (นับ reverse ด้วย): waive อนุญาตอีกครั้ง', {
        input: 'waive after topping up the reversed amount',
        expected: '201 WAIVER PENDING_APPROVAL ยอด 100,000',
        actual: `HTTP ${okWaive.status} ${okWaive.json?.data?.transaction?.transactionType ?? ''} ${String(okWaive.json?.data?.transaction?.amount ?? errorMessage(okWaive))}`,
        pass: okWaive.status === 201 && okWaive.json.data.transaction.transactionType === 'WAIVER' && sameMoney(okWaive.json.data.transaction.amount, 100000),
      });
      const okWaivePosted = await approveAndPost(okWaive.json?.data?.transaction?.id);
      if (okWaivePosted?.posted?.status === 200) {
        await verifyPosted(A1, okWaive.json.data.transaction.id, { type: 'WAIVER', components: shortfallNow2 }, 'waive ยอดคงค้างที่เหลือของ A1');
      }
      const afterA1 = await loanView(A1.id);
      check(CAT, 'เส้นทาง reverse + ชดเชย + waive: A1 ปิดบัญชีด้วยยอดคงค้าง 0 (netPaid นับเฉพาะ POSTED)', {
        input: A1.loanNumber,
        expected: { status: 'CLOSED', outstanding: '0.00' },
        actual: { status: afterA1?.status, outstanding: String(afterA1?.outstanding?.total) },
        pass: afterA1?.status === 'CLOSED' && sameMoney(afterA1?.outstanding?.total, 0),
      });
    }

    // ---- agreement approved, loan closed by other means before paying it
    const A5ag = await newAgreement(A5, 1045000, { stopAfterLevel: 'ADMIN' });
    const closeFirst = await api('POST', '/api/payment-requests', { token: tokens.op1, body: { loanId: A5.id, cashAmount: toLak(outCents(A5)) } });
    if (closeFirst.status === 201) {
      const req = closeFirst.json.data.request;
      const ap = await api('POST', `/api/payment-requests/${req.id}/approve`, { token: tokens.checker1, body: {} });
      if (ap.status === 200) {
        createdTx.push(ap.json.data.transaction.id);
        const pp = await postTx(ap.json.data.transaction.id);
        if (pp.status === 200) {
          await verifyPosted(A5, ap.json.data.transaction.id, { type: 'PAYMENT', amountCents: outCents(A5) }, 'ชำระเต็มยอดด้วยเส้นทางปกติ (ปิด loan)');
          const a5Submitted = (await mailFor(A5.id, 'PAYMENT_REQUEST_SUBMITTED')).filter((r) => r.requestNo === req.requestNo);
          const a5Approved = (await mailFor(A5.id, 'PAYMENT_REQUEST_APPROVED')).filter((r) => r.requestNo === req.requestNo);
          const a5Audience = [await borrowerEmail(A5.id), ...approverEmails];
          const a5Decided = [...new Set([...a5Audience, await makerEmail('test_op1')])];
          check(CAT, 'ปิดบัญชีด้วยเส้นทางปกติ: เกิดเมลแจ้งยื่นคำขอ (SUBMITTED) พร้อมยอดที่ชำระจริง', {
            input: `notification_outbox type=PAYMENT_REQUEST_SUBMITTED ของ ${A5.loanNumber} requestNo ${req.requestNo}`,
            expected: `${a5Audience.length} แถวถึงผู้กู้ +ผู้มีอำนาจ, amount = ${toLak(outCents(A5))} LAK`,
            actual: `${a5Submitted.length} แถว ${JSON.stringify(a5Submitted.map((r) => [r.recipientEmail, r.amount]))}`,
            pass:
              a5Submitted.length === a5Audience.length &&
              reaches(a5Submitted, a5Audience) &&
              a5Submitted.every((r) => moneyOf(r.amount) === moneyOf(toLak(outCents(A5)))),
          });
          check(CAT, 'อนุมัติคำขอแล้วเกิดเมล PAYMENT_REQUEST_APPROVED ยอดตรงกับ transaction ที่ระบบสร้าง', {
            input: `notification_outbox type=PAYMENT_REQUEST_APPROVED ของ ${A5.loanNumber}`,
            expected: `${a5Decided.length} แถว (ผู้กู้ +ผู้มีอำนาจ +maker), amount เดียวกับ SUBMITTED, remaining ไม่ใช่ค่าว่าง`,
            actual: `${a5Approved.length} แถว ${JSON.stringify(a5Approved.map((r) => [r.recipientEmail, r.amount, r.remaining]))}`,
            pass:
              a5Approved.length === a5Decided.length &&
              reaches(a5Approved, a5Decided) &&
              a5Approved.every((r) => moneyOf(r.amount) === moneyOf(toLak(outCents(A5))) && !!r.remaining),
          });
          const lateSettle = await api('POST', `/api/settlements/${A5ag.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: 1000 } });
          check(CAT, 'loan ถูกปิดด้วยรายการอื่นไปแล้ว: settlement-payment ถูกปฏิเสธตามสถานะ loan', {
            input: 'settlement-payment on a CLOSED loan',
            expected: '422 "Loan is CLOSED — cannot accept settlement payment"',
            actual: `HTTP ${lateSettle.status} ${errorMessage(lateSettle)}`,
            pass: lateSettle.status === 422 && errorMessage(lateSettle).includes('cannot accept settlement payment'),
          });
        }
      }
    }

    // ---- settlement payment above the remaining outstanding: the excess becomes credit
    // A4 owes 23,600,000. The agreement settles 5,000,000, so the books must first be waived down
    // to 4,000,000; paying 5,000,000 then leaves 1,000,000 that belongs to customer credit.
    const A4ag = await newAgreement(A4, 5000000);
    const waiveA4 = await api('POST', '/api/transactions/waivers', {
      token: tokens.op1,
      body: { loanId: A4.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 3600000, PAST_PRINCIPAL: 16000000 }, reason: 'ลดยอดก่อนปิดด้วยข้อตกลง' },
    });
    if (waiveA4.status === 201) createdTx.push(waiveA4.json.data.transaction.id);
    const waivedA4 = waiveA4.status === 201 ? await approveAndPost(waiveA4.json.data.transaction.id) : null;
    if (waivedA4?.posted?.status === 200) {
      await verifyPosted(
        A4,
        waiveA4.json.data.transaction.id,
        { type: 'WAIVER', components: { PENALTY: 0, PAST_INTEREST: toCents(3600000), PAST_PRINCIPAL: toCents(16000000) } },
        'waive 19,600,000 เพื่อให้หนี้เหลือ 4,000,000 ต่ำกว่า agreedAmount',
      );
      const bigSettle = await settlePay(A4ag.id, { cashAmount: 5000000 });
      check(CAT, 'ชำระเงินตามข้อตกลงมากกว่ายอดคงค้างที่เหลือ (แต่ไม่เกิน agreedAmount): รับได้ 201', {
        input: 'cashAmount 5,000,000 against outstanding 4,000,000 / agreed 5,000,000',
        expected: '201 (เพดานคือ agreedAmount ไม่ใช่ยอดคงค้าง; ส่วนเกินไปเป็น credit)',
        actual: `HTTP ${bigSettle.made.status} ${errorMessage(bigSettle.made)}`,
        pass: bigSettle.made.status === 201,
      });
      if (bigSettle.posted?.status === 200) {
        await verifyPosted(A4, bigSettle.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(5000000) }, 'settlement payment 5,000,000 (จ่ายเกินยอดคงค้างที่เหลือ 1,000,000)');
        check(CAT, 'โพสต์ตอบค่า excess = ส่วนที่เกินยอดคงค้าง', {
          input: 'POST /transactions/:id/post response',
          expected: '1000000.00',
          actual: String(bigSettle.posted.json?.data?.excess),
          pass: sameMoney(bigSettle.posted.json?.data?.excess ?? -1, 1000000),
        });
        const creditRow = (await rows(conn, 'SELECT balance FROM customer_credits WHERE customerId = ?', [C8]))[0];
        const creditLedger = await rows(conn, 'SELECT type, amount FROM credit_ledger WHERE customerId = ?', [C8]);
        check(CAT, 'ส่วนที่เกินยอดคงค้างกลายเป็น customer credit (ACCRUED) ไม่ใช่ลบยอดหนี้ซ้ำ', {
          input: 'credit_ledger + customer_credits of C8 after the settlement payment',
          expected: { type: 'ACCRUED', amount: '1000000.00', balance: '1000000.00' },
          actual: {
            type: [...new Set(creditLedger.map((r) => r.type))].sort().join(','),
            amount: fmt(creditLedger.reduce((a, r) => a + cent(r.amount), 0)),
            balance: String(creditRow?.balance),
          },
          pass:
            creditLedger.length === 1 &&
            creditLedger.every((r) => r.type === 'ACCRUED') &&
            creditLedger.reduce((a, r) => a + cent(r.amount), 0) === toCents(1000000) &&
            sameMoney(creditRow?.balance ?? -1, 1000000),
        });
        const a4CreditMail = await mailFor(A4.id, 'CREDIT_DEPOSITED', 1000000);
        const a4Borrower = await borrowerEmail(A4.id);
        check(CAT, 'ส่วนเกิน 1,000,000 ที่กลายเป็นเครดิตเกิดเมล CREDIT_DEPOSITED บอกยอดคงเหลือในบัญชีเครดิต', {
          input: `notification_outbox type=CREDIT_DEPOSITED ของ ${A4.loanNumber}, amount 1,000,000`,
          expected: '>= 1 แถวถึงเฉพาะผู้กู้, creditBalance ไม่ใช่ค่าว่าง',
          actual: `${a4CreditMail.length} แถว ${JSON.stringify(a4CreditMail.map((r) => [r.recipientEmail, r.amount, r.creditBalance]))}`,
          pass:
            a4CreditMail.length >= 1 &&
            a4CreditMail.every((r) => String(r.recipientEmail).toLowerCase() === String(a4Borrower).toLowerCase()) &&
            a4CreditMail.every((r) => !!r.creditBalance),
          note: 'เงินก้อนนี้ยังไม่ได้ตัดหนี้ (หนี้ปิดไปแล้ว) จึงเป็นเมลเติมเครดิต ไม่ใช่ใบเสร็จ และไม่มีสำเนาถึงผู้มีอำนาจ',
        });
        const afterA4 = await loanView(A4.id);
        check(CAT, 'หนี้ปิดพอดีเมื่อมี agreement + waiver + payment ครบ: A4 CLOSED และยอดคงค้าง 0 (credit ไม่ลดหนี้ซ้ำ)', {
          input: A4.loanNumber,
          expected: { status: 'CLOSED', outstanding: '0.00' },
          actual: { status: afterA4?.status, outstanding: String(afterA4?.outstanding?.total) },
          pass: afterA4?.status === 'CLOSED' && sameMoney(afterA4?.outstanding?.total, 0),
        });
      }
    }

    // ============================================================ E2. early-settlement fee
    // Closing a loan before its last instalment falls due costs a fee: the percent lives on the
    // product, is frozen onto the loan at disbursement, and is billed as an ordinary PENALTY
    // transaction that must be posted before the payoff — otherwise the payment would overpay into
    // credit and the shortfall waiver would hand the fee straight back.
    const FEE_PCT = 2.5;
    const feeProduct = await newProduct({
      code: 'TST-S08-FEE',
      name: 'Suite08 early settlement fee',
      interestRate: 1,
      termValue: 6,
      termUnit: 'MONTH',
      earlySettlementFeePercent: FEE_PCT,
    });
    const F1 = await newLoan({ customerId: C5, productCode: feeProduct.code, principal: 1000000, disbursedAt: '2026-09-05T00:00:00.000Z', label: 'F1' });
    const F2 = await newLoan({ customerId: C6, productCode: feeProduct.code, principal: 500000, disbursedAt: '2026-01-05T00:00:00.000Z', label: 'F2' });
    const F3 = await newLoan({ customerId: C7, productCode: 'TST-FLAT-M12', principal: 400000, disbursedAt: '2026-09-05T00:00:00.000Z', label: 'F3' });

    const feeProductRow = (await rows(conn, 'SELECT earlySettlementFeePercent FROM loan_products WHERE id = ?', [feeProduct.id]))[0];
    check(CAT, 'ผลิตภัณฑ์ตั้ง earlySettlementFeePercent ได้ และค่าที่เก็บใน DB เท่ากับที่ส่ง', {
      input: `POST /api/loan-products code=${feeProduct.code} earlySettlementFeePercent=${FEE_PCT}`,
      expected: `${FEE_PCT}`,
      actual: `api ${feeProduct.earlySettlementFeePercent} / db ${feeProductRow?.earlySettlementFeePercent}`,
      pass: Number(feeProduct.earlySettlementFeePercent) === FEE_PCT && Number(feeProductRow?.earlySettlementFeePercent) === FEE_PCT,
    });
    const productAudit = (
      await rows(conn, "SELECT reason FROM audit_logs WHERE action = 'LOAN_PRODUCT_CREATED' AND reason LIKE ? ORDER BY createdAt DESC LIMIT 1", [`%${feeProduct.code}%`])
    )[0]?.reason ?? '';
    check(CAT, 'audit ของการสร้างผลิตภัณฑ์ระบุค่าปรับปิดก่อนกำหนด ทำให้อ่าน trail ได้โดยไม่ต้อง lookup', {
      input: 'audit_logs LOAN_PRODUCT_CREATED ของ TST-S08-FEE',
      expected: 'reason contains "early-settlement fee 2.5%"',
      actual: String(productAudit).slice(0, 200),
      pass: /early-settlement fee 2\.5(\.0+)?%/.test(String(productAudit)),
    });
    for (const bad of [-1, 101]) {
      statusCheck(CAT, `earlySettlementFeePercent = ${bad}: 400 (zod 0..100)`, await api('POST', '/api/loan-products', { token: tokens.admin, body: { code: `TST-S08-BAD${bad}`, name: 'bad fee', interestRate: 1, termValue: 6, termUnit: 'MONTH', earlySettlementFeePercent: bad } }), 400, {
        input: `earlySettlementFeePercent=${bad}`,
        messageIncludes: 'Validation failed',
      });
    }

    const f1SnapshotRow = (await rows(conn, 'SELECT earlySettlementFeePercent FROM loans WHERE id = ?', [F1.id]))[0];
    check(CAT, 'loan แช่แข็งเปอร์เซ็นต์ค่าปรับจากผลิตภัณฑ์ไว้ตอนปล่อยกู้', {
      input: `POST /api/loans บน ${feeProduct.code}`,
      expected: `${FEE_PCT} ทั้ง API และ loans.earlySettlementFeePercent`,
      actual: `api ${(await loanView(F1.id))?.earlySettlementFeePercent} / db ${f1SnapshotRow?.earlySettlementFeePercent}`,
      pass:
        Number((await loanView(F1.id))?.earlySettlementFeePercent) === FEE_PCT &&
        Number(f1SnapshotRow?.earlySettlementFeePercent) === FEE_PCT,
    });
    const repriced = await api('PATCH', `/api/loan-products/${feeProduct.id}`, { token: tokens.admin, body: { earlySettlementFeePercent: 9 } });
    statusCheck(CAT, 'ADMIN แก้เปอร์เซ็นต์ค่าปรับของผลิตภัณฑ์เป็น 9%: 200', repriced, 200, { input: 'earlySettlementFeePercent=9' });
    const quoteAfterReprice = await feeQuote(F1.id);
    check(CAT, 'ผลิตภัณฑ์ถูกตั้งใหม่เป็น 9% แล้ว แต่กู้ที่ปล่อยไว้ยังคิด 2.5% ตาม snapshot (ห้ามไปเพิ่มหนี้สัญญาที่เซ็นแล้ว)', {
      input: `GET /api/settlements/early-settlement-fee/{loanId} ของ ${F1.loanNumber} หลัง PATCH ผลิตภัณฑ์`,
      expected: `feePercent ${FEE_PCT} ไม่ใช่ 9`,
      actual: `feePercent ${quoteAfterReprice?.feePercent}, fee ${fmt(cent(quoteAfterReprice?.fee ?? -1))}`,
      pass: Number(quoteAfterReprice?.feePercent) === FEE_PCT,
    });

    const feeExp = earlySettlementFeeCents({ principalOutstandingCents: toCents(F1.principal), feePercent: FEE_PCT, settledBeforeTermEnd: true });
    const quoteF1 = await feeQuote(F1.id);
    const debtF1 = totalOf(states.get(F1.id).components);
    check(CAT, 'GET /settlements/early-settlement-fee กู้ที่ยังไม่ถึงกำหนด: คำนวณ % ของเงินต้นคงเหลือตรง oracle', {
      input: `เงินต้นคงเหลือ ${toLak(toCents(F1.principal))} @ ${FEE_PCT}%, งวดล่าสุดยังมาไม่ถึง`,
      expected: `fee ${fmt(feeExp)}, outstanding ${fmt(debtF1)}, totalDue ${fmt(debtF1 + feeExp)}, settledBeforeTermEnd true, nextPendingPeriod มีงวด`,
      actual: `fee ${fmt(cent(quoteF1?.fee ?? -1))}, outstanding ${fmt(cent(quoteF1?.outstanding ?? -1))}, totalDue ${fmt(cent(quoteF1?.totalDue ?? -1))}, settledBeforeTermEnd ${quoteF1?.settledBeforeTermEnd}, nextPending ${quoteF1?.nextPendingPeriod?.index ?? 'null'}`,
      pass:
        cent(quoteF1?.fee ?? -1) === feeExp &&
        cent(quoteF1?.outstanding ?? -1) === debtF1 &&
        cent(quoteF1?.totalDue ?? -1) === debtF1 + feeExp &&
        quoteF1?.settledBeforeTermEnd === true &&
        Number(quoteF1?.principalOutstanding ?? -1) === Number(F1.principal) &&
        quoteF1?.nextPendingPeriod?.index > 1,
    });
    const quoteTxBefore = await txCount(F3.id);
    const quoteAgBefore = await agreementCount(F3.id);
    await feeQuote(F3.id);
    await feeQuote(F3.id);
    check(CAT, 'endpoint คิดค่าปรับเป็น read-only: เรียกซ้ำกี่ครั้งก็ไม่มี agreement หรือ transaction ใหม่', {
      input: 'GET /api/settlements/early-settlement-fee 2 ครั้งบน F3',
      expected: `transactions ${quoteTxBefore}, agreements ${quoteAgBefore}`,
      actual: `transactions ${await txCount(F3.id)}, agreements ${await agreementCount(F3.id)}`,
      pass: (await txCount(F3.id)) === quoteTxBefore && (await agreementCount(F3.id)) === quoteAgBefore,
    });
    const quoteF2 = await feeQuote(F2.id);
    check(CAT, 'กู้ที่งวดครบทั้งสัญญาแล้ว (F2): ปิดบัญชีไม่คิดค่าปรับ เพราะการปิดตอนสิ้นสัญญาไม่ใช่การขอปิดก่อนกำหนด', {
      input: `GET early-settlement-fee ของ ${F2.loanNumber} (ปล่อย 2026-01-05, 6 เดือน)`,
      expected: `settledBeforeTermEnd false, fee 0.00, totalDue = outstanding ${fmt(totalOf(states.get(F2.id).components))}`,
      actual: `settledBeforeTermEnd ${quoteF2?.settledBeforeTermEnd}, fee ${fmt(cent(quoteF2?.fee ?? -1))}, totalDue ${fmt(cent(quoteF2?.totalDue ?? -1))}`,
      pass:
        quoteF2?.settledBeforeTermEnd === false &&
        cent(quoteF2?.fee ?? -1) === 0 &&
        cent(quoteF2?.totalDue ?? -1) === totalOf(states.get(F2.id).components),
    });
    const quoteF3 = await feeQuote(F3.id);
    check(CAT, 'ผลิตภัณฑ์ที่ไม่ได้ตั้งค่าปรับ (seed เดิม = 0): ปิดก่อนกำหนดยังไม่มีค่าปรับ ระบบไม่เก็บเพราะคอลัมน์ใหม่', {
      input: `GET early-settlement-fee ของ ${F3.loanNumber} (TST-FLAT-M12, งวดยังไม่ครบ)`,
      expected: 'feePercent 0, settledBeforeTermEnd true, fee 0.00',
      actual: `feePercent ${quoteF3?.feePercent}, settledBeforeTermEnd ${quoteF3?.settledBeforeTermEnd}, fee ${fmt(cent(quoteF3?.fee ?? -1))}`,
      pass: Number(quoteF3?.feePercent) === 0 && quoteF3?.settledBeforeTermEnd === true && cent(quoteF3?.fee ?? -1) === 0,
    });
    const viewerQuote = await api('GET', `/api/settlements/early-settlement-fee/${F1.id}`, { token: tokens.viewer });
    const anonQuote = await api('GET', `/api/settlements/early-settlement-fee/${F1.id}`, { token: null });
    check(CAT, 'ทุก role ที่มี token ขอยอดปิดบัญชีพบได้ (read-only ไม่มี role guard) ส่วนผู้ไม่ login ถูกกัน', {
      input: 'GET early-settlement-fee as VIEWER and as anonymous',
      expected: { viewer: 200, anon: 401 },
      actual: { viewer: viewerQuote.status, anon: anonQuote.status },
      pass: viewerQuote.status === 200 && anonQuote.status === 401,
    });
    statusCheck(CAT, 'early-settlement-fee ของ loan ที่ไม่มีอยู่: 404 Loan not found', await api('GET', '/api/settlements/early-settlement-fee/00000000-9999-4000-8000-000000000096', { token: tokens.viewer }), 404, {
      input: 'unknown loan uuid',
      messageIncludes: 'Loan not found',
    });

    const F1ag = await newAgreement(F1, toLak(debtF1), { reason: 'ปิดบัญชีทั้งก้อนก่อนครบสัญญา' });
    check(CAT, `ข้อตกลงปิดก่อนกำหนดเก็บค่าปรับ ${fmt(feeExp)} ไว้กับสัญญา พร้อมยอดที่ต้องชำระรวม`, {
      input: `POST /api/settlements agreedAmount ${toLak(debtF1)} บน ${F1.loanNumber}`,
      expected: { status: 'APPROVED', earlySettlementFee: fmt(feeExp), agreedAmount: fmt(debtF1) },
      actual: {
        status: F1ag.agreement?.status,
        earlySettlementFee: String(F1ag.agreement?.earlySettlementFee),
        agreedAmount: String(F1ag.agreement?.agreedAmount),
      },
      pass:
        F1ag.approved === true &&
        sameMoney(F1ag.agreement?.earlySettlementFee, toLak(feeExp)) &&
        sameMoney(F1ag.agreement?.agreedAmount, toLak(debtF1)),
    });
    const F1agAudit = (
      await rows(conn, "SELECT reason FROM audit_logs WHERE action = 'SETTLEMENT_AGREEMENT_CREATED' AND loanId = ? ORDER BY createdAt", [F1.id])
    )[0]?.reason ?? '';
    check(CAT, 'audit ของข้อตกลงบอกที่มาของค่าปรับ (เปอร์เซ็นต์ + เงินต้นที่คิด) ให้ผู้ตรวจสอบคำนวณเองได้', {
      input: 'audit_logs SETTLEMENT_AGREEMENT_CREATED ของ F1',
      expected: `early-settlement fee ${fmt(feeExp)} + "2.5% of principal outstanding 1000000"`,
      actual: String(F1agAudit).slice(0, 240),
      pass: /early-settlement fee 25000(\.00)?/.test(String(F1agAudit)) && /2\.5% of principal outstanding 1000000(\.00)?/.test(String(F1agAudit)),
    });

    const feeTxRows = await rows(conn, "SELECT id, status, amount, reason, settlementAgreementId FROM financial_transactions WHERE loanId = ? AND transactionType = 'PENALTY'", [F1.id]);
    const feeTxId = feeTxRows[0]?.id;
    if (feeTxId) createdTx.push(feeTxId);
    check(CAT, 'ค่าปรับปิดก่อนกำหนดกลายเป็นรายการ PENALTY ที่ผูกกับ agreement และยังไม่โพสต์ (เข้า maker-checker เหมือนค่าปรับทั่วไป)', {
      input: 'financial_transactions ของ F1 ชนิด PENALTY',
      expected: { rows: 1, status: 'PENDING_APPROVAL', amount: fmt(feeExp), reasonStart: `Early-settlement fee ${FEE_PCT}% of the principal still owed` },
      actual: {
        rows: feeTxRows.length,
        status: feeTxRows[0]?.status,
        amount: fmt(cent(feeTxRows[0]?.amount ?? -1)),
        reasonStart: String(feeTxRows[0]?.reason).slice(0, 60),
        linked: feeTxRows[0]?.settlementAgreementId === F1ag.id,
      },
      pass:
        feeTxRows.length === 1 &&
        feeTxRows[0].status === 'PENDING_APPROVAL' &&
        cent(feeTxRows[0].amount) === feeExp &&
        feeTxRows[0].settlementAgreementId === F1ag.id &&
        String(feeTxRows[0].reason).startsWith(`Early-settlement fee ${FEE_PCT}% of the principal still owed`),
    });
    const reqBefore = (await rows(conn, 'SELECT COUNT(*) n FROM payment_requests WHERE loanId = ?', [F1.id]))[0].n;
    const earlyPay = await api('POST', `/api/settlements/${F1ag.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: toLak(debtF1) } });
    check(CAT, 'ห้ามชำระเงินปิดบัญชีก่อนโพสต์ค่าปรับ: 422 ระบุว่ายอดที่โพสต์แล้วคือ 0', {
      input: `settlement-payment ${toLak(debtF1)} ตอนที่ fee ยัง PENDING_APPROVAL`,
      expected: '422 "Early-settlement fee of 25000 must be approved and posted before the settlement payment"',
      actual: `HTTP ${earlyPay.status} ${errorMessage(earlyPay)}`,
      pass:
        earlyPay.status === 422 &&
        errorMessage(earlyPay).includes('must be approved and posted before the settlement payment') &&
        errorMessage(earlyPay).includes('0 posted so far') &&
        (await rows(conn, 'SELECT COUNT(*) n FROM payment_requests WHERE loanId = ?', [F1.id]))[0].n === reqBefore,
    });

    const feeFlow = await approveAndPost(feeTxId);
    statusCheck(CAT, 'ค่าปรับผ่าน approval ของ PENALTY แล้วโพสต์ได้ 200 (เส้นทางเดียวกับค่าปรับปกติ)', feeFlow.posted, 200, {
      input: 'approve levels + POST /transactions/:feeId/post',
    });
    await verifyPosted(F1, feeTxId, { type: 'PENALTY', amountCents: feeExp }, 'billed early-settlement fee');
    const feeMail = await mailFor(F1.id, 'PENALTY_POSTED', toLak(feeExp));
    const f1Audience = [await borrowerEmail(F1.id), ...approverEmails];
    check(CAT, 'ค่าปรับปิดก่อนครบสัญญาที่โพสต์แล้วเกิดเมล PENALTY_POSTED (ชนิดเดียวกับค่าปรับปกติ)', {
      input: `notification_outbox type=PENALTY_POSTED ของ ${F1.loanNumber}, amount ${toLak(feeExp)}`,
      expected: `${f1Audience.length} แถวถึงผู้กู้ +ผู้มีอำนาจครบ, reason + remaining ไม่ใช่ค่าว่าง`,
      actual: `${feeMail.length} แถว ${JSON.stringify(feeMail.map((r) => [r.recipientEmail, r.amount, r.reason, r.remaining]))}`,
      pass: feeMail.length === f1Audience.length && reaches(feeMail, f1Audience) && feeMail.every((r) => !!r.reason && !!r.remaining),
      note: 'fee ถูกโพสต์ผ่าน postTransaction ทางเดียวกับค่าปรับที่เรียกเก็บปกติ จึงได้เมลชนิดเดียวกันโดยไม่มี code แยก',
    });
    const quoteAfterFee = await feeQuote(F1.id);
    check(CAT, 'หลังโพสต์ค่าปรับ: เงินต้นคงเหลือยังไม่เปลี่ยน และ quotation ยังให้ตัวเลขเดิม (ค่าปรับเข้า.bucket PENALTY ไม่ใช่ต้น)', {
      input: `GET early-settlement-fee ของ ${F1.loanNumber} หลังโพสต์ fee`,
      expected: `principalOutstanding ${toLak(toCents(F1.principal))}, fee ${fmt(feeExp)}, outstanding ${fmt(debtF1 + feeExp)}`,
      actual: `principalOutstanding ${quoteAfterFee?.principalOutstanding}, fee ${fmt(cent(quoteAfterFee?.fee ?? -1))}, outstanding ${fmt(cent(quoteAfterFee?.outstanding ?? -1))}`,
      pass:
        Number(quoteAfterFee?.principalOutstanding) === Number(F1.principal) &&
        cent(quoteAfterFee?.fee ?? -1) === feeExp &&
        cent(quoteAfterFee?.outstanding ?? -1) === debtF1 + feeExp,
    });

    const totalDueCents = debtF1 + feeExp;
    const aboveCap = await api('POST', `/api/settlements/${F1ag.id}/settlement-payment`, { token: tokens.op1, body: { cashAmount: toLak(totalDueCents) + 0.01 } });
    check(CAT, 'ชำระเงินปิดบัญชีเกิน agreedAmount + ค่าปรับ: 422 และข้อความระบุเพดานทั้งสองส่วน', {
      input: `cashAmount ${toLak(totalDueCents) + 0.01} เทียบ totalDue ${toLak(totalDueCents)}`,
      expected: '422 "exceeds the agreed amount ... plus its early-settlement fee"',
      actual: `HTTP ${aboveCap.status} ${errorMessage(aboveCap)}`,
      pass:
        aboveCap.status === 422 &&
        errorMessage(aboveCap).includes('exceeds the agreed amount') &&
        errorMessage(aboveCap).includes('plus its early-settlement fee'),
    });

    // Two drafts can both pass the create-time ceiling because that check compares one payment at a
    // time. The post-time ceiling (F-CONC-5) is what keeps the agreement paid once, and its ceiling
    // now includes the fee.
    const beforeFeeDrafts = { ...states.get(F1.id).components };
    const draftFull = await settleDraft(F1ag.id, { cashAmount: toLak(totalDueCents) });
    const draftPart = await settleDraft(F1ag.id, { cashAmount: toLak(feeExp) });
    const draftStatuses = await rows(conn, 'SELECT id, status FROM financial_transactions WHERE id IN (?)', [[draftFull.txId, draftPart.txId]]);
    const draftLoan = outstandingOf(await loanView(F1.id));
    check(CAT, 'create-time check เทียบค่าปิดบัญชีทีละฉบับ: อนุมัติค้างไว้สองฉบับพร้อมกันได้ (ยังไม่ขยับเงิน)', {
      input: `draft ${toLak(totalDueCents)} + draft ${toLak(feeExp)} บน agreement เดียวกัน`,
      expected: 'ทั้งสอง 201 + อนุมัติ 200 และ transaction อยู่สถานะ APPROVED (ยังไม่มี POSTED)',
      actual: `create ${draftFull.made.status}/${draftPart.made.status}, approve ${draftFull.approved?.status}/${draftPart.approved?.status}, db ${draftStatuses.map((r) => `${r.id.slice(0, 8)}:${r.status}`).join(' ')}`,
      pass:
        draftFull.made.status === 201 &&
        draftPart.made.status === 201 &&
        draftFull.approved?.status === 200 &&
        draftPart.approved?.status === 200 &&
        draftStatuses.length === 2 &&
        draftStatuses.every((r) => r.status === 'APPROVED') &&
        COMPS.every((c) => draftLoan[c] === beforeFeeDrafts[c]),
    });

    const postPart = await postTx(draftPart.txId);
    statusCheck(CAT, 'โพสต์ฉบับย่อยที่เท่าค่าปรับก่อน: 200', postPart, 200, { input: `POST /transactions/${draftPart.txId}/post` });
    await verifyPosted(F1, draftPart.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: feeExp }, 'settlement payment ส่วนค่าปรับ 25,000');
    const partAllocation = Object.fromEntries(COMPS.map((c) => [c, cent(postPart.json?.data?.allocation?.[c] ?? -1)]));
    check(CAT, 'เงินก้อนแรกใช้ค่าปรับก่อนเงินต้น: allocation เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL', {
      input: `จ่าย ${toLak(feeExp)} ตอนที่ PENALTY ${fmt(feeExp)} จากค่าปรับอยู่ในยอดคงค้าง`,
      expected: asLak(allocateComponents(feeExp, beforeFeeDrafts).allocation),
      actual: asLak(partAllocation),
      pass: COMPS.every((c) => partAllocation[c] === allocateComponents(feeExp, beforeFeeDrafts).allocation[c]) && partAllocation.PENALTY === feeExp,
    });

    const postFull = await postTx(draftFull.txId);
    check(CAT, 'เพดานตอนโพสต์นับค่าปรับรวมด้วย: ฉบับใหญ่ที่อนุมัติค้างไว้ถูกปฏิเสธเมื่อมีเงินถูกโพสต์ไปแล้ว', {
      input: `POST /transactions/${draftFull.txId.slice(0, 8)}/post หลังโพสต์ ${toLak(feeExp)}`,
      expected: `422 "already paid for ${toLak(feeExp)} of ${toLak(totalDueCents)} (${toLak(debtF1)} agreed plus ${toLak(feeExp)} early-settlement fee)"`,
      actual: `HTTP ${postFull.status} ${errorMessage(postFull)}`,
      pass:
        postFull.status === 422 &&
        errorMessage(postFull).includes('already paid for') &&
        errorMessage(postFull).includes(`${toLak(feeExp)} of ${toLak(totalDueCents)}`) &&
        errorMessage(postFull).includes('early-settlement fee'),
    });
    const stalledOutstanding = outstandingOf(await loanView(F1.id));
    check(CAT, 'การโพสต์ที่ถูกปฏิเสธไม่ขยับเงิน: ยอดคงค้างยังเท่า oracle (ไม่มี partial write)', {
      input: 'GET /api/loans/F1 หลังโพสต์ฉบับใหญ่ล้มเหลว',
      expected: asLak(states.get(F1.id).components),
      actual: asLak(stalledOutstanding),
      pass: COMPS.every((c) => stalledOutstanding[c] === states.get(F1.id).components[c]),
    });

    const lateWaive = await api('POST', `/api/settlements/${F1ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'จ่ายแค่ค่าปรับ ยังไม่ครบ agreedAmount' } });
    check(CAT, 'ยกยอดขาดไม่ได้ถ้ายังจ่ายไม่ครบ agreedAmount + ค่าปรับ: 422 ระบุยอดที่ต้องชำระรวม', {
      input: `netPaid ${toLak(feeExp)} เทียบ totalDue ${toLak(totalDueCents)}`,
      expected: `422 "are below what the agreement asks for (${toLak(totalDueCents)}: ${toLak(debtF1)} agreed plus ${toLak(feeExp)} early-settlement fee)"`,
      actual: `HTTP ${lateWaive.status} ${errorMessage(lateWaive)}`,
      pass:
        lateWaive.status === 422 &&
        errorMessage(lateWaive).includes('are below what the agreement asks for') &&
        errorMessage(lateWaive).includes(`${toLak(totalDueCents)}: ${toLak(debtF1)} agreed plus ${toLak(feeExp)} early-settlement fee`),
    });

    const beforeClose = { ...states.get(F1.id).components };
    const expClose = allocateComponents(debtF1, beforeClose);
    const F1payClose = await settlePay(F1ag.id, { cashAmount: toLak(debtF1) });
    await verifyPosted(F1, F1payClose.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: debtF1 }, `settlement payment ส่วนที่เหลือ ${fmt(debtF1)} ปิดบัญชี`);
    const closeAllocation = Object.fromEntries(COMPS.map((c) => [c, cent(F1payClose.posted?.json?.data?.allocation?.[c] ?? -1)]));
    check(CAT, 'ฉบับสุดท้ายใช้ดอกเบี้ยแล้วจึงเงินต้น (ค่าปรับถูกใช้ไปแล้ว) และไม่มีส่วนเกินไปเป็น credit', {
      input: `จ่าย ${toLak(debtF1)} บน ${asLak(beforeClose)}`,
      expected: `${asLak(expClose.allocation)} overpayment 0.00`,
      actual: `${asLak(closeAllocation)} excess ${String(F1payClose.posted?.json?.data?.excess)}`,
      pass: COMPS.every((c) => closeAllocation[c] === expClose.allocation[c]) && expClose.overpaymentCents === 0,
    });
    const afterF1 = await loanView(F1.id);
    check(CAT, 'จ่ายครบ agreedAmount + ค่าปรับแล้ว: F1 ปิดบัญชี (CLOSED) ยอดคงค้าง 0 โดยไม่ต้องยกยอดขาด', {
      input: F1.loanNumber,
      expected: { status: 'CLOSED', outstanding: '0.00' },
      actual: { status: afterF1?.status, outstanding: String(afterF1?.outstanding?.total) },
      pass: afterF1?.status === 'CLOSED' && sameMoney(afterF1?.outstanding?.total, 0),
    });
    const waiveAfterClose = await api('POST', `/api/settlements/${F1ag.id}/waive-shortfall`, { token: tokens.op1, body: { reason: 'ไม่มียอดขาดเหลือ' } });
    statusCheck(CAT, 'ปิดครบทั้งก้อนแล้ว: waive-shortfall ให้ 422 เพราะไม่มียอดขาด', waiveAfterClose, 422, {
      input: 'waive-shortfall หลังจ่ายครบ totalDue',
      messageIncludes: 'no outstanding shortfall to waive',
    });
    const f1Credit = await rows(conn, 'SELECT COUNT(*) n FROM credit_ledger WHERE customerId = ?', [C5]);
    check(CAT, 'ค่าปรับปิดก่อนกำหนดไม่กลายเป็น customer credit (ไม่มี overpayment เหลือจากเส้นทางนี้)', {
      input: 'credit_ledger ของ C5 หลังปิด F1 ครบทั้งก้อน',
      expected: '0 แถว',
      actual: `${f1Credit[0]?.n} แถว`,
      pass: Number(f1Credit[0]?.n ?? -1) === 0,
    });

    // A loan whose term has fully run pays no fee, so its agreement must not carry a pending charge.
    const F2debt = totalOf(states.get(F2.id).components);
    const F2ag = await newAgreement(F2, toLak(F2debt), { reason: 'ปิดบัญชีเมื่อสัญญาครบกำหนดแล้ว' });
    check(CAT, 'ข้อตกลงบนกู้ที่งวดครบทั้งสัญญา: earlySettlementFee = 0.00', {
      input: `POST /api/settlements บน ${F2.loanNumber}`,
      expected: { earlySettlementFee: '0.00', agreedAmount: fmt(F2debt) },
      actual: { earlySettlementFee: String(F2ag.agreement?.earlySettlementFee), agreedAmount: String(F2ag.agreement?.agreedAmount) },
      pass: sameMoney(F2ag.agreement?.earlySettlementFee, 0) && sameMoney(F2ag.agreement?.agreedAmount, toLak(F2debt)),
    });
    const f2Types = await txTypes(F2.id);
    check(CAT, 'ข้อตกลงแบบไม่มีค่าปรับไม่สร้าง transaction PENALTY ใด ๆ (เอกสารล้วน ๆ ตามกฎเดิม)', {
      input: `financial_transactions ของ ${F2.loanNumber}`,
      expected: 'DISBURSEMENT=1 เท่านั้น',
      actual: f2Types.map((r) => `${r.transactionType}:${r.status}=${r.n}`).join(' '),
      pass: f2Types.length === 1 && f2Types[0].transactionType === 'DISBURSEMENT' && f2Types[0].status === 'POSTED',
    });
    const F2pay = await settlePay(F2ag.id, { cashAmount: toLak(F2debt) });
    statusCheck(CAT, 'ปิดบัญชีเมื่อไม่มียอดค่าปรับ: รับ settlement-payment ได้ทันทีโดยไม่ต้องรอโพสต์อะไรเพิ่ม', F2pay.made, 201, {
      input: `settlement-payment ${toLak(F2debt)} บน agreement ที่ earlySettlementFee=0`,
    });
    if (F2pay.posted?.status === 200) {
      await verifyPosted(F2, F2pay.txId, { type: 'SETTLEMENT_PAYMENT', amountCents: F2debt }, 'settlement payment ปิด F2 (ไม่มีค่าปรับ)');
    }

    // ============================================================ F. agreements are immutable documents
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      statusCheck(CAT, `${method} /api/settlements/:id ไม่มี route (ห้ามแก้/ลบข้อตกลง): 404`, await api(method, `/api/settlements/${approvedMid.id}`, { token: tokens.admin, body: { agreedAmount: 1 } }), 404, {
        input: `${method} /api/settlements/:id`,
        messageIncludes: 'Not found',
      });
    }
    statusCheck(CAT, 'GET /api/settlements/:id ของ id ที่ไม่มีอยู่จริง: 404', await api('GET', '/api/settlements/00000000-9999-4000-8000-000000000097', { token: tokens.viewer }), 404, { messageIncludes: 'Settlement agreement not found' });

    const listAll = await api('GET', '/api/settlements?limit=100', { token: tokens.viewer });
    const listFiltered = await api('GET', `/api/settlements?loanId=${A2.id}&limit=100`, { token: tokens.viewer });
    check(CAT, 'GET /api/settlements?loanId= กรองเหลือเฉพาะของ loan นั้น', {
      input: `loanId=${A2.loanNumber}`,
      expected: { all: true, count: listFiltered.json.data.length },
      actual: { all: (listFiltered.json.data ?? []).every((a) => a.loanId === A2.id), count: (listFiltered.json.data ?? []).length },
      pass: (listFiltered.json.data ?? []).length > 0 && (listFiltered.json.data ?? []).every((a) => a.loanId === A2.id),
    });
    const listApproved = await api('GET', '/api/settlements?status=APPROVED&limit=100', { token: tokens.viewer });
    const listBogus = await api('GET', '/api/settlements?status=NOT_A_STATUS&limit=100', { token: tokens.viewer });
    check(CAT, 'filter status=APPROVED ได้เฉพาะ APPROVED; ค่าไม่รู้จักคืนรายการว่าง (200 ไม่ใช่ 400)', {
      input: 'status=APPROVED and status=NOT_A_STATUS',
      expected: { approvedOnly: true, bogus: 0, http: 200 },
      actual: {
        approvedOnly: (listApproved.json.data ?? []).every((a) => a.status === 'APPROVED'),
        bogus: (listBogus.json.data ?? []).length,
        http: listBogus.status,
      },
      pass: (listApproved.json.data ?? []).every((a) => a.status === 'APPROVED') && (listBogus.json.data ?? []).length === 0 && listBogus.status === 200,
    });
    const clamped = await api('GET', '/api/settlements?limit=500&page=0', { token: tokens.viewer });
    check(CAT, 'pagination clamp: limit 500 -> 100, page 0 -> 1', {
      input: 'GET /api/settlements?limit=500&page=0',
      expected: { page: 1, limit: 100 },
      actual: { page: clamped.json.pagination?.page, limit: clamped.json.pagination?.limit },
      pass: clamped.json.pagination?.limit === 100 && clamped.json.pagination?.page === 1,
    });

    // ============================================================ G. notifications + audit trail
    const notifRows = await rows(conn, "SELECT type, status, bodyText, bodyHtml, recipientEmail FROM notification_outbox WHERE loanId = ? AND type IN ('SETTLEMENT_REQUESTED','SETTLEMENT_DECIDED') ORDER BY createdAt", [A2.id]);
    check(CAT, 'เกิด notification SETTLEMENT_REQUESTED + SETTLEMENT_DECIDED ให้ลูกค้าของ loan', {
      input: A2.loanNumber,
      expected: ['SETTLEMENT_DECIDED', 'SETTLEMENT_REQUESTED'],
      actual: [...new Set(notifRows.map((r) => r.type))].sort().join(','),
      pass: ['SETTLEMENT_REQUESTED', 'SETTLEMENT_DECIDED'].every((t) => notifRows.some((r) => r.type === t)),
    });
    const requestedRow = notifRows.find((r) => r.type === 'SETTLEMENT_REQUESTED');
    check(CAT, 'เนื้อหา notification ถูกซีลในฐานข้อมูล แต่เปิดได้จริงและมีเลขสัญญาในข้อความ', {
      input: 'SETTLEMENT_REQUESTED body',
      expected: { sealed: true, includes: A2.loanNumber },
      actual: { sealed: isSealed(requestedRow?.bodyText), includes: String(unseal(requestedRow?.bodyText ?? '')).includes(A2.loanNumber) },
      pass: isSealed(requestedRow?.bodyText) && isSealed(requestedRow?.bodyHtml) && String(unseal(requestedRow?.bodyText)).includes(A2.loanNumber),
    });
    const auditRows = await rows(conn, 'SELECT action, amount, newStatus FROM audit_logs WHERE loanId = ? AND action LIKE ? ORDER BY createdAt', [A2.id, 'SETTLEMENT_AGREEMENT_%']);
    check(CAT, 'audit trail บันทึก CREATED + APPROVED ของข้อตกลง พร้อมมูลค่าและสถานะใหม่', {
      input: 'audit_logs actions for the A2 agreement',
      expected: ['SETTLEMENT_AGREEMENT_APPROVED', 'SETTLEMENT_AGREEMENT_CREATED'],
      actual: [...new Set(auditRows.map((r) => r.action))].sort().join(','),
      pass: ['SETTLEMENT_AGREEMENT_CREATED', 'SETTLEMENT_AGREEMENT_APPROVED'].every((a) => auditRows.some((r) => r.action === a)) && auditRows.every((r) => sameMoney(r.amount, 1500000) || r.newStatus === 'PENDING_APPROVAL' || r.newStatus === 'APPROVED'),
    });

    // ============================================================ H. ledger invariant over the whole suite
    const perLoan = await rows(
      conn,
      `SELECT t.loanId AS loanId, l.component AS component, SUM(l.amount) AS signedSum
       FROM financial_transactions t JOIN financial_transaction_lines l ON l.transactionId = t.id
       WHERE t.status = 'POSTED' AND t.loanId IN (?)
       GROUP BY t.loanId, l.component`,
      [createdLoans],
    );
    const mismatches = [];
    for (const loanId of createdLoans) {
      const want = states.get(loanId).components;
      for (const c of COMPS) {
        const fromLedger = cent(perLoan.find((r) => r.loanId === loanId && r.component === c)?.signedSum ?? 0);
        if (fromLedger !== want[c]) mismatches.push(`${loanId.slice(0, 8)}.${c}: Σ lines ${fmt(fromLedger)} vs oracle ${fmt(want[c])}`);
      }
    }
    check(CAT, `ทุก loan ของ suite (${createdLoans.length} ฉบับ): ยอดคงค้าง = Σ signed lines ของรายการ POSTED เท่านั้น (invariant #1)`, {
      input: 'loan book vs posted ledger',
      expected: 'no mismatch',
      actual: mismatches.length ? mismatches.join(' | ') : `${createdLoans.length} loans reconciled`,
      pass: mismatches.length === 0,
    });
    const totalRelief = await rows(
      conn,
      `SELECT t.loanId AS loanId, SUM(l.amount) AS signedSum FROM financial_transactions t JOIN financial_transaction_lines l ON l.transactionId = t.id
       WHERE t.status = 'POSTED' AND t.loanId IN (?) GROUP BY t.loanId`,
      [createdLoans],
    );
    const negatives = totalRelief.filter((r) => cent(r.signedSum) < 0);
    check(CAT, 'ไม่มี loan ใดมียอดคงค้างติดลบจากเส้นทาง settlement (จ่ายเกิน+ยกยอดต้องจบที่ 0)', {
      input: 'Σ signed lines per loan',
      expected: 'all >= 0',
      actual: negatives.length ? negatives.map((r) => `${r.loanId.slice(0, 8)}=${fmt(r.signedSum)}`).join(' ') : 'all >= 0',
      pass: negatives.length === 0,
    });
    const loanRows = await rows(conn, 'SELECT id, status, currentOutstanding FROM loans WHERE id IN (?)', [createdLoans]);
    const statusBad = loanRows.filter((r) => cent(r.currentOutstanding) === 0 ? r.status !== 'CLOSED' && r.status !== 'WRITTEN_OFF' : r.status !== 'ACTIVE');
    check(CAT, 'สถานะ loan ทุกฉบับสอดคล้องกับยอดคงค้าง (0 -> CLOSED, >0 -> ACTIVE)', {
      input: 'loans of the suite',
      expected: 'consistent',
      actual: statusBad.length ? statusBad.map((r) => `${r.id.slice(0, 8)} ${r.status} ${r.currentOutstanding}`).join(' ') : `${loanRows.length} loans consistent`,
      pass: statusBad.length === 0,
    });

    // ============================================================ I. seeded agreements untouched
    const seedNow = (await rows(conn, "SELECT id, agreementNo, status, agreedAmount FROM settlement_agreements WHERE agreementNo LIKE 'SA-TST-%' ORDER BY agreementNo")).map((r) => ({ id: r.id, no: r.agreementNo, status: r.status, amount: String(r.agreedAmount) }));
    check(CAT, 'ข้อมูล seed: agreement ทั้ง 4 ฉบับ (SA-TST-000001..4) ไม่ถูก suite นี้แก้', {
      input: 'seeded settlement_agreements',
      expected: JSON.stringify(seedAgreements),
      actual: JSON.stringify(seedNow),
      pass: JSON.stringify(seedAgreements) === JSON.stringify(seedNow),
    });

    // ============================================================ J. cleanup
    await settle();
    await purge();
    const counts = {};
    for (const t of Object.keys(baseline)) counts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const dirty = Object.keys(baseline).filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
      pass: dirty.length === 0,
    });
    const seededLoans = (await api('GET', '/api/loans?limit=100')).json;
    check(CAT, 'ข้อมูล seed ยังครบ 21 loan และยอดคงค้างรวมเท่าเดิม', {
      input: 'GET /api/loans after cleanup',
      expected: `${expected.rowCounts.loans} loans, outstanding ${expected.totals.closingOutstanding}`,
      actual: `${seededLoans.pagination?.total} loans, outstanding ${seededLoans.aggregates?.outstandingTotal}`,
      pass: seededLoans.pagination?.total === expected.rowCounts.loans && sameMoney(seededLoans.aggregates?.outstandingTotal, expected.totals.closingOutstanding),
    });
    statusCheck(CAT, 'agreement ของ suite หายจริงหลัง purge: 404', await api('GET', `/api/settlements/${approvedMid.id}`), 404, { input: approvedMid.id });
    const orphanWf = (
      await rows(conn, "SELECT COUNT(*) n FROM approval_workflows WHERE subjectType='SETTLEMENT_AGREEMENT' AND subjectId NOT IN (SELECT id FROM settlement_agreements)")
    )[0].n;
    const orphanAgreements = (await rows(conn, 'SELECT COUNT(*) n FROM settlement_agreements WHERE loanId NOT IN (SELECT id FROM loans)'))[0].n;
    check(CAT, 'ไม่เหลือ workflow หรือ agreement กำพร้าหลัง purge', {
      input: 'orphan SETTLEMENT_AGREEMENT workflows + orphan agreements',
      expected: '0 / 0',
      actual: `${orphanWf} / ${orphanAgreements}`,
      pass: orphanWf === 0 && orphanAgreements === 0,
    });
  } catch (err) {
    check(CAT, 'suite 08 ต้องรันจนจบโดยไม่ throw', {
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
