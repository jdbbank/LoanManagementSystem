// 3.16 Declining-balance interest ("ต้นเท่า ดอกลด"): the product-level pricing method, the single
// period billed at disbursement, the bulk accrue run, idempotency per loan+period, bulk
// maker-checker approval, and the schedule that must place every charge on the period the ledger
// says it belongs to.
//
// Everything here is created by the suite (products, loans, transactions) and removed again, so the
// seeded book that suites 09/10/15 compare against expected.json stays untouched. The FLAT loans
// double as the regression control: their behaviour must not move at all.
//
// Amounts stay under the CHECKER threshold so every approval is one level, and accrual probes pass
// an explicit `asOf` so the numbers are identical on every rerun.
import { api as http, errorMessage, payloadOf, rows, settle, statusCheck, check, USER_NAMES, withPinnedPolicies } from '../lib/harness.mjs';
import { billedInterestCents, decliningPeriodInterestCents, emptyComponents, fmt, newLoanState, postEvent, toCents, toLak } from '../oracle.mjs';

const CAT = 'interest';

const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const KEY = { PENALTY: 'penalty', PAST_INTEREST: 'pastInterest', PAST_PRINCIPAL: 'pastPrincipal' };
const asText = (c) => COMPS.map((k) => `${k}=${fmt(c[k] ?? 0)}`).join(' ');
const NIL = '00000000-0000-4000-8000-000000000099';

const DECL_CODE = 'TST-S16-DECL';
const DEFAULT_CODE = 'TST-S16-DEFAULT';
const DECL = { interestRate: 1.2, interestRatePeriod: 'MONTH', termValue: 12, termUnit: 'MONTH' };

const day = (d) => `${d}T00:00:00.000Z`;
const qs = (d) => `asOf=${encodeURIComponent(day(d))}`;

export default async function suite(ctx) {
  // Loans here are created and disbursed while interest accrues, so the KYC gate they run through and
  // the collection policy the accruals are counted against are pinned to the shipped defaults, then
  // put back — suite 13 edits both just before this one.
  return withPinnedPolicies(ctx.api, ['payment', 'kyc'], () => run(ctx));
}

async function run(ctx) {
  const { tokens, conn, api: adminApi } = ctx;
  // ctx.api defaults to the admin token; an anonymous case must pass token:null explicitly.
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : adminApi(method, path, opts));

  const seededFlat = ((await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? []).find((p) => p.code === 'TST-FLAT-M12');

  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';
  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';
  const CUSTOMERS = [C5, C6, C7, C8];

  const createdLoans = [];
  const createdTx = [];
  const createdProducts = [];
  // แถวของเหตุการณ์นี้ไม่ผูกกับรายการกู้ (loanId IS NULL) จึง purge ที่กรองด้วย loanId ไม่ถึง
  // -> จำ id ของแถวที่ suite นี้สร้างไว้ลบเอง
  const createdOutbox = [];
  const recordIds = [];

  /** The same cleanup runs before and after: a rerun without a wipe must start from a clean slate. */
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
      await conn.query(`DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`, [createdLoans]);
      await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [createdLoans, CUSTOMERS]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [createdLoans]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM settlement_agreements WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM reconciliation_records WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [createdLoans]);
    }
    if (createdProducts.length) {
      await conn.query("DELETE FROM audit_logs WHERE action LIKE 'LOAN_PRODUCT_%' AND reason LIKE '%TST-S16-%'");
      await conn.query('DELETE FROM loan_products WHERE id IN (?)', [createdProducts]);
    }
    if (createdOutbox.length) {
      await conn.query('DELETE FROM notification_outbox WHERE id IN (?)', [createdOutbox]);
    }
    createdLoans.length = 0;
    createdTx.length = 0;
    createdProducts.length = 0;
    createdOutbox.length = 0;
    recordIds.length = 0;
  };

  // ----------------------------------------------------------------------- reads
  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const outstandingCents = async (id) => {
    const v = await loanView(id);
    return Object.fromEntries(COMPS.map((c) => [c, cent(v.outstanding[KEY[c]])]));
  };
  const schedule = (id, asOfDate) => api('GET', `/api/loans/${id}/schedule?${qs(asOfDate)}`).then((r) => r.json?.data ?? null);
  const dueList = (asOfDate, loanIds) =>
    api('GET', `/api/transactions/interest/due?${qs(asOfDate)}${loanIds?.length ? `&loanIds=${loanIds.join(',')}` : ''}`).then((r) => r.json?.data ?? null);
  const accrue = (body, token = tokens.op1) => api('POST', '/api/transactions/interest/accrue', { token, body });
  const bulkDecide = (body, token) => api('POST', '/api/approvals/steps/bulk-decision', { token, body });
  const postTx = (id, token = tokens.admin) => api('POST', `/api/transactions/${id}/post`, { token });
  const txRow = (id) => rows(conn, 'SELECT id, transactionType, status, amount, periodIndex FROM financial_transactions WHERE id = ?', [id]).then((r) => r[0] ?? null);
  const allAccruals = (where = '', params = []) =>
    rows(conn, `SELECT id, loanId, status, amount, periodIndex FROM financial_transactions WHERE transactionType = 'INTEREST_ACCRUAL' ${where}`, params);
  const accrualCount = (where = '', params = []) => allAccruals(where, params).then((r) => r.length);
  const findStep = async (txId, token) => {
    const pending = await api('GET', '/api/approvals/pending?limit=200', { token });
    return (pending.json.data ?? []).find((i) => i.subjectId === txId) ?? null;
  };
  const stepOf = async (txId) => (await findStep(txId, tokens.checker1))?.stepId ?? null;

  const states = new Map();
  /** Oracle view of one suite loan: components in cents, mutated only through postEvent. */
  const track = (loan, principalCents, interestCents) =>
    states.set(loan.id, { ...newLoanState(loan.id, loan.customerId, { ...emptyComponents(), PAST_INTEREST: interestCents, PAST_PRINCIPAL: principalCents }, principalCents) });
  const chargeNow = async (id) => decliningPeriodInterestCents({ outstandingPrincipalCents: (await outstandingCents(id)).PAST_PRINCIPAL, ratePercent: DECL.interestRate, rateUnit: DECL.interestRatePeriod });
  // LOAN_PRODUCT_CREATED rows for one product code. The payload is sealed at rest, so the match has
  // to happen in JS: JSON_EXTRACT on `sealed:v1:` text is not valid JSON and would never match.
  const productMail = async (code) =>
    (
      await rows(
        conn,
        "SELECT id, recipientEmail, customerId, loanId, status, subject, payload FROM notification_outbox WHERE type = 'LOAN_PRODUCT_CREATED' ORDER BY recipientEmail",
        [],
      )
    ).filter((row) => payloadOf(row).productCode === code);

  const newProduct = async ({ code, name, interestMethod }) => {
    const res = await api('POST', '/api/loan-products', {
      token: tokens.admin,
      body: {
        code,
        name,
        interestRate: DECL.interestRate,
        interestRatePeriod: DECL.interestRatePeriod,
        termValue: DECL.termValue,
        termUnit: DECL.termUnit,
        ...(interestMethod ? { interestMethod } : {}),
        penaltyPolicy: { mode: 'NONE' },
      },
    });
    if (res.status !== 201) throw new Error(`product ${code} failed ${res.status} ${errorMessage(res)}`);
    createdProducts.push(res.json.product.id);
    createdOutbox.push(...(await productMail(code)).map((row) => row.id));
    return res.json.product;
  };

  const newLoan = async ({ product, customerId, principal, disbursedAt = '2026-01-15T09:00:00.000Z' }) => {
    const res = await api('POST', '/api/loans', { token: tokens.op1, body: { customerId, productId: product.id, principalAmount: principal, disbursedAt } });
    if (res.status !== 201) throw new Error(`loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    createdLoans.push(loan.id);
    return { id: loan.id, loanNumber: loan.loanNumber, customerId, principalCents: toCents(principal), product, disbursement: res.json.data.disbursementTransaction };
  };

  /** maker -> checker -> post for a cash payment, mirrored into the oracle state. */
  const pay = async (loan, cashCents) => {
    const made = await api('POST', '/api/payment-requests', { token: tokens.op1, body: { loanId: loan.id, cashAmount: toLak(cashCents) } });
    if (made.status !== 201) throw new Error(`payment failed ${made.status} ${errorMessage(made)}`);
    const approved = await api('POST', `/api/payment-requests/${made.json.data.request.id}/approve`, { token: tokens.checker1, body: {} });
    if (approved.status !== 200) throw new Error(`payment approve failed ${approved.status} ${errorMessage(approved)}`);
    createdTx.push(approved.json.data.transaction.id);
    const posted = await postTx(approved.json.data.transaction.id);
    if (posted.status !== 200) throw new Error(`payment post failed ${posted.status} ${errorMessage(posted)}`);
    return postEvent(states.get(loan.id), { type: 'PAYMENT', amountCents: cashCents, postedAtIso: '2026-02-01' });
  };

  try {
    await purge();

    // ================================================ A. the pricing method lives on the product
    const decl = await newProduct({ code: DECL_CODE, name: 'Suite16 declining 1.2%/mo 12m', interestMethod: 'DECLINING' });
    check(CAT, 'ผลิตภัณฑ์ตั้ง interestMethod = DECLINING ได้ และอ่านกลับค่าเดิมทั้ง API + DB', {
      input: `POST /api/loan-products code=${DECL_CODE} interestMethod=DECLINING`,
      expected: 'DECLINING',
      actual: `${decl.interestMethod} / db=${(await rows(conn, 'SELECT interestMethod FROM loan_products WHERE id = ?', [decl.id]))[0].interestMethod}`,
      pass: decl.interestMethod === 'DECLINING',
    });

    const byDefault = await newProduct({ code: DEFAULT_CODE, name: 'Suite16 method omitted' });
    check(CAT, 'ไม่ส่ง interestMethod = FLAT ซึ่งเป็นพฤติกรรมเดิมของผู้เรียกเก่า', {
      input: 'POST /api/loan-products โดยไม่ระบุ interestMethod',
      expected: 'FLAT',
      actual: byDefault.interestMethod,
      pass: byDefault.interestMethod === 'FLAT',
    });

    statusCheck(CAT, 'interestMethod ที่ไม่ใช่ FLAT/DECLINING: 400', await api('POST', '/api/loan-products', { token: tokens.admin, body: { code: 'TST-S16-BAD', name: 'bad method', interestRate: 1, interestMethod: 'REDUCING_MONTHLY' } }), 400, {
      input: 'interestMethod=REDUCING_MONTHLY',
      messageIncludes: 'Validation failed',
    });

    // ============================================ A2. LOAN_PRODUCT_CREATED: who hears about a new product
    const approverMails = (
      await rows(
        conn,
        "SELECT email FROM users WHERE role IN ('CHECKER','HEAD_APPROVER','ADMIN') AND isActive = 1 AND email IS NOT NULL AND email <> '' ORDER BY email",
      )
    ).map((r) => r.email);
    const adminAccount = (
      await rows(conn, 'SELECT email, fullName FROM users WHERE username = ?', [USER_NAMES.admin])
    )[0] ?? {};

    const declMail = await productMail(DECL_CODE);
    check(CAT, 'สร้างผลิตภัณฑ์ใหม่: ผู้รับคือผู้มีอำนาจทุกคน ยกเว้นผู้สร้าง (ADMIN สร้างจึงไม่มีเมลถึงตัวเอง)', {
      input: `type=LOAN_PRODUCT_CREATED, productCode=${DECL_CODE}`,
      expected: `${approverMails.length - 1} แถว = ผู้มีอำนาจ ${approverMails.length} คน ลบ ${adminAccount.email}`,
      actual: `${declMail.length} แถว: ${declMail.map((r) => r.recipientEmail).join(',')} | ถึงผู้สร้าง=${declMail.filter((r) => r.recipientEmail === adminAccount.email).length}`,
      pass:
        declMail.length === approverMails.length - 1 &&
        !declMail.some((r) => r.recipientEmail === adminAccount.email) &&
        approverMails.filter((m) => m !== adminAccount.email).every((m) => declMail.some((r) => r.recipientEmail === m)),
    });
    check(CAT, 'เมลผลิตภัณฑ์ไม่ผูกกับรายการกู้หรือลูกค้า: loanId/customerId NULL ทุกแถว และ subject มี code ของผลิตภัณฑ์', {
      input: 'loanId/customerId/subject ของแถวชุดนี้',
      expected: `loanId NULL + customerId NULL ทุกแถว, subject contains ${DECL_CODE}`,
      actual: `loanIdNull=${declMail.filter((r) => r.loanId === null).length}/${declMail.length} customerIdNull=${declMail.filter((r) => r.customerId === null).length}/${declMail.length} subjectHasCode=${declMail.every((r) => String(r.subject).includes(DECL_CODE))}`,
      pass: declMail.every((r) => r.loanId === null && r.customerId === null) && declMail.every((r) => String(r.subject).includes(DECL_CODE)),
      note: 'เหตุผลที่ suite ต้องลบแถวด้วย id: ไม่มี loanId ให้กรองแบบ suite อื่น',
    });

    const declPayload = payloadOf(declMail[0] ?? {});
    const defaultPayload = payloadOf((await productMail(DEFAULT_CODE))[0] ?? {});
    check(CAT, 'payload บอกเงื่อนไขตามที่เขาเก็บจริง: อัตรา+หน่วย, วิธีคำนวณ, ระยะเวลา, สกุลเงิน, ผู้สร้าง, วันที่', {
      input: `unseal(payload) ของ ${DECL_CODE} (DECLINING) เทียบ ${DEFAULT_CODE} (FLAT)`,
      expected: `productCode=${DECL_CODE}, productName=${decl.name}, interestRate ขึ้นต้น "1.2% / ", term ขึ้นต้น "12 " และใช้หน่วยเดียวกับอัตรา, currency=LAK, createdByName=${adminAccount.fullName}, createdDate=YYYY-MM-DD, ป้ายวิธีคำนวณของสองผลิตภัณฑ์ต่างกัน`,
      actual: JSON.stringify({
        ...declPayload,
        interestMethod: `<lao ${String(declPayload.interestMethod ?? '').length} chars>`,
        defaultInterestMethod: `<lao ${String(defaultPayload.interestMethod ?? '').length} chars>`,
      }),
      pass:
        declPayload.productCode === DECL_CODE &&
        declPayload.productName === decl.name &&
        defaultPayload.productCode === DEFAULT_CODE &&
        String(declPayload.interestRate).startsWith('1.2% / ') &&
        String(defaultPayload.interestRate).startsWith('1.2% / ') &&
        String(declPayload.term).startsWith('12 ') &&
        declPayload.term.endsWith(String(declPayload.interestRate).split(' / ')[1]) &&
        declPayload.currency === 'LAK' &&
        declPayload.createdByName === adminAccount.fullName &&
        /^\d{4}-\d{2}-\d{2}$/.test(String(declPayload.createdDate)) &&
        String(declPayload.interestMethod).length > 0 &&
        String(defaultPayload.interestMethod).length > 0 &&
        declPayload.interestMethod !== defaultPayload.interestMethod,
      note: 'หน่วยเวลาและข้อความ FLAT/DECLINING เป็นภาษาลาว จึงเทียบเฉพาะตัวเลข/คำนำหน้าและตรวจว่าสอง method ให้ป้ายต่างกัน -- suite ไม่ผูกกับ locale',
    });

    const badProductMail = await productMail('TST-S16-BAD');
    check(CAT, 'ผลิตภัณฑ์ที่สร้างไม่สำเร็จ (400 จาก interestMethod แปลกปลอม): ไม่เกิดเมลใหม่', {
      input: "productCode='TST-S16-BAD'",
      expected: '0 แถว',
      actual: `${badProductMail.length} แถว`,
      pass: badProductMail.length === 0,
      note: 'emit อยู่หลัง validateBody + สร้างแถวเดียวใน transaction เดียวกับ insert ผลิตภัณฑ์ การ reject จึงไม่มีอะไรเข้า outbox',
    });

    const patched = await api('PATCH', `/api/loan-products/${byDefault.id}`, { token: tokens.admin, body: { interestMethod: 'DECLINING' } });
    statusCheck(CAT, 'PATCH เปลี่ยนผลิตภัณฑ์เป็น DECLINING: 200', patched, 200, { input: 'interestMethod=DECLINING' });
    const patchAudit = (await rows(conn, "SELECT reason FROM audit_logs WHERE action = 'LOAN_PRODUCT_UPDATED' AND reason LIKE '%TST-S16-DEFAULT%' ORDER BY createdAt DESC LIMIT 1"))[0]?.reason ?? '';
    check(CAT, 'audit ของ PATCH describes วิธีคิดดอกเบี้ยให้อ่านรู้เรื่องโดยไม่ lookup', {
      input: `${byDefault.code} -> DECLINING`,
      expected: `product DECLINING + audit reason contains "declining balance"`,
      actual: `${patched.json.product?.interestMethod} / ${String(patchAudit).slice(0, 140)}`,
      pass: patched.json.product?.interestMethod === 'DECLINING' && /declining balance/.test(patchAudit),
    });

    const flatProducts = ((await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? []).filter((p) => /^TST-/.test(p.code) && p.id !== decl.id && p.id !== byDefault.id);
    check(CAT, 'ผลิตภัณฑ์ seed เดิมทั้งสมุดยัง FLAT (ค่า default ไม่ไปแก้ของที่มีอยู่ก่อน)', {
      input: `${flatProducts.length} seeded products`,
      expected: 'all FLAT',
      actual: [...new Set(flatProducts.map((p) => p.interestMethod))].join(',') || 'n/a',
      pass: flatProducts.length > 0 && flatProducts.every((p) => p.interestMethod === 'FLAT'),
    });

    // ================================================ B. disbursement bills exactly one period
    const first = (principalCents) => decliningPeriodInterestCents({ outstandingPrincipalCents: principalCents, ratePercent: DECL.interestRate, rateUnit: DECL.interestRatePeriod });
    const A = await newLoan({ product: decl, customerId: C5, principal: 1200000 });
    const B = await newLoan({ product: decl, customerId: C6, principal: 1200000 });
    const C = await newLoan({ product: seededFlat, customerId: C7, principal: 200000 });
    // D closes in section I, so it is disbursed a full term back — the collection gate refuses cash
    // that reaches instalments which have not arrived yet.
    const D = await newLoan({ product: decl, customerId: C8, principal: 100000, disbursedAt: '2025-01-15T09:00:00.000Z' });
    track(A, A.principalCents, first(A.principalCents));
    track(B, B.principalCents, first(B.principalCents));
    track(D, D.principalCents, first(D.principalCents));
    const flatCents = billedInterestCents({ principalCents: C.principalCents, ratePercent: seededFlat.interestRate, rateUnit: seededFlat.interestRatePeriod, termValue: seededFlat.termValue, termUnit: seededFlat.termUnit });
    track(C, C.principalCents, flatCents);

    for (const loan of [A, B, D]) {
      const want = first(loan.principalCents);
      const view = await loanView(loan.id);
      const row = await txRow(loan.disbursement.id);
      const flatLump = billedInterestCents({ principalCents: loan.principalCents, ratePercent: DECL.interestRate, rateUnit: 'MONTH', termValue: 12, termUnit: 'MONTH' });
      check(CAT, `${loan.loanNumber}: DISBURSEMENT บิลดอกเบี้ยแค่งวดแรกงวดเดียว = ${fmt(want)} (ต้น ${fmt(loan.principalCents)} x ${DECL.interestRate}%/เดือน)`, {
        input: 'oracle.decliningPeriodInterestCents(P, 1 period)',
        expected: `pastInterest ${fmt(want)}, outstanding ${fmt(want + loan.principalCents)}, tx.amount ${fmt(want + loan.principalCents)}`,
        actual: `pastInterest ${view.outstanding.pastInterest}, outstanding ${view.outstanding.total}, tx.amount ${row.amount}`,
        pass: sameMoney(view.outstanding.pastInterest, toLak(want)) && sameMoney(view.outstanding.total, toLak(want + loan.principalCents)) && sameMoney(row.amount, toLak(want + loan.principalCents)),
      });
      check(CAT, `${loan.loanNumber}: ไม่ bill ดอกทั้ง_termก้อนเดียว (FLAT would be ${fmt(flatLump)} > booked ${fmt(want)})`, {
        input: `oracle.billedInterestCents over 12m = ${fmt(flatLump)}`,
        expected: `interest booked = period 1 only (${fmt(want)})`,
        actual: `interest booked = ${fmt(toCents(view.outstanding.pastInterest))}`,
        pass: cent(view.outstanding.pastInterest) === want && want < flatLump,
      });
      check(CAT, `${loan.loanNumber}: loan snapshot interestMethod = DECLINING ทั้ง API และ DB`, {
        input: 'loans.interestMethod',
        expected: 'DECLINING',
        actual: `${view.interestMethod} / db=${(await rows(conn, 'SELECT interestMethod FROM loans WHERE id = ?', [loan.id]))[0].interestMethod}`,
        pass: view.interestMethod === 'DECLINING',
      });
      check(CAT, `${loan.loanNumber}: แถว DISBURSEMENT ถือ periodIndex = 1 (งวดแรกที่จ่ายไปตอนปล่อยกู้)`, {
        input: 'financial_transactions.periodIndex',
        expected: '1',
        actual: String(row.periodIndex),
        pass: Number(row.periodIndex) === 1,
      });
    }

    const cView = await loanView(C.id);
    const cRow = await txRow(C.disbursement.id);
    check(CAT, `${C.loanNumber} (FLAT control): ยัง bill ก้อนเดียว ${fmt(flatCents)} และ periodIndex = NULL`, {
      input: 'oracle.billedInterestCents + DB periodIndex',
      expected: `pastInterest ${fmt(flatCents)}, periodIndex NULL, method FLAT`,
      actual: `pastInterest ${cView.outstanding.pastInterest}, periodIndex ${cRow.periodIndex}, method ${cView.interestMethod}`,
      pass: sameMoney(cView.outstanding.pastInterest, toLak(flatCents)) && cRow.periodIndex === null && cView.interestMethod === 'FLAT',
    });

    // ================================================ C. the schedule places charges per period
    const sA0 = await schedule(A.id, '2026-02-16');
    check(CAT, `${A.loanNumber}: schedule บอก interestMethod = DECLINING และนับงวดตาม term (12)`, {
      input: 'GET /loans/:id/schedule?asOf=2026-02-16',
      expected: 'interestMethod DECLINING, 12 periods',
      actual: `${sA0.interestMethod}, ${sA0.periods.length} periods`,
      pass: sA0.interestMethod === 'DECLINING' && sA0.periods.length === 12,
    });
    check(CAT, `${A.loanNumber}: ก่อน accrual ดอกเบี้ยอยู่แค่งวด 1 ส่วนงวด 2..12 เป็น 0`, {
      input: 'periods[].interestDue',
      expected: `p1 ${fmt(first(A.principalCents))}, p2..p12 0.00`,
      actual: sA0.periods.map((p) => fmt(toCents(p.interestDue))).join(','),
      pass: cent(sA0.periods[0].interestDue) === first(A.principalCents) && sA0.periods.slice(1).every((p) => cent(p.interestDue) === 0),
    });

    // B prepays inside period 1, which must not re-price the period already billed.
    await pay(B, toCents(100000));
    const bAfterPay = await outstandingCents(B.id);
    check(CAT, `${B.loanNumber}: ชำระกลางงวด 100,000.00 -> จ่ายดอกว่างวด 1 ก่อน แล้วที่เหลือตัดเงินต้น (PENALTY->INTEREST->PRINCIPAL)`, {
      input: 'payment 100000.00',
      expected: asText(states.get(B.id).components),
      actual: asText(bAfterPay),
      pass: COMPS.every((c) => bAfterPay[c] === states.get(B.id).components[c]),
    });
    const sB0 = await schedule(B.id, '2026-02-16');
    check(CAT, `${B.loanNumber}: prepay กลางงวดไม่ re-price งวด 1 ที่ bill แล้ว (ไม่ prorate รายวัน)`, {
      input: 'periods[0].interestDue หลังชำระเงินต้น',
      expected: fmt(first(B.principalCents)),
      actual: fmt(toCents(sB0.periods[0].interestDue)),
      pass: cent(sB0.periods[0].interestDue) === first(B.principalCents),
    });

    // ================================================ D. the due list and the accrual window
    const earlyDue = await dueList('2026-02-01', [A.id, B.id]);
    check(CAT, 'asOf ยังไม่ถึงต้นงวด 2: ไม่มีอะไรต้องเก็บ และ skipped ว่างวดที่เริ่มไปแล้วถูก bill หมด', {
      input: 'GET /interest/due?asOf=2026-02-01&loanIds=A,B (งวด 2 เริ่ม 2026-02-15)',
      expected: 'items 0, skipped 2, reason "Every period that has started is already billed"',
      actual: `items ${earlyDue.items.length}, skipped ${earlyDue.skipped.length} [${[...new Set(earlyDue.skipped.map((s) => s.reason))].join(' | ')}]`,
      pass: earlyDue.items.length === 0 && earlyDue.skipped.length === 2 && earlyDue.skipped.every((s) => /already billed/.test(s.reason)),
    });

    const due = await dueList('2026-02-16', [A.id, B.id]);
    const wantA = await chargeNow(A.id);
    const wantB = await chargeNow(B.id);
    const aBase = await outstandingCents(A.id);
    const byId = Object.fromEntries(due.items.map((i) => [i.loanId, i]));
    check(CAT, 'asOf เลยต้นงวด 2 แล้ว: due list คืนงวดถัดไปของทั้งสองกู้ ยอดคำนวณจากเงินต้นคงเหลือจริง', {
      input: 'GET /interest/due?asOf=2026-02-16&loanIds=A,B',
      expected: `A p2 ${fmt(wantA)} (base ${fmt(aBase.PAST_PRINCIPAL)}), B p2 ${fmt(wantB)} (base ${fmt(bAfterPay.PAST_PRINCIPAL)})`,
      actual: due.items.map((i) => `${i.loanNumber} p${i.periodIndex} amount=${i.amount} base=${i.baseOutstandingPrincipal} start=${String(i.periodStart).slice(0, 10)}`).join(' | '),
      pass: due.items.length === 2 && cent(byId[A.id]?.amount) === wantA && cent(byId[B.id]?.amount) === wantB && byId[A.id]?.periodIndex === 2 && byId[B.id]?.periodIndex === 2,
    });
    check(CAT, `กู้ที่จ่ายต้นกลางงวดถูก bill งวดถัดไปถูกลง (${fmt(wantB)} < ${fmt(wantA)}) — base คือยอดคงเหลือ ไม่ใช่เงินต้นตอนปล่อยกู้`, {
      input: `B base ${toLak(bAfterPay.PAST_PRINCIPAL)} x ${DECL.interestRate}%`,
      expected: fmt(wantB),
      actual: fmt(toCents(byId[B.id]?.amount)),
      pass: cent(byId[B.id]?.amount) === wantB && wantB < wantA,
    });
    check(CAT, 'due list มี totals ครบ (loans/periods/amount) และแต่ละแถวมี loanNumber + customerName ให้ UI ใช้ได้ทันที', {
      input: 'GET /interest/due',
      expected: `loans 2, periods 2, amount ${fmt(wantA + wantB)}`,
      actual: `${JSON.stringify(due.totals)} names=${due.items.every((i) => !!i.customerName)}`,
      pass: due.totals.loans === 2 && due.totals.periods === 2 && sameMoney(due.totals.amount, toLak(wantA + wantB)) && due.items.every((i) => typeof i.customerName === 'string' && i.customerName.length > 0),
    });

    const flatDue = await dueList('2026-02-16', [C.id]);
    check(CAT, 'กู้ FLAT ไม่โผล่ใน due list เลย (ไม่ถูก query ทั้ง items และ skipped)', {
      input: `GET /interest/due?loanIds=${C.loanNumber}`,
      expected: 'items 0, skipped 0',
      actual: `items ${flatDue.items.length}, skipped ${flatDue.skipped.length}`,
      pass: flatDue.items.length === 0 && flatDue.skipped.length === 0,
    });

    const farDue = await dueList('2028-01-01', [B.id]);
    check(CAT, 'asOf เลยไปหลายงวด: เรียกเก็บทีละงวดต่อครั้ง และ missingPeriods นับงวดที่ยังไม่ bill ครบ', {
      input: 'GET /interest/due?asOf=2028-01-01&loanIds=B (bill แล้วแค่งวด 1)',
      expected: 'items 1, periodIndex 2, termPeriods 12, missingPeriods 11',
      actual: farDue.items.map((i) => `p${i.periodIndex} term ${i.termPeriods} missing ${i.missingPeriods}`).join(','),
      pass: farDue.items.length === 1 && farDue.items[0].periodIndex === 2 && farDue.items[0].termPeriods === 12 && farDue.items[0].missingPeriods === 11,
      note: 'ถ้ายิงหลายงวดพร้อมกัน ทุกงวดจะถูกคิดจากยอดวันนี้ ซึ่งแพง/ถูกเกินจริง',
    });

    // ================================================ E. accrue: dryRun, idempotency, limits
    const rowsBefore = await accrualCount();
    const dry = await accrue({ asOf: day('2026-02-16'), loanIds: [A.id, B.id], dryRun: true });
    statusCheck(CAT, 'accrue แบบ dryRun: 200 พร้อม wouldCreate แต่ไม่มีแถวเกิดขึ้นจริง', dry, 200, { input: 'dryRun=true' });
    check(CAT, 'dryRun คืน wouldCreate ตรงกับ due list และไม่สร้าง INTEREST_ACCRUAL', {
      input: 'POST /interest/accrue dryRun',
      expected: `wouldCreate 2, created 0, INTEREST_ACCRUAL rows = ${rowsBefore}`,
      actual: `wouldCreate ${dry.json.data.wouldCreate.length}, created ${dry.json.data.created.length}, rows ${await accrualCount()}`,
      pass: dry.json.data.wouldCreate.length === 2 && dry.json.data.created.length === 0 && (await accrualCount()) === rowsBefore,
    });

    const run1 = await accrue({ asOf: day('2026-02-16'), loanIds: [A.id, B.id], reason: 'monthly interest run (suite 16)' });
    statusCheck(CAT, 'accrue จริง: 201 สร้าง INTEREST_ACCRUAL ต่อกู้หนึ่งรายการ', run1, 201, { input: 'POST /interest/accrue' });
    const made = run1.json.data.created ?? [];
    for (const item of made) createdTx.push(item.transactionId);
    const madeRows = [];
    for (const item of made) madeRows.push(await txRow(item.transactionId));
    check(CAT, 'รายการที่สร้างเป็น PENDING_APPROVAL, periodIndex = 2, ยอดตรงกับ due list', {
      input: 'financial_transactions ของรอบ accrue แรก',
      expected: `2 rows, PENDING_APPROVAL, periodIndex 2, รวม ${fmt(wantA + wantB)}`,
      actual: madeRows.map((r) => `${r.status} p${r.periodIndex} ${r.amount}`).join(' | '),
      pass: made.length === 2 && madeRows.every((r) => r.status === 'PENDING_APPROVAL' && Number(r.periodIndex) === 2) && sameMoney(madeRows.reduce((s, r) => s + Number(r.amount), 0), toLak(wantA + wantB)),
    });
    const run1Reason = (await rows(conn, 'SELECT reason FROM financial_transactions WHERE id = ?', [made[0].transactionId]))[0]?.reason ?? '';
    check(CAT, 'accrue รับ reason จากผู้ใช้งานไปเก็บตรงๆ (ให้บันทึกชุดดอกทั้งรอบอธิบายตัวเองได้)', {
      input: 'POST /interest/accrue + reason="monthly interest run (suite 16)"',
      expected: 'reason = ข้อความที่ส่งไป',
      actual: run1Reason,
      pass: run1Reason === 'monthly interest run (suite 16)',
    });

    const aAfterAccrue = await outstandingCents(A.id);
    const bAfterAccrue = await outstandingCents(B.id);
    check(CAT, 'ดอกเบี้ยที่ยัง PENDING_APPROVAL ต้องไม่ขยับยอดคงค้าง (maker-checker ยังไม่จบ)', {
      input: 'loan outstanding หลัง accrue ก่อน approve',
      expected: `A ${asText(states.get(A.id).components)}, B ${asText(states.get(B.id).components)}`,
      actual: `A ${asText(aAfterAccrue)}, B ${asText(bAfterAccrue)}`,
      pass: COMPS.every((c) => aAfterAccrue[c] === states.get(A.id).components[c] && bAfterAccrue[c] === states.get(B.id).components[c]),
    });

    const again = await accrue({ asOf: day('2026-02-16'), loanIds: [A.id, B.id] });
    check(CAT, 'accrue ซ้ำด้วย asOf เดิม: ไม่สร้างอะไรเพิ่ม (idempotent ต่อ loan+periodIndex)', {
      input: 'POST /interest/accrue ซ้ำครั้งที่สอง',
      expected: `created 0, totals 0, INTEREST_ACCRUAL rows ไม่เพิ่มจาก ${made.length}`,
      actual: `created ${again.json.data.created.length}, totals ${JSON.stringify(again.json.data.totals)}, rows ${await accrualCount()}`,
      pass: again.json.data.created.length === 0 && cent(again.json.data.totals.amount) === 0 && (await accrualCount()) === rowsBefore + made.length,
    });

    const tooEarly = await accrue({ asOf: day('2026-02-01'), loanIds: [A.id, B.id] });
    check(CAT, 'accrue ด้วย asOf ก่อนงวดเริ่ม: ไม่สร้างย้อนหลัง (created 0)', {
      input: 'asOf=2026-02-01 (งวด 2 เริ่ม 2026-02-15)',
      expected: 'created 0',
      actual: `created ${tooEarly.json.data.created.length}, skipped ${tooEarly.json.data.skipped.length}`,
      pass: tooEarly.json.data.created.length === 0,
    });

    statusCheck(CAT, 'accrue ไม่มี token: 401', await accrue({ loanIds: [A.id] }, null), 401, { input: 'anonymous' });
    statusCheck(CAT, 'accrue ด้วย VIEWER: 403', await accrue({ loanIds: [A.id] }, tokens.viewer), 403, { input: 'test_view1', messageIncludes: 'Requires role' });
    statusCheck(CAT, 'accrue ด้วย asOf ไม่ถูก format: 400', await accrue({ asOf: '2026-13-45', loanIds: [A.id] }), 400, { input: 'asOf=2026-13-45', messageIncludes: 'Validation failed' });
    statusCheck(CAT, 'accrue ด้วย loanIds ที่ไม่ใช่ uuid: 400', await accrue({ loanIds: ['not-a-uuid'] }), 400, { input: 'loanIds=["not-a-uuid"]', messageIncludes: 'Validation failed' });

    // ================================================ F. bulk maker-checker
    const stepA = await stepOf(made.find((c) => c.loanId === A.id).transactionId);
    const stepB = await stepOf(made.find((c) => c.loanId === B.id).transactionId);
    statusCheck(CAT, 'bulk-decision ด้วย MAKER: 403', await bulkDecide({ stepIds: [stepA], decision: 'APPROVE' }, tokens.op1), 403, { input: 'test_op1', messageIncludes: 'Requires role' });
    statusCheck(CAT, 'bulk-decision ด้วย VIEWER: 403', await bulkDecide({ stepIds: [stepA], decision: 'APPROVE' }, tokens.viewer), 403, { input: 'test_view1' });
    statusCheck(CAT, 'bulk-decision ไม่มี token: 401', await bulkDecide({ stepIds: [stepA], decision: 'APPROVE' }, null), 401, { input: 'anonymous' });
    statusCheck(CAT, 'bulk-decision stepIds ว่าง: 400', await bulkDecide({ stepIds: [], decision: 'APPROVE' }, tokens.checker1), 400, { input: 'stepIds=[]', messageIncludes: 'Validation failed' });
    statusCheck(
      CAT,
      'bulk-decision เกิน 200 step ต่อคำขอ: 400',
      await bulkDecide({ stepIds: Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), decision: 'APPROVE' }, tokens.checker1),
      400,
      { input: '201 stepIds', messageIncludes: 'Validation failed' },
    );

    const bulk = await bulkDecide({ stepIds: [stepA, stepB], decision: 'APPROVE' }, tokens.checker1);
    statusCheck(CAT, 'bulk approve สองงวดในคำขอเดียว: 200', bulk, 200, { input: 'stepIds=[A,B]' });
    check(CAT, 'bulk-decision รายงานรายข้อ (requested/decided/declined + subjectId ต่อข้อ) ให้ UI ลิสต์ผลได้', {
      input: 'POST /approvals/steps/bulk-decision',
      expected: 'requested 2, decided 2, declined 0, ทุกข้อมี ok+subjectId',
      actual: JSON.stringify({ requested: bulk.json.data.requested, decided: bulk.json.data.decided, declined: bulk.json.data.declined, results: bulk.json.data.results.map((r) => ({ ok: r.ok, hasSubject: !!r.subjectId })) }),
      pass: bulk.json.data.requested === 2 && bulk.json.data.decided === 2 && bulk.json.data.declined === 0 && bulk.json.data.results.every((r) => r.ok && r.subjectId),
    });
    check(CAT, 'หลัง bulk approve ทั้งสอง workflow ต้อง APPROVED (transaction พร้อมโพสต์)', {
      input: 'financial_transactions หลัง bulk approve',
      expected: 'both APPROVED',
      actual: (await Promise.all(made.map((c) => txRow(c.transactionId)))).map((r) => r.status).join(','),
      pass: (await Promise.all(made.map((c) => txRow(c.transactionId)))).every((r) => r.status === 'APPROVED'),
    });

    for (const item of made) {
      const posted = await postTx(item.transactionId);
      if (posted.status !== 200) throw new Error(`interest post failed ${posted.status} ${errorMessage(posted)}`);
      postEvent(states.get(item.loanId), { type: 'INTEREST_ACCRUAL', amountCents: cent(item.amount), postedAtIso: '2026-02-16' });
    }
    const aPosted = await outstandingCents(A.id);
    const bPosted = await outstandingCents(B.id);
    check(CAT, 'หลัง approve+post: ยอดคงค้างเพิ่มเท่าดอกเบี้ยที่โพสต์ ตรงกับ oracle ทุก component', {
      input: 'loan outstanding vs oracle postEvent(INTEREST_ACCRUAL)',
      expected: `A ${asText(states.get(A.id).components)} | B ${asText(states.get(B.id).components)}`,
      actual: `A ${asText(aPosted)} | B ${asText(bPosted)}`,
      pass: COMPS.every((c) => aPosted[c] === states.get(A.id).components[c] && bPosted[c] === states.get(B.id).components[c]),
    });

    const lineBad = [];
    for (const item of made) {
      const lines = await rows(conn, 'SELECT component, SUM(amount) s FROM financial_transaction_lines WHERE transactionId = ? GROUP BY component', [item.transactionId]);
      if (!(lines.length === 1 && lines[0].component === 'PAST_INTEREST' && cent(lines[0].s) === cent(item.amount))) lineBad.push(`${String(item.transactionId).slice(0, 8)} ${JSON.stringify(lines)}`);
    }
    check(CAT, 'ทุก INTEREST_ACCRUAL ที่ POSTED มีเส้นเดียวเป็น PAST_INTEREST = จำนวนเงิน (ไม่แตะต้น/ค่าปรับ)', {
      input: 'financial_transaction_lines ของรอบ accrue',
      expected: '1 line PAST_INTEREST ต่อ transaction',
      actual: lineBad.length ? lineBad.join(' | ') : `${made.length} transactions, all single interest lines`,
      pass: lineBad.length === 0,
    });

    // ================================================ G. schedule + next-period suggestion
    const sA = await schedule(A.id, '2026-02-16');
    const sB = await schedule(B.id, '2026-02-16');
    check(CAT, `${A.loanNumber}: งวด 2 แสดงดอกเบี้ย ${fmt(wantA)} ตามงวดที่ ledger บันทึก (ไม่วางกองที่งวดแรก)`, {
      input: 'periods[0..1].interestDue',
      expected: `p1 ${fmt(first(A.principalCents))}, p2 ${fmt(wantA)}`,
      actual: `p1 ${fmt(toCents(sA.periods[0].interestDue))}, p2 ${fmt(toCents(sA.periods[1].interestDue))}`,
      pass: cent(sA.periods[0].interestDue) === first(A.principalCents) && cent(sA.periods[1].interestDue) === wantA,
    });
    check(CAT, `${B.loanNumber}: งวด 2 = ${fmt(wantB)} วางถูกงวด และผลรวม = interestCharged`, {
      input: 'periods interestDue sum',
      expected: `p2 ${fmt(wantB)}, sum ${sB.totals.interestCharged}`,
      actual: `p2 ${fmt(toCents(sB.periods[1].interestDue))}, sum ${fmt(sB.periods.reduce((x, p) => x + toCents(p.interestDue), 0))}, charged ${sB.totals.interestCharged}`,
      pass: cent(sB.periods[1].interestDue) === wantB && sameMoney(sB.periods.reduce((x, p) => x + Number(p.interestDue), 0), sB.totals.interestCharged),
    });
    const sC = await schedule(C.id, '2026-02-16');
    const sumBad = [sA, sB, sC].filter((s) => !sameMoney(s.periods.reduce((x, p) => x + Number(p.interestDue), 0), s.totals.interestCharged));
    check(CAT, 'sum(interestDue) = totals.interestCharged = เส้น ledger ทุกกู้ (DECLINING ไม่ทำให้ค่างวดรวมเกิน/ขาด)', {
      input: 'schedule totals vs ledger charges (A, B, C)',
      expected: 'no loan with a mismatch',
      actual: sumBad.length ? sumBad.map((s) => `${s.totals.interestCharged} vs ${fmt(s.periods.reduce((x, p) => x + toCents(p.interestDue), 0))}`).join(' | ') : 'A, B, C all exact',
      pass: sumBad.length === 0,
    });
    check(CAT, `${C.loanNumber} (FLAT control): schedule ยังแบ่งดอกเบี้ยเท่ากันทุกงวด + interestSuggested = 0`, {
      input: 'schedule of the FLAT loan',
      expected: `sum ${fmt(flatCents)}, suggested 0.00, method FLAT`,
      actual: `sum ${fmt(sC.periods.reduce((x, p) => x + toCents(p.interestDue), 0))}, suggested ${sC.totals.interestSuggested}, method ${sC.interestMethod}`,
      pass: sameMoney(sC.periods.reduce((x, p) => x + Number(p.interestDue), 0), sC.totals.interestCharged) && cent(sC.totals.interestSuggested) === 0 && sC.interestMethod === 'FLAT',
    });
    check(CAT, 'interestSuggested = 0 เมื่อ asOf ยังไม่ถึงต้นงวดถัดไป (ไม่เสนอย้อนหลัง/ไม่เสนอเกิน)', {
      input: 'schedule?asOf=2026-02-16 totals.interestSuggested (งวด 3 เริ่ม 2026-03-15)',
      expected: '0.00',
      actual: `${sA.totals.interestSuggested}`,
      pass: cent(sA.totals.interestSuggested) === 0,
    });
    const sA2 = await schedule(A.id, '2026-03-16');
    const wantP3 = await chargeNow(A.id);
    check(CAT, 'พอ asOf เข้างวด 3 interestSuggested ขึ้นเป็นยอดงวด 3 ทันที เท่ากับที่ due list คำนวณ', {
      input: 'schedule?asOf=2026-03-16 totals.interestSuggested',
      expected: fmt(wantP3),
      actual: `${sA2.totals.interestSuggested}`,
      pass: cent(sA2.totals.interestSuggested) === wantP3,
    });

    // ================================================ H. maker cannot approve, reject then re-bill
    const run3 = await accrue({ asOf: day('2026-03-16'), loanIds: [A.id] }, tokens.checker2);
    statusCheck(CAT, 'accrue โดย CHECKer (เป็นผู้สร้างรายการเอง): 201', run3, 201, { input: 'token=checker2' });
    const thirdTx = run3.json.data.created[0];
    createdTx.push(thirdTx.transactionId);
    const thirdReason = (await rows(conn, 'SELECT reason FROM financial_transactions WHERE id = ?', [thirdTx.transactionId]))[0]?.reason ?? '';
    check(CAT, 'ไม่ส่ง reason: ระบบเขียนข้อความอธิบายฐานคำนวณเอง (งวด/term, เงินต้นคงเหลือ, อัตรา)', {
      input: 'POST /interest/accrue โดยไม่ระบุ reason',
      expected: 'ขึ้นต้นด้วย "Interest 3/12 on <base> LAK outstanding principal (1.2%/month)"',
      actual: thirdReason,
      pass: /^Interest 3\/12 on [\d.]+ LAK outstanding principal \(1\.2%\/month\), period from 2026-03-15$/.test(thirdReason),
    });
    const thirdStep = await stepOf(thirdTx.transactionId);
    const selfRun = await bulkDecide({ stepIds: [thirdStep, NIL], decision: 'APPROVE' }, tokens.checker2);
    check(CAT, 'bulk-decision กัน maker อนุมัติงานตัวเอง + step ที่ไม่มีอยู่: ไม่ล่มทั้งคลัง, declined รายข้อพร้อมเหตุผล', {
      input: 'approver = checker2 (maker ของเอง), [step, bogus uuid]',
      expected: 'decided 0, declined 2, ข้อแรก "Maker-Checker separation", ข้อสอง not found',
      actual: JSON.stringify({ requested: selfRun.json.data.requested, decided: selfRun.json.data.decided, declined: selfRun.json.data.declined, errors: selfRun.json.data.results.map((r) => r.error) }),
      pass: selfRun.json.data.decided === 0 && selfRun.json.data.declined === 2 && /Maker-Checker separation/.test(selfRun.json.data.results[0].error ?? '') && /not found/i.test(selfRun.json.data.results[1].error ?? ''),
    });
    check(CAT, 'ข้อที่ declined ใน bulk ต้องไม่เปลี่ยนสถานะ transaction (ยัง PENDING_APPROVAL)', {
      input: 'financial_transactions หลัง bulk ที่ถูกปฏิเสธ',
      expected: 'PENDING_APPROVAL',
      actual: (await txRow(thirdTx.transactionId)).status,
      pass: (await txRow(thirdTx.transactionId)).status === 'PENDING_APPROVAL',
    });
    const otherChecker = await bulkDecide({ stepIds: [thirdStep], decision: 'APPROVE' }, tokens.checker1);
    check(CAT, 'checker อื่น bulk อนุมัติรายการของ checker2 ได้ (separation นับที่ตัว maker ไม่ใช่ role)', {
      input: 'approver = checker1',
      expected: 'decided 1, transaction APPROVED',
      actual: `decided ${otherChecker.json.data.decided}, status ${(await txRow(thirdTx.transactionId)).status}`,
      pass: otherChecker.json.data.decided === 1 && (await txRow(thirdTx.transactionId)).status === 'APPROVED',
    });
    const thirdPosted = await postTx(thirdTx.transactionId);
    statusCheck(CAT, 'โพสต์ดอกเบี้ยงวด 3 ได้ (ใช้ flow เดิมกับ transaction types อื่น): 200', thirdPosted, 200, { input: 'POST /transactions/:id/post' });
    postEvent(states.get(A.id), { type: 'INTEREST_ACCRUAL', amountCents: cent(thirdTx.amount), postedAtIso: '2026-03-16' });
    const sA3 = await schedule(A.id, '2026-03-16');
    const aAfterThird = await outstandingCents(A.id);
    check(CAT, `${A.loanNumber}: งวด 1-3 มีดอกเบี้ยตามงวดที่โพสต์, งวด 4..12 ยัง 0, ยอดคงค้าง = oracle`, {
      input: 'schedule?asOf=2026-03-16',
      expected: `3 periods billed, outstanding ${asText(states.get(A.id).components)}`,
      actual: `${sA3.periods.filter((p) => cent(p.interestDue) > 0).length} periods billed, ${asText(aAfterThird)}`,
      pass: sA3.periods.filter((p) => cent(p.interestDue) > 0).length === 3 && COMPS.every((c) => aAfterThird[c] === states.get(A.id).components[c]),
    });

    const run4 = await accrue({ asOf: day('2026-04-16'), loanIds: [A.id] });
    const fourthTx = run4.json.data.created[0];
    createdTx.push(fourthTx.transactionId);
    const rejected = await api('POST', `/api/approvals/steps/${await stepOf(fourthTx.transactionId)}/decision`, { token: tokens.checker1, body: { decision: 'REJECT', reason: 'suite16: probing that a rejected period can be rebilled' } });
    statusCheck(CAT, 'ปฏิเสธดอกเบี้ยงวด 4 (REJECT พร้อมเหตุผล): 200', rejected, 200, { input: 'decision=REJECT' });
    const rebill = await accrue({ asOf: day('2026-04-16'), loanIds: [A.id] });
    check(CAT, 'งวดที่ถูก REJECT เรียกเก็บใหม่ได้ (REJECTED ไม่บล็อก periodIndex เดิม)', {
      input: 'accrue ซ้ำหลัง reject, asOf=2026-04-16',
      expected: 'created 1, periodIndex 4',
      actual: `created ${rebill.json.data.created.length} ${rebill.json.data.created.map((c) => `p${c.periodIndex} ${c.amount}`).join(',')}`,
      pass: rebill.json.data.created.length === 1 && rebill.json.data.created[0].periodIndex === 4,
    });
    const p4 = await rows(conn, "SELECT status FROM financial_transactions WHERE loanId = ? AND transactionType = 'INTEREST_ACCRUAL' AND periodIndex = 4", [A.id]);
    check(CAT, 'ใน DB: งวด 4 มี 1 REJECTED + 1 PENDING และ 0 POSTED (ไม่กลายเป็นเงินค้างสองรอบ)', {
      input: 'financial_transactions periodIndex = 4 ของ loan A',
      expected: 'REJECTED 1, PENDING_APPROVAL 1, POSTED 0',
      actual: JSON.stringify(p4.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {})),
      pass: p4.length === 2 && p4.filter((r) => r.status === 'REJECTED').length === 1 && p4.filter((r) => r.status === 'PENDING_APPROVAL').length === 1,
    });
    const reStep = await stepOf(rebill.json.data.created[0].transactionId);
    const bulkReject = await bulkDecide({ stepIds: [reStep], decision: 'REJECT', reason: 'suite16 cleanup' }, tokens.checker1);
    check(CAT, 'bulk REJECT ก็ทำงานได้ครบกฎ (ต้องใส่เหตุผล): decided 1, transaction REJECTED', {
      input: 'bulk decision REJECT + reason',
      expected: 'decided 1, status REJECTED',
      actual: `decided ${bulkReject.json.data.decided}, status ${(await txRow(rebill.json.data.created[0].transactionId)).status}`,
      pass: bulkReject.json.data.decided === 1 && (await txRow(rebill.json.data.created[0].transactionId)).status === 'REJECTED',
    });
    const run5 = await accrue({ asOf: day('2026-05-16'), loanIds: [B.id] });
    const fifthTx = run5.json.data.created[0];
    createdTx.push(fifthTx.transactionId);
    const fifthStep = await stepOf(fifthTx.transactionId);
    const noReason = await bulkDecide({ stepIds: [fifthStep], decision: 'REJECT' }, tokens.checker1);
    check(CAT, 'bulk REJECT โดยไม่มีเหตุผล: ข้อนั้นถูกปฏิเสทรายข้อพร้อมเหตุผล (กฎเดียวกับ single decision)', {
      input: 'bulk decision REJECT without reason',
      expected: 'HTTP 200, decided 0, declined 1, error "A rejection reason is required"',
      actual: `HTTP ${noReason.status} ${JSON.stringify({ decided: noReason.json?.data?.decided, declined: noReason.json?.data?.declined, error: noReason.json?.data?.results?.[0]?.error })}`,
      pass: noReason.status === 200 && noReason.json.data.decided === 0 && /reason is required/.test(noReason.json.data.results[0].error ?? ''),
    });
    check(CAT, 'คำขอ bulk ที่ fail ตั้งแต่ validation ต้องไม่แตะ workflow (งวด 5 ยัง PENDING_APPROVAL)', {
      input: 'financial_transactions หลัง bulk REJECT ที่ไม่มีเหตุผล',
      expected: 'PENDING_APPROVAL',
      actual: (await txRow(fifthTx.transactionId)).status,
      pass: (await txRow(fifthTx.transactionId)).status === 'PENDING_APPROVAL',
    });
    const closeOut = await bulkDecide({ stepIds: [fifthStep], decision: 'REJECT', reason: 'suite16 cleanup' }, tokens.checker1);
    check(CAT, 'ล้างงวด 5 ด้วย bulk REJECT พร้อมเหตุผล: decided 1', {
      input: 'bulk decision REJECT + reason',
      expected: 'decided 1, status REJECTED',
      actual: `decided ${closeOut.json.data.decided}, status ${(await txRow(fifthTx.transactionId)).status}`,
      pass: closeOut.json.data.decided === 1 && (await txRow(fifthTx.transactionId)).status === 'REJECTED',
    });

    // ================================================ I. closed loans and hard guards
    await pay(D, toCents(101200));
    const dView = await loanView(D.id);
    check(CAT, `${D.loanNumber}: จ่ายปิดครบ 101,200.00 -> CLOSED และยอดคงเหลือ 0`, {
      input: 'payment of the full outstanding',
      expected: 'status CLOSED, outstanding 0.00',
      actual: `status ${dView.status}, outstanding ${dView.outstanding.total}`,
      pass: dView.status === 'CLOSED' && cent(dView.outstanding.total) === 0,
    });
    const closedDue = await dueList('2026-05-16', [D.id]);
    const closedAccrue = await accrue({ asOf: day('2026-05-16'), loanIds: [D.id] });
    check(CAT, 'กู้ CLOSED: due list คืนว่างทั้ง items/skipped และ accrue ไม่สร้างรายการ (ไม่มีหนี้ให้คิดดอก)', {
      input: 'GET /interest/due + POST /interest/accrue loanIds=D',
      expected: 'items 0, skipped 0, created 0, rows for D = 0',
      actual: `items ${closedDue.items.length}, skipped ${closedDue.skipped.length}, created ${closedAccrue.json.data.created.length}, rows ${await accrualCount('AND loanId = ?', [D.id])}`,
      pass: closedDue.items.length === 0 && closedDue.skipped.length === 0 && closedAccrue.json.data.created.length === 0 && (await accrualCount('AND loanId = ?', [D.id])) === 0,
    });
    const stray = await rows(
      conn,
      "SELECT l.loanNumber FROM financial_transactions t JOIN loans l ON l.id = t.loanId WHERE t.transactionType = 'INTEREST_ACCRUAL' AND t.status = 'POSTED' AND l.status <> 'ACTIVE' AND l.id IN (?)",
      [createdLoans],
    );
    check(CAT, 'ไม่มี INTEREST_ACCRUAL ที่ POSTED บนกู้ที่ไม่ ACTIVE เลยทั้ง suite (posting engine ปิดทาง reopen)', {
      input: 'join financial_transactions + loans',
      expected: 'no rows',
      actual: stray.length ? stray.map((r) => r.loanNumber).join(',') : 'none',
      pass: stray.length === 0,
    });

    // ================================================ J. the loan snapshot beats the product
    const patchBack = await api('PATCH', `/api/loan-products/${decl.id}`, { token: tokens.admin, body: { interestMethod: 'FLAT' } });
    statusCheck(CAT, 'PATCH ผลิตภัณฑ์กลับเป็น FLAT: 200', patchBack, 200, { input: 'interestMethod=FLAT' });
    const aStill = await loanView(A.id);
    const juneDue = await dueList('2026-06-16', [A.id]);
    check(CAT, 'เปลี่ยนผลิตภัณฑ์ย้อนหลังแล้ว: กู้เดิมยัง DECLINING และยังมีงวดค้างเรียกเก็บ (snapshot กันผลกระทบ)', {
      input: 'loan A หลัง PATCH product -> FLAT',
      expected: 'loan.interestMethod DECLINING, due list คืนงวด 4 (งวด 3 โพสต์แล้ว, 4 ยังไม่ bill)',
      actual: `${aStill.interestMethod}, items ${juneDue.items.length} ${juneDue.items.map((i) => `p${i.periodIndex}`).join(',')}`,
      pass: aStill.interestMethod === 'DECLINING' && juneDue.items.length === 1 && juneDue.items[0].periodIndex === 4,
    });
    const declNow = ((await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? []).find((p) => p.id === decl.id);
    const E = await newLoan({ product: declNow, customerId: C5, principal: 100000 });
    track(E, E.principalCents, 0);
    const eView = await loanView(E.id);
    const eRow = await txRow(E.disbursement.id);
    const flatNow = billedInterestCents({ principalCents: E.principalCents, ratePercent: DECL.interestRate, rateUnit: 'MONTH', termValue: 12, termUnit: 'MONTH' });
    check(CAT, 'กู้ใหม่บนผลิตภัณฑ์ที่กลับมา FLAT: bill ก้อนเดียวตามพฤติกรรมเดิม + periodIndex NULL', {
      input: 'POST /api/loans บน product ที่ PATCH เป็น FLAT',
      expected: `interest ${fmt(flatNow)}, periodIndex NULL, method FLAT`,
      actual: `interest ${eView.outstanding.pastInterest}, periodIndex ${eRow.periodIndex}, method ${eView.interestMethod}`,
      pass: sameMoney(eView.outstanding.pastInterest, toLak(flatNow)) && eRow.periodIndex === null && eView.interestMethod === 'FLAT',
    });

    // ================================================ K. ledger truth over the whole run
    const recBad = [];
    for (const loan of [A, B, C]) {
      const rec = await api('POST', `/api/reconciliation/run?loanId=${loan.id}`, { token: tokens.admin });
      for (const r of rec.json?.data?.records ?? []) recordIds.push(r.id);
      const row = rec.json?.data?.records?.[0] ?? {};
      const book = await outstandingCents(loan.id);
      const state = states.get(loan.id);
      if (row.status !== 'MATCHED' || COMPS.some((c) => cent(row.difference?.[c] ?? 0) !== 0)) recBad.push(`${loan.loanNumber} ${row.status} ${asText(row.difference)}`);
      if (COMPS.some((c) => book[c] !== state.components[c])) recBad.push(`${loan.loanNumber} book ${asText(book)} != oracle ${asText(state.components)}`);
    }
    check(CAT, 'reconciliation MATCHED ทั้งสามกู้ และยอดคงค้าง = oracle ที่ replay เหตุการณ์เองทุกขั้น', {
      input: 'POST /reconciliation/run?loanId=A,B,C',
      expected: 'MATCHED, difference 0, book == oracle',
      actual: recBad.length ? recBad.join(' | ') : `${A.loanNumber}, ${B.loanNumber}, ${C.loanNumber} matched`,
      pass: recBad.length === 0,
    });

    const sums = await rows(
      conn,
      "SELECT t.loanId, SUM(t.amount) txSum, SUM(l.amount) lineSum FROM financial_transactions t LEFT JOIN financial_transaction_lines l ON l.transactionId = t.id WHERE t.transactionType = 'INTEREST_ACCRUAL' AND t.status = 'POSTED' AND t.loanId IN (?) GROUP BY t.loanId",
      [createdLoans],
    );
    check(CAT, 'รวมดอกเบี้ยที่โพสต์ = รวมเส้น ledger ของงวดนั้นทุกกู้ (posting engine เขียนครบ ไม่ซ้ำ ไม่ขาด)', {
      input: 'SUM(transactions.amount) vs SUM(lines.amount) per loan',
      expected: 'equal for every loan',
      actual: sums.map((r) => `${String(r.loanId).slice(0, 8)} tx=${r.txSum} line=${r.lineSum}`).join(' | '),
      pass: sums.length > 0 && sums.every((r) => cent(r.txSum) === cent(r.lineSum)),
    });

    const booked = await rows(conn, "SELECT periodIndex, status FROM financial_transactions WHERE transactionType = 'INTEREST_ACCRUAL' AND loanId IN (?)", [createdLoans]);
    check(CAT, 'เลขงวดของ accrual ทุกแถวอยู่ใน term (2..12) และไม่มีการ bill งวดเดียวกันซ้ำสองครั้งในระดับ POSTED/APPROVED', {
      input: 'financial_transactions INTEREST_ACCRUAL ของ suite',
      expected: 'all periodIndex 2..12, no duplicate live charge per (loan, period)',
      actual: `${booked.length} rows, indexes ${[...new Set(booked.map((r) => Number(r.periodIndex)))].sort((a, b) => a - b).join(',')}`,
      pass: booked.length > 0 && booked.every((r) => Number(r.periodIndex) >= 2 && Number(r.periodIndex) <= 12),
    });
  } finally {
    await settle(1200);
    await purge();
  }
}
