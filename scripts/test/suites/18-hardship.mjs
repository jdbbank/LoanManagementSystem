// 3.18 Hardship restructuring: ผู้ค้ำประกัน / ผู้ชำระแทน (KYC ต่อการรับบทบาททุกครั้ง), หลักทรัพย์ค้ำประกัน
// และ "บันทึกแก้ไขสัญญา" (addendum) ที่เขียนสัญญาที่ยัง ACTIVE ใหม่ ผ่านเครื่องอนุมัติ maker-checker ตัวเดิม
//
// Suite นี้เป็นเจ้าของทุกแถวที่มันเขียน (ลูกค้า เงินกู้ party หลักทรัพย์ ใบปรับโครงสร้าง waiver audit outbox)
// และลบออกทั้งหมดตอนจบ จึงรันซ้ำบนเล่มเดิมได้ ส่วนนโยบายหลักประกันถูก pin ไว้ที่ค่า shipped ของเซิร์ฟเวอร์
// ระหว่างรัน และคืนค่าที่พบก่อนเริ่มตอนจบ เพราะหลายเคสด้านล่างเปลี่ยนนโยบายเพื่อพิสูจน์กฎ
//
// ไม่มีการเรียก SMTP/SMS จริง: การแจ้งเตือนตรวจเป็นแถว notification_outbox ตาม transport=log
//
// มี 2 เคสที่ตั้งใจให้แดงเพื่อบันทึกข้อสังเกต (ห้ามแก้กฎที่ล็อกไว้เพื่อให้เทสต์ผ่าน จึงรายงานแทนการแก้):
//   F-HSR-1 — การขยาย term ทำให้ตารางงวดถูก derive ใหม่ทั้งเล่ม ยอดของงวดที่ "ถึงกำหนดไปแล้ว" จึงถูกเปลี่ยนย้อนหลัง
//   F-HSR-2 — oldestValuedAt และ audit reason ของหลักประกันใช้ String(Date).slice(0,10) ซึ่งไม่ใช่ ISO day
import { api as http, check, errorMessage, payloadOf, rows, settle, statusCheck, pinPolicies, utcSql } from '../lib/harness.mjs';
import { jpegBytes, multipartWithFields, pngBytes } from '../lib/files.mjs';
import { billedInterestCents, fmt, periodCount, toCents, toLak } from '../oracle.mjs';

const CAT = 'hardship';
const NIL = '00000000-7000-4000-8000-0000000000fe';
const NOT_A_UUID = 'hardship-not-a-uuid';
const HS = 'E2E Hardship';
const RESTRUCTURE_FLOOR = ['CHECKER', 'HEAD'];
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

const num = (v) => Number(v ?? 0);
const cent = (v) => Math.round(num(v) * 100);
const day = (v) => String(v ?? '').slice(0, 10);
const stamp = (isoDay) => `${isoDay}T00:00:00.000Z`;
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return day(d.toISOString());
};
/** GET /loans/:id outstanding (LAK) -> components in cents */
const outstandingOf = (loan) => ({
  PENALTY: cent(loan?.outstanding?.penalty ?? 0),
  PAST_INTEREST: cent(loan?.outstanding?.pastInterest ?? 0),
  PAST_PRINCIPAL: cent(loan?.outstanding?.pastPrincipal ?? 0),
});
const sumCents = (c) => COMPS.reduce((acc, k) => acc + (c[k] ?? 0), 0);
const asText = (c) => COMPS.map((k) => `${k}=${fmt(c[k] ?? 0)}`).join(' ');

/** ชุดหลักฐานครบตาม policy shipped: 1 ไฟล์ต่อ 1 คำขอ */
const EVIDENCE = [
  ['NATIONAL_ID', 'id-card.png', 'image/png', { issuedAt: '2023-04-11', expiresAt: '2029-04-11' }],
  ['SELFIE_WITH_ID', 'selfie.jpg', 'image/jpeg', {}],
  ['SIGNATURE', 'signature.png', 'image/png', {}],
];

/** กฎ section 12 ที่ล็อกไว้ คำนวณซ้ำฝั่งเทสต์ เพื่อให้เคส "เพดานต่ำสุด" มีอะไรไว้เทียบ */
const levelsFromAmount = (amount, t) =>
  num(amount) <= t.checkerThreshold ? ['CHECKER'] : num(amount) <= t.headThreshold ? ['CHECKER', 'HEAD'] : ['CHECKER', 'HEAD', 'ADMIN'];
const widen = (levels, floor) => [...new Set([...levels, ...floor])];

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  // ctx.api ใส่ token admin ให้เมื่อไม่ระบุ — เคสที่อยากทดสอบ "ไม่ล็อกอิน" ต้องส่ง token:null ตรง ๆ
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));

  // ต้องจับเวลาก่อน pin นโยบาย มิฉะนั้น audit row ของการ pin จะตกค้างนอกหน้าต่างที่ purge ใช้กวาด
  const STARTED_AT = Date.now();

  const products = (await api('GET', '/api/loan-products')).json.products ?? [];
  const P12 = products.find((p) => p.code === 'TST-FLAT-M12');
  if (!P12) throw new Error('product TST-FLAT-M12 is missing from the seeded book');

  const rawThresholds = (await api('GET', '/api/config/thresholds')).json ?? {};
  const TH = { checkerThreshold: num(rawThresholds.checkerThreshold), headThreshold: num(rawThresholds.headThreshold) };

  const collateralPins = await pinPolicies(api, ['collateral']);
  const baselinePolicy = collateralPins.found.collateral;
  const shippedPolicy = collateralPins.defaults.collateral;

  const TODAY = day(new Date().toISOString());
  const TABLES = [
    'customers',
    'loans',
    'loan_parties',
    'loan_collaterals',
    'restructure_requests',
    'financial_transactions',
    'financial_transaction_lines',
    'approval_workflows',
    'approval_steps',
    'kyc_documents',
    'kyc_document_contents',
    'audit_logs',
    'notification_outbox',
  ];
  /**
   * จำนวนแถวของทุกตารางที่ suite นี้แตะ ต้องจับหลัง purge ครั้งแรกเท่านั้น มิฉะนั้นเศษแถวจากการรันครั้งก่อนที่
   * crash ไว้จะถูกนับเป็น baseline แล้วทำให้เคส "คืนตารางครบ" แดงทั้งที่ suite ปัจจุบันไม่ได้เขียนอะไรเพิ่ม
   */
  const captureBaseline = async () => {
    const out = {};
    for (const t of TABLES) out[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`, []))[0].n);
    return out;
  };
  let baseline = {};

  const approverEmails = (
    await rows(
      conn,
      "SELECT email FROM users WHERE role IN ('CHECKER','HEAD_APPROVER','ADMIN') AND isActive = 1 AND email IS NOT NULL AND email <> '' ORDER BY email",
      [],
    )
  ).map((r) => r.email);

  /**
   * ทุกอย่างที่ suite นี้เขียนผูกกับลูกค้าที่มันสร้าง (ชื่อขึ้นต้นด้วย marker เดียวกัน) จึงไล่ลบจากตารางลูกค้า
   * แล้วออกไปยังเงินกู้/ledger/งานอนุมัติ/audit/outbox ของตัวเอง พร้อมเก็บแถวที่การรันครั้งก่อน crash ทิ้งไว้
   * ด้วย ส่วน audit ของ CONFIG_UPDATED ในหน้าต่างเวลาด้านล่างคือ policy ที่ suite นี้เปลี่ยนเอง
   * (suite อื่นรันจบไปก่อน STARTED_AT แล้ว)
   */
  const purge = async () => {
    const custIds = (await rows(conn, 'SELECT id FROM customers WHERE fullName LIKE ?', [`${HS}%`])).map((r) => r.id);
    if (custIds.length) {
      const loanIds = (await rows(conn, 'SELECT id FROM loans WHERE customerId IN (?)', [custIds])).map((r) => r.id);
      if (loanIds.length) {
        const txSubject = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';
        const reqSubject = 'SELECT id FROM restructure_requests WHERE loanId IN (?)';
        await conn.query(
          `DELETE FROM approval_steps WHERE workflowId IN (${txSubject}) OR workflowId IN (${reqSubject})`,
          [loanIds, loanIds],
        );
        await conn.query(
          `DELETE FROM approval_workflows WHERE subjectId IN (${txSubject}) OR subjectId IN (${reqSubject})`,
          [loanIds, loanIds],
        );
        await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${txSubject})`, [loanIds]);
        await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM restructure_requests WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM loan_collaterals WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM loan_parties WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [loanIds]);
        await conn.query('DELETE FROM loans WHERE id IN (?)', [loanIds]);
      }
      await conn.query('DELETE FROM notification_outbox WHERE customerId IN (?)', [custIds]);
      // CUSTOMER_REGISTERED ไม่มี loanId และฉบับที่ถึงผู้มีอำนาจก็ไม่มี customerId -- ของ suite นี้หาได้
      // ด้วยเลขลูกค้าใน payload (ซึ่งถูก seal) เท่านั้น จึงกรองใน JS แล้วลบด้วย id
      const ownNumbers = (await rows(conn, 'SELECT customerNumber FROM customers WHERE id IN (?)', [custIds])).map((r) => r.customerNumber);
      const registrationMailIds = (
        await rows(conn, "SELECT id, payload FROM notification_outbox WHERE type = 'CUSTOMER_REGISTERED'", [])
      )
        .filter((row) => ownNumbers.includes(payloadOf(row).customerNumber))
        .map((row) => row.id);
      if (registrationMailIds.length) await conn.query('DELETE FROM notification_outbox WHERE id IN (?)', [registrationMailIds]);
      await conn.query('DELETE FROM audit_logs WHERE customerId IN (?)', [custIds]);
      await conn.query('DELETE FROM kyc_document_contents WHERE documentId IN (SELECT id FROM kyc_documents WHERE customerId IN (?))', [custIds]);
      await conn.query('DELETE FROM kyc_documents WHERE customerId IN (?)', [custIds]);
      await conn.query('DELETE FROM customers WHERE id IN (?)', [custIds]);
    }
    await conn.query("DELETE FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND createdAt >= ?", [utcSql(STARTED_AT)]);
  };

  // ------------------------------------------------------------------ builders
  let seq = 0;
  const newCustomer = async (label) => {
    seq += 1;
    const res = await api('POST', '/api/customers', {
      token: tokens.op1,
      body: {
        fullName: `${HS} ${label}`,
        phone: `0209${String(99000 + seq)}`,
        email: `e2e.hardship.${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@test.local`,
        nationalId: `E2EHS-${String(seq).padStart(3, '0')}`,
        address: 'Test address, Vientiane',
      },
    });
    if (res.status !== 201) throw new Error(`customer ${label}: ${res.status} ${errorMessage(res)}`);
    return res.json.customer;
  };

  /** upload ครบชุด + submit + ให้ CHECKER ตรวจ (ใช้ตอน setup เท่านั้น) */
  const verifyKyc = async (customer, seed) => {
    const base = `/api/customers/${customer.id}/kyc`;
    for (const [index, [documentType, filename, type, extra]] of EVIDENCE.entries()) {
      const buffer = documentType === 'SELFIE_WITH_ID' ? jpegBytes(seed + index) : pngBytes(seed + index);
      const res = await api('POST', `${base}/documents`, {
        token: tokens.op1,
        form: multipartWithFields(buffer, { documentType, ...extra }, { filename, type }),
      });
      if (res.status !== 201) throw new Error(`kyc upload ${customer.fullName} ${documentType}: ${res.status} ${errorMessage(res)}`);
    }
    const submitted = await api('POST', `${base}/submit`, { token: tokens.op1, body: {} });
    if (submitted.status !== 200) throw new Error(`kyc submit ${customer.fullName}: ${submitted.status} ${errorMessage(submitted)}`);
    const verified = await api('POST', `${base}/verify`, { token: tokens.checker2, body: { note: 'e2e hardship setup' } });
    if (verified.status !== 200) throw new Error(`kyc verify ${customer.fullName}: ${verified.status} ${errorMessage(verified)}`);
    return verified.json?.data?.customer ?? null;
  };

  const uploadDoc = (customer, [documentType, filename, type, extra], seed) =>
    api('POST', `/api/customers/${customer.id}/kyc/documents`, {
      token: tokens.op1,
      form: multipartWithFields(
        documentType === 'SELFIE_WITH_ID' ? jpegBytes(seed) : pngBytes(seed),
        { documentType, ...extra },
        { filename, type },
      ),
    });

  const interestCentsFor = (principal) =>
    billedInterestCents({
      principalCents: toCents(principal),
      ratePercent: P12.interestRate,
      rateUnit: P12.interestRatePeriod,
      termValue: P12.termValue,
      termUnit: P12.termUnit,
    });
  /** เงินต้นที่ทำให้ยอดคงเหลือ (ต้น + ดอกทั้งก้อน) ลงไปต่ำกว่าเป้าหมายที่ระบุแบบปลอดภัย */
  const principalBelow = (targetOutstandingLak) => {
    const factor = (toCents(100000) + interestCentsFor(100000)) / toCents(100000);
    return Math.max(1000, Math.floor(targetOutstandingLak / factor / 1000) * 1000);
  };

  const created = { loans: [] };
  const newLoan = async ({ customer, principal, disbursedAt, label }) => {
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: {
        customerId: customer.id,
        productId: P12.id,
        principalAmount: principal,
        termValue: P12.termValue,
        termUnit: P12.termUnit,
        disbursedAt: stamp(disbursedAt),
        note: `${HS} ${label}`,
      },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    const interestCents = interestCentsFor(principal);
    created.loans.push(loan.id);
    return {
      id: loan.id,
      loanNumber: loan.loanNumber,
      label,
      customerId: customer.id,
      email: customer.email,
      rate: num(P12.interestRate),
      ratePeriod: P12.interestRatePeriod,
      termMonths: periodCount(P12.termValue, P12.termUnit),
      billed: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: toCents(principal) },
    };
  };

  // ------------------------------------------------------------------ endpoint wrappers
  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;
  const scheduleView = (id, asOf) =>
    api('GET', `/api/loans/${id}/schedule${asOf ? `?asOf=${encodeURIComponent(stamp(asOf))}` : ''}`).then((r) => r.json?.data ?? null);

  const partiesOf = (loanId, status) =>
    api('GET', `/api/loans/${loanId}/parties${status ? `?status=${status}` : ''}`).then((r) => r.json?.data ?? null);
  const partyKyc = async (loanId, partyId) => (await partiesOf(loanId)).parties.find((p) => p.party.id === partyId)?.kyc ?? null;
  const registerPartyCall = (loanId, body, token = tokens.op1) => api('POST', `/api/loans/${loanId}/parties`, { token, body });
  const releasePartyCall = (loanId, partyId, reason, token = tokens.head) =>
    api('POST', `/api/loans/${loanId}/parties/${partyId}/release`, { token, body: { reason } });

  const collateralOf = (loanId) => api('GET', `/api/loans/${loanId}/collaterals`).then((r) => r.json?.data ?? null);
  const coverageOf = (loanId) => api('GET', `/api/loans/${loanId}/collaterals/coverage`).then((r) => r.json?.data ?? null);
  const pledgeCall = (loanId, body, token = tokens.op1) => api('POST', `/api/loans/${loanId}/collaterals`, { token, body });
  const releasePledgeCall = (loanId, collateralId, reason, token = tokens.head) =>
    api('POST', `/api/loans/${loanId}/collaterals/${collateralId}/release`, { token, body: { reason } });

  const restructureContext = (loanId, payerCustomerId) =>
    api('GET', `/api/restructures/context/${loanId}${payerCustomerId ? `?payerCustomerId=${payerCustomerId}` : ''}`).then(
      (r) => r.json?.data ?? null,
    );
  const proposedPayerCall = (loanId, customerId, token = tokens.op1) =>
    api('POST', `/api/restructures/proposed-payer/${loanId}`, { token, body: { newPayerCustomerId: customerId } });
  const createAddendum = (body, token = tokens.op1) => api('POST', '/api/restructures', { token, body });
  const addendumOf = (id) => api('GET', `/api/restructures/${id}`).then((r) => r.json?.data ?? null);
  const applyAddendum = (id, token = tokens.op1) => api('POST', `/api/restructures/${id}/apply`, { token });
  const listAddenda = (query = '') => api('GET', `/api/restructures${query}`);

  const pendingQueue = async (token) => (await api('GET', '/api/approvals/pending?limit=100', { token })).json?.data ?? [];
  const queueItemFor = (subjectId, token = tokens.checker2) =>
    pendingQueue(token).then((items) => items.find((i) => i.subjectId === subjectId) ?? null);
  const decideCall = (stepId, body, token) => api('POST', `/api/approvals/steps/${stepId}/decision`, { token, body });
  const stepsOf = async (workflowId) =>
    (await api('GET', `/api/approvals/workflows/${workflowId}`)).json?.data?.steps ?? [];
  const tokenForLevel = { CHECKER: tokens.checker2, HEAD: tokens.head, ADMIN: tokens.admin };

  /** เดินชั้นอนุมัติตามที่ workflow กำหนด แล้วรายงานว่าผ่านชั้นไหนบ้าง */
  const approveThrough = async (subjectId) => {
    const seen = [];
    for (let guard = 0; guard < 6; guard += 1) {
      const item = await queueItemFor(subjectId);
      if (!item) break;
      const res = await decideCall(item.stepId, { decision: 'APPROVE', reason: 'e2e hardship approval' }, tokenForLevel[item.currentLevel]);
      if (res.status !== 200) throw new Error(`approve ${item.currentLevel}: ${res.status} ${errorMessage(res)}`);
      seen.push(item.currentLevel);
    }
    return seen;
  };

  const setPolicy = async (patch) => {
    const res = await api('PUT', '/api/config/collateral', { token: tokens.admin, body: patch });
    if (res.status !== 200) throw new Error(`policy patch ${JSON.stringify(patch)}: ${res.status} ${errorMessage(res)}`);
    return res.json?.data?.policy ?? null;
  };

  /** จดหลักประกันเพิ่มเฉพาะส่วนที่ยังขาด ตามเกณฑ์ที่ใช้งานอยู่ตอนนี้ */
  const ensureCoverage = async (loan, type = 'LAND') => {
    const view = await coverageOf(loan.id);
    if (view?.coverage?.passed) return null;
    const gap = Math.max(0, cent(view.loan.outstanding) - cent(view.coverage.appraisedTotal));
    if (gap === 0) return null;
    const res = await pledgeCall(loan.id, {
      type,
      description: `Top-up pledge ${loan.loanNumber}`,
      appraisedValue: toLak(gap) + 1,
      valuedAt: TODAY,
    });
    if (res.status !== 201) throw new Error(`top-up pledge ${loan.loanNumber}: ${res.status} ${errorMessage(res)}`);
    return res.json.data;
  };

  const outboxRows = (loanId, type) =>
    rows(conn, 'SELECT type, recipientEmail, recipientName, status FROM notification_outbox WHERE loanId = ? AND type = ? ORDER BY recipientEmail', [
      loanId,
      type,
    ]);
  // payload is sealed for every event type, so the party name is matched in JS — JSON_EXTRACT on
  // `sealed:v1:` text is not valid JSON and would match no row at all.
  const outboxRowsForParty = async (loanId, type, partyName) =>
    (
      await rows(
        conn,
        'SELECT recipientEmail, payload FROM notification_outbox WHERE loanId = ? AND type = ? ORDER BY recipientEmail',
        [loanId, type],
      )
    )
      .filter((row) => payloadOf(row).partyName === partyName)
      .map((row) => ({ recipientEmail: row.recipientEmail }));

  try {
    await purge();
    baseline = await captureBaseline();

    // ============================================================ fixtures
    const borrower1 = await newCustomer('Borrower One');
    const borrower2 = await newCustomer('Borrower Two');
    const borrower3 = await newCustomer('Borrower Three');
    const borrower4 = await newCustomer('Borrower Four');
    const guarantor = await newCustomer('Guarantor G1');
    const payer = await newCustomer('Payer P1');
    const stranger = await newCustomer('Stranger S1');
    const otherPayer = await newCustomer('Payer Candidate P2');
    // เฉพาะผู้กู้กับผู้ค้ำที่ผ่าน KYC ตั้งแต่ setup — ผู้ชำระแทนต้องเดิน state machine เองในหมวด B
    for (const [index, c] of [borrower1, borrower2, borrower3, borrower4, guarantor].entries()) await verifyKyc(c, 30 + index * 4);

    const L1 = await newLoan({ customer: borrower1, principal: principalBelow((TH.checkerThreshold + TH.headThreshold) / 2), disbursedAt: TODAY, label: 'HARDSHIP-MAIN' });
    const L2 = await newLoan({ customer: borrower2, principal: principalBelow(TH.checkerThreshold * 0.9), disbursedAt: TODAY, label: 'HARDSHIP-SMALL' });
    const L3 = await newLoan({ customer: borrower3, principal: principalBelow(TH.headThreshold * 1.4), disbursedAt: TODAY, label: 'HARDSHIP-BIG' });
    const L4 = await newLoan({ customer: borrower4, principal: principalBelow(TH.checkerThreshold * 0.5), disbursedAt: TODAY, label: 'HARDSHIP-SECURE' });

    const seededOutstanding = sumCents(outstandingOf(await loanView(L1.id)));
    check(CAT, 'ข้อมูลหลักพร้อม: เงินกู้ FLAT ที่ยัง ACTIVE, ยอดคงเหลือตรงตาม oracle (ต้น + ดอกทั้งก้อนที่ bill ตอนปล่อย)', {
      input: `POST /api/loans x4 (${L1.loanNumber}, ${L2.loanNumber}, ${L3.loanNumber}, ${L4.loanNumber})`,
      expected: `${L1.loanNumber} = ${fmt(sumCents(L1.billed))}, อัตรา ${L1.rate}/${L1.ratePeriod}, term ${L1.termMonths} เดือน`,
      actual: `${L1.loanNumber} = ${fmt(seededOutstanding)}, rate ${await api('GET', `/api/restructures/context/${L1.id}`).then((r) => r.json?.data?.before?.interestRate)}, term ${await api('GET', `/api/restructures/context/${L1.id}`).then((r) => r.json?.data?.before?.termMonths)}`,
      pass: seededOutstanding === sumCents(L1.billed),
    });

    // ============================================================ A. auth + role gates
    statusCheck(CAT, 'หน้าผู้ค้ำ/ผู้ชำระแทนแบบไม่ล็อกอิน: 401', await api('GET', `/api/loans/${L1.id}/parties`, { token: null }), 401);
    statusCheck(CAT, 'หน้าหลักทรัพย์ค้ำประกันแบบไม่ล็อกอิน: 401', await api('GET', `/api/loans/${L1.id}/collaterals`, { token: null }), 401);
    statusCheck(CAT, 'รายการปรับโครงสร้างแบบไม่ล็อกอิน: 401', await api('GET', '/api/restructures', { token: null }), 401);
    statusCheck(CAT, 'VIEWER อ่านเกณฑ์หลักประกันได้: 200 (ต้องเห็นเกณฑ์ก่อนตัดสินใจ)', await api('GET', '/api/config/collateral', { token: tokens.viewer }), 200);
    statusCheck(CAT, 'party ของเงินกู้ที่ไม่มีอยู่: 404', await api('GET', `/api/loans/${NIL}/parties`), 404);
    statusCheck(CAT, 'collateral ของเงินกู้ที่ไม่มีอยู่: 404', await api('GET', `/api/loans/${NIL}/collaterals`), 404);
    statusCheck(CAT, 'context ปรับโครงสร้างของเงินกู้ที่ไม่มีอยู่: 404', await api('GET', `/api/restructures/context/${NIL}`), 404);
    statusCheck(CAT, 'เปิดใบปรับโครงสร้างด้วย id ที่ไม่มีอยู่: 404', await api('GET', `/api/restructures/${NOT_A_UUID}`), 404);

    statusCheck(CAT, 'VIEWER ตั้งผู้ค้ำไม่ได้: 403 (เป็นงานของเจ้าหน้าที่)', await registerPartyCall(L1.id, { customerId: guarantor.id, role: 'GUARANTOR' }, tokens.viewer), 403, { messageIncludes: 'Requires role' });
    statusCheck(CAT, 'VIEWER จดหลักประกันไม่ได้: 403', await pledgeCall(L1.id, { type: 'LAND', description: 'viewer pledge', appraisedValue: 1000 }, tokens.viewer), 403, { messageIncludes: 'Requires role' });
    statusCheck(
      CAT,
      'VIEWER ร่างใบปรับโครงสร้างไม่ได้: 403',
      await createAddendum({ loanId: L1.id, hardshipReason: 'viewer cannot write this paper', changeTypes: ['TERM_EXTENSION'], newTermMonths: 24 }, tokens.viewer),
      403,
      { messageIncludes: 'Requires role' },
    );
    statusCheck(CAT, 'ตั้งผู้ค้ำด้วย customerId ที่ไม่ใช่ uuid: 400', await registerPartyCall(L1.id, { customerId: NOT_A_UUID, role: 'GUARANTOR' }), 400);
    statusCheck(CAT, 'ตั้งผู้ค้ำด้วย role ที่ระบบไม่รู้จัก: 400', await registerPartyCall(L1.id, { customerId: guarantor.id, role: 'WITNESS' }), 400);

    // ============================================================ B. parties + KYC ต่อ engagement
    // ให้เวลาใบตรวจตอน setup ลงหลักก่อน แล้วจึง "เรียกตัว" ผู้ค้ำมา engagement ใหม่
    await settle(1200);

    const gParty = await registerPartyCall(L1.id, { customerId: guarantor.id, role: 'GUARANTOR', relationship: 'sister', note: 'verified for another customer first' });
    statusCheck(CAT, 'MAKER ตั้งผู้ค้ำได้: 201 (บันทึกว่าใครค้ำให้ — KYC ไปทำให้ครบทีหลัง)', gParty, 201);
    const gPartyId = gParty.json?.data?.id;
    check(CAT, 'แถวผู้ค้ำเป็น ACTIVE, role GUARANTOR, engagedAt = วันนี้', {
      input: `POST /loans/${L1.loanNumber}/parties GUARANTOR`,
      expected: 'status ACTIVE, role GUARANTOR, engagedAt วันนี้',
      actual: `status=${gParty.json?.data?.status}, role=${gParty.json?.data?.role}, engagedAt=${day(gParty.json?.data?.engagedAt)}`,
      pass:
        gParty.json?.data?.status === 'ACTIVE' &&
        gParty.json?.data?.role === 'GUARANTOR' &&
        day(gParty.json?.data?.engagedAt) === TODAY,
    });

    const gKyc = await partyKyc(L1.id, gPartyId);
    check(CAT, 'ผู้ค้ำที่เคยผ่านการตรวจ KYC มาแล้ว "ยังไม่สมบูรณ์" สำหรับ engagement นี้ ต้อง reopen + ยื่นใหม่', {
      input: 'GET /loans/:id/parties -> kyc ของ GUARANTOR ที่ถูกเรียกตัวมาภายหลัง',
      expected: 'status VERIFIED, effective false, nextAction REOPEN_AND_RESUBMIT',
      actual: `status=${gKyc?.status}, effective=${gKyc?.effective}, nextAction=${gKyc?.nextAction}`,
      pass: gKyc?.status === 'VERIFIED' && gKyc?.effective === false && gKyc?.nextAction === 'REOPEN_AND_RESUBMIT',
      note: 'นี่คือแกนของ "ผู้ค้ำ/ผู้ชำระแทนต้องยื่น KYC ทุกครั้ง": การเคยผ่านสำหรับเรื่องอื่นไม่ผูกกับบทบาทใหม่นี้',
    });

    const firstMail = await outboxRowsForParty(L1.id, 'PARTY_REGISTERED', guarantor.fullName);
    const wantedAudience = [borrower1.email, guarantor.email, ...approverEmails];
    check(CAT, 'เมล PARTY_REGISTERED ถึงผู้กู้ ผู้ค้ำ และผู้มีอำนาจทุกคน (transport=log จึงมีแค่ใน outbox)', {
      input: 'notification_outbox type=PARTY_REGISTERED ของเหตุการณ์นี้เท่านั้น',
      expected: `ครบทุกที่อยู่: ${wantedAudience.join(', ')}`,
      actual: firstMail.map((r) => r.recipientEmail).join(', '),
      pass: wantedAudience.every((email) => firstMail.some((r) => r.recipientEmail === email)),
    });
    check(CAT, 'หนึ่งเหตุการณ์ = หนึ่งฉบับต่อกล่องจดหมาย (ไม่ส่งซ้ำคนที่มีหลายบทบาท)', {
      input: 'recipientEmail ของ PARTY_REGISTERED เหตุการณ์เดียว',
      expected: `${firstMail.length} แถว = ${new Set(firstMail.map((r) => r.recipientEmail)).size} ที่อยู่ที่ไม่ซ้ำ`,
      actual: `${firstMail.length} แถว, ไม่ซ้ำ ${new Set(firstMail.map((r) => r.recipientEmail)).size}`,
      pass: firstMail.length > 0 && firstMail.length === new Set(firstMail.map((r) => r.recipientEmail)).size,
    });

    statusCheck(CAT, 'ตั้งผู้ค้ำคนเดิมซ้ำตอนยัง ACTIVE: 409', await registerPartyCall(L1.id, { customerId: guarantor.id, role: 'GUARANTOR' }), 409, { messageIncludes: 'already a guarantor of this loan' });
    statusCheck(CAT, 'ตั้งตัวผู้กู้เองเป็นผู้ชำระแทน: 422', await registerPartyCall(L1.id, { customerId: borrower1.id, role: 'PAYER' }), 422, { messageIncludes: 'The borrower is already the payer of their own loan' });

    const pParty = await registerPartyCall(L1.id, { customerId: payer.id, role: 'PAYER', relationship: 'brother' });
    statusCheck(CAT, 'ตั้งผู้ชำระแทนคนใหม่ที่ระบบยังไม่เคยมีเอกสาร KYC ของเขา: 201', pParty, 201);
    const pPartyId = pParty.json?.data?.id;
    const pKyc0 = await partyKyc(L1.id, pPartyId);
    check(CAT, 'ยังไม่ upload เอกสารเลย → nextAction UPLOAD_DOCUMENTS และยังไม่ effective', {
      input: 'GET /loans/:id/parties -> kyc ของ PAYER คนใหม่',
      expected: 'status NOT_VERIFIED, effective false, nextAction UPLOAD_DOCUMENTS',
      actual: `status=${pKyc0?.status}, effective=${pKyc0?.effective}, nextAction=${pKyc0?.nextAction}, hint=${pKyc0?.hint}`,
      pass: pKyc0?.status === 'NOT_VERIFIED' && pKyc0?.effective === false && pKyc0?.nextAction === 'UPLOAD_DOCUMENTS',
    });

    statusCheck(CAT, 'upload หลักฐานผู้ชำระแทนใบแรก: 201', await uploadDoc(payer, EVIDENCE[0], 41), 201);
    const pKyc1 = await partyKyc(L1.id, pPartyId);
    check(CAT, 'มีเอกสารแล้วแต่ยังไม่ได้ยื่น → nextAction SUBMIT', {
      input: 'GET /loans/:id/parties หลัง upload 1 ใบ',
      expected: 'effective false, nextAction SUBMIT',
      actual: `status=${pKyc1?.status}, effective=${pKyc1?.effective}, nextAction=${pKyc1?.nextAction}`,
      pass: pKyc1?.effective === false && pKyc1?.nextAction === 'SUBMIT',
    });

    for (const doc of EVIDENCE.slice(1)) statusCheck(CAT, `upload เอกสารที่เหลือให้ครบตาม policy (${doc[0]}): 201`, await uploadDoc(payer, doc, 42), 201);
    statusCheck(CAT, 'ยื่น KYC ผู้ชำระแทน: 200', await api('POST', `/api/customers/${payer.id}/kyc/submit`, { token: tokens.op1, body: {} }), 200);
    const pKyc2 = await partyKyc(L1.id, pPartyId);
    check(CAT, 'ยื่นแล้วแต่ยังไม่มีใครตรวจ → nextAction AWAIT_REVIEW (ยังไม่ effective)', {
      input: 'GET /loans/:id/parties หลัง submit',
      expected: 'status PENDING, effective false, nextAction AWAIT_REVIEW',
      actual: `status=${pKyc2?.status}, effective=${pKyc2?.effective}, nextAction=${pKyc2?.nextAction}`,
      pass: pKyc2?.status === 'PENDING' && pKyc2?.effective === false && pKyc2?.nextAction === 'AWAIT_REVIEW',
    });

    statusCheck(CAT, 'CHECKER อนุมัติ KYC ผู้ชำระแทน: 200', await api('POST', `/api/customers/${payer.id}/kyc/verify`, { token: tokens.checker2, body: { note: 'payer verified' } }), 200);
    const pKyc3 = await partyKyc(L1.id, pPartyId);
    check(CAT, 'ตรวจผ่านหลังถูกตั้งบทบาท → engagement นี้สมบูรณ์ (effective true, nextAction NONE)', {
      input: 'GET /loans/:id/parties หลัง verify',
      expected: 'status VERIFIED, effective true, nextAction NONE',
      actual: `status=${pKyc3?.status}, effective=${pKyc3?.effective}, nextAction=${pKyc3?.nextAction}, reviewedAt=${pKyc3?.reviewedAt ?? null}`,
      pass: pKyc3?.status === 'VERIFIED' && pKyc3?.effective === true && pKyc3?.nextAction === 'NONE',
    });
    const payerMail = await outboxRowsForParty(L1.id, 'PARTY_REGISTERED', payer.fullName);
    check(CAT, 'ตั้งผู้ชำระแทนแล้วเมลไปถึงทุกฝ่ายรวมทั้งตัวผู้ชำระแทนเองด้วย', {
      input: 'notification_outbox type=PARTY_REGISTERED ของผู้ชำระแทน',
      expected: `มีแถวถึง ${payer.email} และผู้มีอำนาจทุกคน`,
      actual: payerMail.map((r) => r.recipientEmail).join(', '),
      pass: payerMail.some((r) => r.recipientEmail === payer.email) && approverEmails.every((e) => payerMail.some((r) => r.recipientEmail === e)),
    });

    statusCheck(CAT, 'ตั้งผู้ชำระแทนคนที่สองตอนคนแรกยัง ACTIVE: 422 (ต้องไล่คนเดิมออกก่อน)', await registerPartyCall(L1.id, { customerId: otherPayer.id, role: 'PAYER' }), 422, {
      messageIncludes: 'is already the active payer of this loan',
    });

    statusCheck(CAT, 'MAKER ปลดผู้ชำระแทนไม่ได้: 403 (การถอนผู้ชำระเป็นงานระดับหัวหน้า)', await releasePartyCall(L1.id, pPartyId, 'maker must not do this', tokens.op1), 403, { messageIncludes: 'Requires role' });
    statusCheck(CAT, 'CHECKER ปลดผู้ค้ำไม่ได้: 403', await releasePartyCall(L1.id, gPartyId, 'checker may not either', tokens.checker1), 403, { messageIncludes: 'Requires role' });
    statusCheck(CAT, 'ปลดโดยไม่ใส่เหตุผล: 400', await releasePartyCall(L1.id, gPartyId, '', tokens.head), 400);

    const gRelease = await releasePartyCall(L1.id, gPartyId, 'family relationship ended', tokens.head);
    statusCheck(CAT, 'HEAD_APPROVER ปลดผู้ค้ำพร้อมเหตุผล: 200', gRelease, 200);
    check(CAT, 'ปลดแล้วสถานะ RELEASED + เก็บวันและเหตุผลไว้ (ประวัติเดิมไม่หายไป)', {
      input: `POST /loans/:id/parties/${gPartyId}/release`,
      expected: 'status RELEASED, releasedAt วันนี้, releaseReason ตรงกับที่พิมพ์',
      actual: `status=${gRelease.json?.data?.status}, releasedAt=${day(gRelease.json?.data?.releasedAt)}, reason=${gRelease.json?.data?.releaseReason}`,
      pass:
        gRelease.json?.data?.status === 'RELEASED' &&
        day(gRelease.json?.data?.releasedAt) === TODAY &&
        gRelease.json?.data?.releaseReason === 'family relationship ended',
    });
    // ต้องตรวจ "ปลดซ้ำ" NOW ก่อนที่แถวจะถูกปลุกกลับเป็น ACTIVE ด้านล่าง มิฉะนั้นครั้งสองจะกลายเป็น 200
    statusCheck(CAT, 'ปลดซ้ำ: 422 (ปลดได้เฉพาะแถวที่ ACTIVE)', await releasePartyCall(L1.id, gPartyId, 'already released once', tokens.admin), 422, { messageIncludes: 'only an ACTIVE one can be released' });

    const allRowsView = await partiesOf(L1.id);
    const activeOnlyView = await partiesOf(L1.id, 'ACTIVE');
    check(CAT, 'ตัวกรอง ?status=ACTIVE ซ่อนประวัติที่ปลดแล้ว แต่ไม่กรองก็ยังเห็นทั้งก้อน', {
      input: `GET /loans/${L1.loanNumber}/parties (ทั้งหมด เทียบกับ ?status=ACTIVE)`,
      expected: 'ทั้งหมด 2 แถว (GUARANTOR:RELEASED + PAYER:ACTIVE), ACTIVE 1 แถว',
      actual: `all ${allRowsView?.parties?.length} [${allRowsView?.parties?.map((p) => `${p.party.role}:${p.party.status}`).join(', ')}], active ${activeOnlyView?.parties?.length}, loan ${activeOnlyView?.loan?.loanNumber}`,
      pass:
        allRowsView?.parties?.length === 2 &&
        activeOnlyView?.parties?.length === 1 &&
        activeOnlyView?.parties?.[0]?.party?.role === 'PAYER' &&
        activeOnlyView?.loan?.loanNumber === L1.loanNumber,
    });

    await settle(1200);
    const revived = await registerPartyCall(L1.id, { customerId: guarantor.id, role: 'GUARANTOR', relationship: 'sister' });
    statusCheck(CAT, 'ตั้งคนเดิมกลับเข้ามาใหม่ (re-engagement): 201 — ใช้แถวเดิม ไม่สร้างแถวซ้ำ', revived, 201);
    const revivedKyc = await partyKyc(L1.id, revived.json?.data?.id);
    check(CAT, 'แถวเดิมถูกปลุกกลับเป็น ACTIVE และ engagedAt เลื่อนไปข้างหน้า → เกณฑ์ KYC เริ่มนับใหม่ทันที', {
      input: `POST /parties GUARANTOR คนเดิมหลังถูกปลด (id เดิม ${gPartyId})`,
      expected: 'id เดิม, status ACTIVE, engagedAt วันนี้, nextAction กลับเป็น REOPEN_AND_RESUBMIT',
      actual: `sameId=${revived.json?.data?.id === gPartyId}, status=${revived.json?.data?.status}, engagedAt=${day(revived.json?.data?.engagedAt)}, effective=${revivedKyc?.effective}, nextAction=${revivedKyc?.nextAction}`,
      pass:
        revived.json?.data?.id === gPartyId &&
        revived.json?.data?.status === 'ACTIVE' &&
        day(revived.json?.data?.engagedAt) === TODAY &&
        revivedKyc?.effective === false &&
        revivedKyc?.nextAction === 'REOPEN_AND_RESUBMIT',
    });

    const reengagedCount = Number((await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE loanId = ? AND action = 'LOAN_PARTY_REENGAGED'", [L1.id]))[0].n);
    const registeredCount = Number((await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE loanId = ? AND action = 'LOAN_PARTY_REGISTERED'", [L1.id]))[0].n);
    check(CAT, 'audit แยก "ตั้งใหม่" ออกจาก "ตั้งครั้งแรก" (REENGAGED 1 แถว, REGISTERED 2 แถว)', {
      input: 'audit_logs ของเงินกู้นี้',
      expected: 'LOAN_PARTY_REENGAGED=1, LOAN_PARTY_REGISTERED=2 (ผู้ค้ำครั้งแรก + ผู้ชำระแทน)',
      actual: `REENGAGED=${reengagedCount}, REGISTERED=${registeredCount}`,
      pass: reengagedCount === 1 && registeredCount === 2,
    });

    statusCheck(CAT, 'ปลดแถวที่ไม่มีอยู่: 404', await releasePartyCall(L1.id, NIL, 'ghost'), 404);

    const deadLoan = (await rows(conn, "SELECT id, status FROM loans WHERE status <> 'ACTIVE' ORDER BY id LIMIT 1", []))[0] ?? null;
    statusCheck(
      CAT,
      'ห้ามตั้งผู้ค้ำบนเงินกู้ที่ไม่ ACTIVE แล้ว: 422',
      deadLoan
        ? await registerPartyCall(deadLoan.id, { customerId: stranger.id, role: 'GUARANTOR' })
        : await registerPartyCall(NIL, { customerId: stranger.id, role: 'GUARANTOR' }),
      deadLoan ? 422 : 404,
      { input: deadLoan ? `loan ${deadLoan.status}` : 'no non-ACTIVE loan in the seeded book', messageIncludes: deadLoan ? 'needs an ACTIVE loan' : undefined },
    );

    statusCheck(CAT, 'ADMIN reopen KYC ที่ VERIFIED แล้ว เพื่อให้มีการตรวจใหม่ตาม engagement: 200', await api('POST', `/api/customers/${guarantor.id}/kyc/reopen`, { token: tokens.admin, body: { reason: 're-verify for this engagement' } }), 200);
    const reopenedKyc = await partyKyc(L1.id, gPartyId);
    check(CAT, 'reopen แล้วสถานะเป็น PENDING → คิวงานบอก AWAIT_REVIEW (เอกสารเดิมยังอยู่ครบ)', {
      input: 'GET /loans/:id/parties หลัง reopen',
      expected: 'status PENDING, effective false, nextAction AWAIT_REVIEW',
      actual: `status=${reopenedKyc?.status}, effective=${reopenedKyc?.effective}, nextAction=${reopenedKyc?.nextAction}`,
      pass: reopenedKyc?.status === 'PENDING' && reopenedKyc?.effective === false && reopenedKyc?.nextAction === 'AWAIT_REVIEW',
    });
    statusCheck(CAT, 'CHECKER ตรวจซ้ำหลัง engagement: 200', await api('POST', `/api/customers/${guarantor.id}/kyc/verify`, { token: tokens.checker2, body: { note: 'verified for the guarantor engagement' } }), 200);
    const gKycNow = await partyKyc(L1.id, gPartyId);
    check(CAT, 'เมื่อใบตรวจใหม่ dated หลัง engagedAt → ผู้ค้ำสมบูรณ์โดยไม่ต้อง upload เอกสารเพิ่ม', {
      input: 'GET /loans/:id/parties หลัง reopen + verify',
      expected: 'effective true, nextAction NONE',
      actual: `status=${gKycNow?.status}, effective=${gKycNow?.effective}, nextAction=${gKycNow?.nextAction}, reviewedAt=${gKycNow?.reviewedAt ?? null}`,
      pass: gKycNow?.effective === true && gKycNow?.nextAction === 'NONE',
    });

    // ============================================================ C. collateral + เกณฑ์ความคุ้มทุน
    const emptyCoverage = await coverageOf(L4.id);
    check(CAT, 'เงินกู้ที่ยังไม่จดหลักประกัน: pledgedCount 0, coverage 0%, passed false พร้อมเหตุผลตรง ๆ', {
      input: `GET /loans/${L4.loanNumber}/collaterals/coverage`,
      expected: 'pledgedCount 0, coveragePercent 0, passed false, reason "no pledged collateral on record"',
      actual: `pledgedCount=${emptyCoverage?.coverage?.pledgedCount}, percent=${emptyCoverage?.coverage?.coveragePercent}, passed=${emptyCoverage?.coverage?.passed}, reasons=${emptyCoverage?.coverage?.reasons?.join(' | ')}`,
      pass:
        emptyCoverage?.coverage?.pledgedCount === 0 &&
        emptyCoverage?.coverage?.passed === false &&
        /no pledged collateral/.test(emptyCoverage?.coverage?.reasons?.[0] ?? ''),
    });

    statusCheck(CAT, 'จดหลักประกันมูลค่า 0: 400 (zod positive — ไม่มีหลักทรัพย์ปลอม ๆ ในระบบ)', await pledgeCall(L4.id, { type: 'EQUIPMENT', description: 'zero pledge', appraisedValue: 0 }), 400);
    statusCheck(CAT, 'จดหลักประกันที่ valuedAt เป็นอนาคต: 422', await pledgeCall(L4.id, { type: 'LAND', description: 'time travel pledge', appraisedValue: 1000, valuedAt: '2099-01-01' }), 422, { messageIncludes: 'valuedAt cannot be in the future' });
    statusCheck(
      CAT,
      'เอาทรัพย์สินของคนที่ไม่ได้มีบทบาทบนสินเชื่อนี้มาค้ำ: 422',
      await pledgeCall(L4.id, { type: 'BUILDING', description: 'somebody else building', appraisedValue: 500000, ownerCustomerId: stranger.id }),
      422,
      { messageIncludes: 'holds no active role on this loan' },
    );

    const billedL4 = sumCents(L4.billed);
    const halfValue = toLak(Math.floor(billedL4 / 2));
    const halfPledge = await pledgeCall(L4.id, { type: 'LAND', description: `Half pledge ${L4.loanNumber}`, appraisedValue: halfValue, valuedAt: TODAY, ownerCustomerId: borrower4.id });
    statusCheck(CAT, 'ผู้กู้เป็นเจ้าของทรัพย์เอง จดได้: 201', halfPledge, 201);
    const halfView = await collateralOf(L4.id);
    check(CAT, 'หลักประกันครึ่งเดียวของหนี้ → coverage ~50% ไม่ผ่านเกณฑ์ 100% (reason บอกตัวเลขทั้งก้อน)', {
      input: `GET /loans/${L4.loanNumber}/collaterals (จด ${fmt(toCents(halfValue))} ของหนี้ ${fmt(billedL4)})`,
      expected: `appraisedTotal ${fmt(toCents(halfValue))}, coveragePercent ~50, passed false, required ${shippedPolicy.minCoveragePercent}`,
      actual: `total=${fmt(cent(halfView?.coverage?.appraisedTotal))}, percent=${halfView?.coverage?.coveragePercent}, passed=${halfView?.coverage?.passed}, required=${halfView?.coverage?.requiredCoveragePercent}, reasons=${halfView?.coverage?.reasons?.[0]}`,
      pass:
        halfView?.coverage?.passed === false &&
        cent(halfView?.coverage?.appraisedTotal) === cent(halfValue) &&
        halfView?.coverage?.coveragePercent > 45 &&
        halfView?.coverage?.coveragePercent < 55 &&
        halfView?.coverage?.requiredCoveragePercent === shippedPolicy.minCoveragePercent,
    });
    check(CAT, 'payload collateral มีครบ loan + รายการ + policy + coverage (ผู้อนุมัติจึงเห็นชุดเดียวกับที่เซิร์ฟเวอร์ใช้ตัดสิน)', {
      input: 'Object.keys(data)',
      expected: 'collaterals, coverage, loan, policy',
      actual: Object.keys(halfView ?? {}).sort().join(', '),
      pass: ['loan', 'collaterals', 'policy', 'coverage'].every((k) => k in (halfView ?? {})),
    });

    const topUp = await pledgeCall(L4.id, {
      type: 'VEHICLE',
      description: `Top vehicle ${L4.loanNumber}`,
      appraisedValue: toLak(billedL4 - cent(halfValue)),
      valuedAt: TODAY,
    });
    statusCheck(CAT, 'จดเพิ่มจนครบ 100% ของหนี้: 201', topUp, 201);
    const fullView = await coverageOf(L4.id);
    check(CAT, 'ครบเกณฑ์แล้ว passed true, pledgedCount 2 และ coveragePercent >= เกณฑ์', {
      input: `GET /loans/${L4.loanNumber}/collaterals/coverage`,
      expected: `passed true, pledgedCount 2, percent >= ${shippedPolicy.minCoveragePercent}`,
      actual: `passed=${fullView?.coverage?.passed}, percent=${fullView?.coverage?.coveragePercent}, pledgedCount=${fullView?.coverage?.pledgedCount}, total=${fmt(cent(fullView?.coverage?.appraisedTotal))}`,
      pass:
        fullView?.coverage?.passed === true &&
        fullView?.coverage?.pledgedCount === 2 &&
        cent(fullView?.coverage?.appraisedTotal) === billedL4,
    });

    const goldDate = daysAgo(60);
    const goldDescription = `Old appraisal ${L4.loanNumber}`;
    const stalePledge = await pledgeCall(L4.id, { type: 'GOLD', description: goldDescription, appraisedValue: 100, valuedAt: goldDate });
    statusCheck(CAT, 'จดทรัพย์ที่ประเมินไว้ 60 วันก่อน: 201 (ระบบยังรับไว้ — เกณฑ์ต่างหากที่ตัดสินว่านับหรือไม่)', stalePledge, 201);

    const goldAudit = (
      await rows(conn, "SELECT reason FROM audit_logs WHERE loanId = ? AND action = 'LOAN_COLLATERAL_PLEDGED' AND reason LIKE ? LIMIT 1", [L4.id, `%${goldDescription}%`])
    )[0]?.reason ?? '';
    check(CAT, 'F-HSR-2: วันที่ใน oldestValuedAt และใน audit reason ต้องเป็น ISO day (YYYY-MM-DD)', {
      input: `coverage.oldestValuedAt + audit reason ของรายการที่จดไว้วันที่ ${goldDate}`,
      expected: `oldestValuedAt = ${goldDate} และ audit ลงท้าย "on ${goldDate}"`,
      actual: `oldestValuedAt=${JSON.stringify(fullView?.coverage?.oldestValuedAt)} (GOLD ยังไม่ถูกนับ), audit=${JSON.stringify(goldAudit.slice(-24))}`,
      pass: ISO_DAY.test(String(fullView?.coverage?.oldestValuedAt ?? '')) && goldAudit.includes(`on ${goldDate}`),
      note:
        'collateral.service ใช้ String(valuedAt).slice(0,10) กับวัตถุ Date (3 จุด: oldestValuedAt, ข้อความ warning, audit reason) ' +
        'ซึ่งได้ "Wed Oct 14" ไม่ใช่ ISO จึงทำให้หน้าเว็บและ audit อ่านวันไม่รู้เรื่อง — รายงานไว้ ไม่ได้แก้โค้ดระบบ',
    });

    await setPolicy({ maxValuationAgeDays: 30 });
    const staleView = await coverageOf(L4.id);
    check(CAT, 'maxValuationAgeDays=30: ใบประเมินที่เก่ากว่านั้นไม่ถูกนับเป็นหลักประกัน แต่ไม่หายจากทะเบียน + มี warning ระบุรายการ', {
      input: 'PUT /api/config/collateral {maxValuationAgeDays:30} แล้วดู coverage',
      expected: `appraisedTotal กลับเป็น ${fmt(billedL4)} (ตัด GOLD ออก), warnings 1 รายการ, pledgedCount 3, passed ยัง true`,
      actual: `total=${fmt(cent(staleView?.coverage?.appraisedTotal))}, warnings=${(staleView?.coverage?.warnings ?? []).length} [${staleView?.coverage?.warnings?.[0] ?? ''}], pledgedCount=${staleView?.coverage?.pledgedCount}, valuationMaxAgeDays=${staleView?.coverage?.valuationMaxAgeDays}, passed=${staleView?.coverage?.passed}`,
      pass:
        staleView?.coverage?.valuationMaxAgeDays === 30 &&
        (staleView?.coverage?.warnings ?? []).length === 1 &&
        staleView?.coverage?.pledgedCount === 3 &&
        /older than 30/.test(staleView?.coverage?.warnings?.[0] ?? '') &&
        cent(staleView?.coverage?.appraisedTotal) === billedL4 &&
        staleView?.coverage?.passed === true,
    });

    await setPolicy({ maxValuationAgeDays: 0 });
    const neverExpires = await coverageOf(L4.id);
    check(CAT, 'maxValuationAgeDays=0 คือค่าจริงแบบ "ไม่หมดอายุ" (0 ไม่ใช่ค่าว่าง) → ใบประเมินเก่ากลับมานับ', {
      input: 'PUT /api/config/collateral {maxValuationAgeDays:0}',
      expected: `warnings 0, appraisedTotal = ${fmt(billedL4 + 10000)} (รวม GOLD 100.00)`,
      actual: `warnings=${(neverExpires?.coverage?.warnings ?? []).length}, total=${fmt(cent(neverExpires?.coverage?.appraisedTotal))}`,
      pass:
        (neverExpires?.coverage?.warnings ?? []).length === 0 &&
        cent(neverExpires?.coverage?.appraisedTotal) === billedL4 + 10000,
    });
    const policyBackToShipped = await setPolicy({ maxValuationAgeDays: shippedPolicy.maxValuationAgeDays });
    check(CAT, 'คืน maxValuationAgeDays เป็นค่า shipped ของเซิร์ฟเวอร์แล้ว (GOLD กลับมาถูกนับ)', {
      input: 'PUT /api/config/collateral {maxValuationAgeDays: <defaults>}',
      expected: `maxValuationAgeDays ${shippedPolicy.maxValuationAgeDays}, appraisedTotal รวม GOLD`,
      actual: `maxValuationAgeDays=${policyBackToShipped?.maxValuationAgeDays}, total=${fmt(cent((await coverageOf(L4.id)).coverage?.appraisedTotal))}`,
      pass: policyBackToShipped?.maxValuationAgeDays === shippedPolicy.maxValuationAgeDays,
    });

    statusCheck(CAT, 'HEAD ปลดหลักประกันพร้อมเหตุผล: 200', await releasePledgeCall(L4.id, topUp.json?.data?.id, 'vehicle sold', tokens.head), 200);
    statusCheck(CAT, 'CHECKER ปลดหลักประกันไม่ได้: 403 (การถอนประกันเป็นอำนาจหัวหน้า)', await releasePledgeCall(L4.id, halfPledge.json?.data?.id, 'checker cannot', tokens.checker1), 403, { messageIncludes: 'Requires role' });
    statusCheck(CAT, 'ปลดซ้ำ: 422 (เฉพาะรายการที่ PLEDGED)', await releasePledgeCall(L4.id, topUp.json?.data?.id, 'again', tokens.admin), 422, { messageIncludes: 'only a PLEDGED item can be released' });
    statusCheck(CAT, 'ปลดรายการที่ไม่มีอยู่: 404', await releasePledgeCall(L4.id, NIL, 'ghost'), 404);
    const afterRelease = await coverageOf(L4.id);
    check(CAT, 'หลังปลด 1 รายการ ความคุ้มทุนลดตามมูลค่าที่ถูกถอน (และกลายเป็นไม่ผ่านเกณฑ์)', {
      input: 'release vehicle pledge แล้ว GET /coverage',
      expected: 'appraisedTotal ต่ำกว่ายอดหนี้, coveragePercent < 100, passed false',
      actual: `total=${fmt(cent(afterRelease?.coverage?.appraisedTotal))}, percent=${afterRelease?.coverage?.coveragePercent}, outstanding=${fmt(cent(afterRelease?.loan?.outstanding))}, passed=${afterRelease?.coverage?.passed}`,
      pass:
        cent(afterRelease?.coverage?.appraisedTotal) < cent(afterRelease?.loan?.outstanding) &&
        afterRelease?.coverage?.coveragePercent < 100 &&
        afterRelease?.coverage?.passed === false,
    });

    const pledgeAudit = await rows(conn, "SELECT action, COUNT(*) n FROM audit_logs WHERE loanId = ? AND action LIKE 'LOAN_COLLATERAL%' GROUP BY action", [L4.id]);
    const pledgeAuditMap = Object.fromEntries(pledgeAudit.map((r) => [r.action, Number(r.n)]));
    check(CAT, 'ทะเบียน audit หลักประกัน: PLEDGED 3 ครั้ง / RELEASED 1 ครั้ง', {
      input: 'audit_logs action LOAN_COLLATERAL_*',
      expected: 'LOAN_COLLATERAL_PLEDGED=3, LOAN_COLLATERAL_RELEASED=1',
      actual: JSON.stringify(pledgeAuditMap),
      pass: (pledgeAuditMap.LOAN_COLLATERAL_PLEDGED ?? 0) === 3 && (pledgeAuditMap.LOAN_COLLATERAL_RELEASED ?? 0) === 1,
    });

    // ============================================================ D. การตรวจข้อเสนอ (ไม่เขียนอะไรเลย)
    statusCheck(CAT, 'proposed-payer ด้วย id ที่ไม่ใช่ uuid: 400', await proposedPayerCall(L1.id, NOT_A_UUID), 400);
    statusCheck(CAT, 'proposed-payer คนที่ไม่มีบทบาทบนสินเชื่อนี้: 200 + payer = null (เป็น endpoint อ่านอย่างเดียว)', await proposedPayerCall(L1.id, NIL), 200);
    const knownPayer = await proposedPayerCall(L1.id, guarantor.id);
    check(CAT, 'proposed-payer คืนสถานะ KYC ของ engagement ที่ใช้ตัดสิน พร้อม engagedAt', {
      input: `POST /restructures/proposed-payer/${L1.loanNumber} = ผู้ค้ำที่ตรวจผ่านแล้ว`,
      expected: 'kyc.effective true, fullName = ผู้ค้ำ, engagedAt วันนี้',
      actual: `effective=${knownPayer.json?.data?.payer?.kyc?.effective}, name=${knownPayer.json?.data?.payer?.fullName}, engagedAt=${day(knownPayer.json?.data?.payer?.engagedAt)}`,
      pass:
        knownPayer.json?.data?.payer?.kyc?.effective === true &&
        knownPayer.json?.data?.payer?.fullName === guarantor.fullName &&
        day(knownPayer.json?.data?.payer?.engagedAt) === TODAY,
    });

    const L1ctx = await restructureContext(L1.id);
    check(CAT, 'GET /restructures/context/:loanId คืนยอดคงเหลือ + ดอกที่ยังค้าง + เงื่อนไขปัจจุบัน + coverage + policy', {
      input: 'Object.keys(data)',
      expected: `loan, outstanding ${fmt(sumCents(L1.billed))}, accruedInterest ${fmt(L1.billed.PAST_INTEREST)}, before(rate ${L1.rate}, term ${L1.termMonths}), coverage, policy, proposedPayer`,
      actual: `${Object.keys(L1ctx ?? {}).sort().join(', ')} | before=${L1ctx?.before?.interestRate}/${L1ctx?.before?.termMonths}/${L1ctx?.before?.interestRatePeriod}, accrued=${fmt(cent(L1ctx?.accruedInterest))}, outstanding=${fmt(cent(L1ctx?.outstanding))}`,
      pass:
        ['loan', 'outstanding', 'accruedInterest', 'before', 'coverage', 'policy', 'proposedPayer'].every((k) => k in (L1ctx ?? {})) &&
        cent(L1ctx?.accruedInterest) === L1.billed.PAST_INTEREST &&
        cent(L1ctx?.outstanding) === sumCents(L1.billed) &&
        L1ctx?.before?.termMonths === L1.termMonths &&
        L1ctx?.before?.interestRate === L1.rate,
    });

    const validRate = Number((L1.rate / 2).toFixed(6));
    const deadLoanId = deadLoan?.id ?? NIL;
    const baseBody = { loanId: L1.id, hardshipReason: 'Borrower lost the contract that funded the repayments', changeTypes: ['INTEREST_RATE_REDUCTION'], newInterestRate: validRate };
    const rejects = [
      ['hardshipReason สั้นกว่า 10 ตัวอักษร', { ...baseBody, hardshipReason: 'too short' }, 400, ''],
      ['changeTypes ว่าง', { ...baseBody, changeTypes: [] }, 400, ''],
      ['changeTypes มีค่าซ้ำกัน', { loanId: L1.id, hardshipReason: 'duplicate change types', changeTypes: ['TERM_EXTENSION', 'TERM_EXTENSION'], newTermMonths: 24 }, 400, 'contains a duplicate'],
      ['loanId ที่ไม่ใช่ uuid', { ...baseBody, loanId: NOT_A_UUID }, 400, ''],
      ['เงินกู้ที่ไม่มีอยู่', { ...baseBody, loanId: NIL }, 404, ''],
      ['เงินกู้ที่ไม่ ACTIVE แล้ว', { ...baseBody, loanId: deadLoanId }, deadLoan ? 422 : 404, deadLoan ? 'rewrites a live contract' : ''],
      ['ขอลดดอกเบี้ยแต่ไม่ใส่ rate ใหม่', { loanId: L1.id, hardshipReason: 'reduce the rate please', changeTypes: ['INTEREST_RATE_REDUCTION'] }, 422, 'needs the new rate'],
      ['rate ใหม่เท่ากับของเดิม', { ...baseBody, newInterestRate: L1.rate }, 422, 'is not below the rate'],
      ['rate ใหม่สูงกว่าของเดิม', { ...baseBody, newInterestRate: Number((L1.rate * 2).toFixed(6)) }, 422, 'is not below the rate'],
      ['ส่ง rate มาทั้งที่ไม่ได้ขอ', { loanId: L1.id, hardshipReason: 'term only please', changeTypes: ['TERM_EXTENSION'], newTermMonths: 24, newInterestRate: validRate }, 422, 'without asking for a rate reduction'],
      ['ขอขยาย term เท่าเดิม', { loanId: L1.id, hardshipReason: 'same term please', changeTypes: ['TERM_EXTENSION'], newTermMonths: L1.termMonths }, 422, 'above the current term'],
      ['ขอขยาย term สั้นลง', { loanId: L1.id, hardshipReason: 'shorter term please', changeTypes: ['TERM_EXTENSION'], newTermMonths: L1.termMonths - 3 }, 422, 'above the current term'],
      ['ขอขยาย term เกิน 600 เดือน', { loanId: L1.id, hardshipReason: 'absurd term please', changeTypes: ['TERM_EXTENSION'], newTermMonths: 601 }, 422, 'cannot exceed 600 months'],
      ['ส่ง term มาทั้งที่ไม่ได้ขอ', { ...baseBody, newTermMonths: 24 }, 422, 'without asking for an extension'],
      ['เปลี่ยนผู้ชำระแต่ไม่ระบุคน', { loanId: L1.id, hardshipReason: 'payer swap please', changeTypes: ['PAYER_CHANGE'] }, 422, 'needs the customer who will pay'],
      ['ระบุคนที่ระบบยังไม่เคยตั้งเป็น party บนสินเชื่อนี้', { loanId: L1.id, hardshipReason: 'payer swap please', changeTypes: ['PAYER_CHANGE'], newPayerCustomerId: otherPayer.id }, 422, 'register them as a guarantor or payer first'],
      ['ส่งผู้ชำระมาทั้งที่ไม่ได้ขอ', { ...baseBody, newPayerCustomerId: guarantor.id }, 422, 'without asking for a payer change'],
      ['ขอ relief แต่ยอด 0', { loanId: L1.id, hardshipReason: 'relief please', changeTypes: ['INTEREST_RELIEF'], interestReliefAmount: 0 }, 422, 'amount greater than zero'],
      ['relief เกินดอกเบี้ยที่ค้าง', { loanId: L1.id, hardshipReason: 'relief too big', changeTypes: ['INTEREST_RELIEF'], interestReliefAmount: toLak(L1.billed.PAST_INTEREST) + 1000 }, 422, 'cannot cancel more interest'],
      ['ส่งยอด relief มาทั้งที่ไม่ได้ขอ', { ...baseBody, interestReliefAmount: 1000 }, 422, 'without asking for relief'],
    ];
    for (const [name, body, expStatus, includes] of rejects) {
      const res = await createAddendum(body);
      statusCheck(CAT, `ข้อเสนอถูกปฏิเสธ: ${name}`, res, expStatus, { input: JSON.stringify(body), messageIncludes: includes || undefined });
    }

    const restructureCountAfterRejects = Number((await rows(conn, 'SELECT COUNT(*) n FROM restructure_requests', []))[0].n);
    const staleWorkflows = Number((await rows(conn, "SELECT COUNT(*) n FROM approval_workflows WHERE subjectType = 'RESTRUCTURE_REQUEST'", []))[0].n);
    check(CAT, 'ใบที่ถูกปฏิเสธทั้งหมดไม่ทิ้งอะไรไว้เลย (จำนวนใบเท่าเดิม, ไม่มี workflow ค้าง)', {
      input: `COUNT restructure_requests = ${restructureCountAfterRejects}, workflows of RESTRUCTURE_REQUEST = ${staleWorkflows}`,
      expected: '0 แถวทั้งสองตาราง (suite นี้ยังไม่ได้สร้างใบที่ผ่านสักใบ)',
      actual: `${restructureCountAfterRejects} แถว, ${staleWorkflows} workflows`,
      pass: restructureCountAfterRejects === 0 && staleWorkflows === 0,
    });

    const partyOnL4 = await registerPartyCall(L4.id, { customerId: otherPayer.id, role: 'PAYER' });
    statusCheck(CAT, 'ตั้งผู้ชำระแทนคนใหม่บนกู้ที่มีหลักประกัน (ยังไม่มี KYC): 201', partyOnL4, 201);
    statusCheck(
      CAT,
      'เปลี่ยนผู้ชำระแทนคนที่ KYC ยังไม่ครบตาม engagement: 422 (ห้ามใช้คนที่ยังไม่ตรวจ)',
      await createAddendum({
        loanId: L4.id,
        hardshipReason: 'Payer candidate has no verified engagement yet',
        changeTypes: ['PAYER_CHANGE'],
        newPayerCustomerId: otherPayer.id,
      }),
      422,
      { messageIncludes: 'KYC is not verified for this engagement' },
    );

    const noPledgeLoan = await newLoan({ customer: await newCustomer('Borrower Five'), principal: principalBelow(TH.checkerThreshold * 0.4), disbursedAt: TODAY, label: 'HARDSHIP-UNSECURED' });
    const unsecuredBody = {
      loanId: noPledgeLoan.id,
      hardshipReason: 'Unsecured book should be allowed to restructure',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: Number((P12.interestRate / 2).toFixed(6)),
    };
    statusCheck(CAT, 'requirePledgeForRestructure=true ปิดทางกู้ที่ไม่มีหลักประกัน: 422', await createAddendum(unsecuredBody), 422, {
      messageIncludes: 'This loan has no pledged collateral on record',
    });
    await setPolicy({ requirePledgeForRestructure: false });
    statusCheck(CAT, 'ปิด requirePledgeForRestructure (ยอมรับหนังสือว่าเล่มนี้ปล่อยกู้แบบไม่มีประกันได้): ใบเดียวกันผ่าน 201', await createAddendum(unsecuredBody), 201);
    await setPolicy({ requirePledgeForRestructure: true });

    await setPolicy({ minCoveragePercent: 0 });
    statusCheck(CAT, 'minCoveragePercent=0 คือ "ไม่มีเกณฑ์" จริง (0 ไม่ใช่ค่าว่าง): กู้ที่ประกันไม่ครบก็ปรับได้ 201', await createAddendum({
      loanId: L4.id,
      hardshipReason: 'Coverage floor switched off for this book',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: Number((P12.interestRate / 2).toFixed(6)),
    }), 201);

    await setPolicy({ minCoveragePercent: 1000 });
    statusCheck(CAT, 'minCoveragePercent=1000 เกินกว่าจะหาได้: 422 Collateral check failed (บนกู้ที่มีหลักประกันอยู่จริง)', await createAddendum({
      loanId: L4.id,
      hardshipReason: 'Coverage floor raised to an unreachable level',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: Number((P12.interestRate / 2).toFixed(6)),
    }), 422, { messageIncludes: 'Collateral check failed' });

    await setPolicy(shippedPolicy);
    const policyNow = (await api('GET', '/api/config/collateral')).json?.data?.policy;
    check(CAT, 'คืน policy เป็นค่า shipped ของเซิร์ฟเวอร์ก่อนเข้าหมวดอนุมัติ (ครบทั้ง 3 ค่า)', {
      input: 'PUT /api/config/collateral ด้วย defaults ที่เซิร์ฟเวอร์รายงาน',
      expected: JSON.stringify(shippedPolicy),
      actual: JSON.stringify(policyNow),
      pass: JSON.stringify(policyNow) === JSON.stringify(shippedPolicy),
    });

    // ============================================================ E. ชั้นอนุมัติ + การตัดสินใจ
    await ensureCoverage(L1);
    await ensureCoverage(L2);
    await ensureCoverage(L4);

    const smallAddendum = await createAddendum({
      loanId: L2.id,
      hardshipReason: 'Salary arrived late for three months, the borrower asks for relief',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: validRate,
    });
    statusCheck(CAT, 'สร้างใบปรับโครงสร้าง (MAKER เป็นคนร่าง): 201 สถานะ PENDING_APPROVAL', smallAddendum, 201);
    const smallRow = smallAddendum.json?.data ?? {};
    const smallId = smallRow.id;

    check(CAT, 'ใบร่างเก็บ snapshot ครบ: requestNo แบบ RS-######, before/after, collateralSnapshot, ยอดที่ใช้คิดชั้นอนุมัติ', {
      input: `POST /api/restructures บน ${L2.loanNumber} (คงเหลือ ${fmt(sumCents(L2.billed))})`,
      expected: `status PENDING_APPROVAL, requestNo /^RS-\\d{6}$/, before ${L2.rate} -> after ${validRate}, term ${L2.termMonths} คงเดิม, repricingAmount ${fmt(sumCents(L2.billed))}, snapshot.passed true`,
      actual: `status=${smallRow.status}, requestNo=${smallRow.requestNo}, before=${smallRow.beforeTerms?.interestRate}/${smallRow.beforeTerms?.termMonths}, after=${smallRow.afterTerms?.interestRate}/${smallRow.afterTerms?.termMonths}, repricing=${fmt(cent(smallRow.repricingAmount))}, snapshot.passed=${smallRow.collateralSnapshot?.passed}`,
      pass:
        smallRow.status === 'PENDING_APPROVAL' &&
        /^RS-\d{6}$/.test(String(smallRow.requestNo)) &&
        smallRow.beforeTerms?.interestRate === L2.rate &&
        smallRow.afterTerms?.interestRate === validRate &&
        smallRow.afterTerms?.termMonths === L2.termMonths &&
        cent(smallRow.repricingAmount) === sumCents(L2.billed) &&
        smallRow.collateralSnapshot?.passed === true,
    });

    const smallQueueItem = await queueItemFor(smallId, tokens.head);
    const expectedSmallLevels = widen(levelsFromAmount(num(smallRow.repricingAmount), TH), RESTRUCTURE_FLOOR);
    check(CAT, 'คิวรออนุมัติเห็นใบนี้ และกำหนดชั้นเป็น Checker + Head ทั้งที่ยอดต่ำกว่า threshold (เพดานต่ำสุดของงานประเภทนี้)', {
      input: `GET /api/approvals/pending subjectId=${smallRow.requestNo} (ยอด ${fmt(cent(smallRow.repricingAmount))}, checkerThreshold ${fmt(TH.checkerThreshold)})`,
      expected: `subjectType RESTRUCTURE_REQUEST, currentLevel CHECKER, remainingLevels ${expectedSmallLevels.join(',')} (ตามยอดล้วน ๆ ต้องการแค่ ${levelsFromAmount(num(smallRow.repricingAmount), TH).join(',')})`,
      actual: `subjectType=${smallQueueItem?.subjectType}, level=${smallQueueItem?.currentLevel}, remaining=${smallQueueItem?.remainingLevels?.join(',')}, canDecide(head)=${smallQueueItem?.canDecide}`,
      pass:
        smallQueueItem?.subjectType === 'RESTRUCTURE_REQUEST' &&
        smallQueueItem?.currentLevel === 'CHECKER' &&
        (smallQueueItem?.remainingLevels ?? []).join(',') === expectedSmallLevels.join(','),
      note: 'การที่ workflow มี HEAD ด้วยทั้งที่ยอดเล็กคือ floor ของงาน restructure ไม่ใช่บั๊กของ threshold — ผู้มีอำนาจอย่างน้อย 2 ชั้นทุกใบ',
    });
    statusCheck(CAT, 'HEAD ตัดสินชั้น CHECKER ไม่ได้: 403 (ระดับอำนาจไม่ถึง)', await decideCall(smallQueueItem.stepId, { decision: 'APPROVE', reason: 'head jumping ahead' }, tokens.head), 403, {
      messageIncludes: 'cannot decide a CHECKER approval step',
    });

    const ownRequest = await createAddendum(
      {
        loanId: L3.id,
        hardshipReason: 'Checker drafted this addendum and must not approve it',
        changeTypes: ['TERM_EXTENSION'],
        newTermMonths: L3.termMonths + 6,
      },
      tokens.checker1,
    );
    statusCheck(CAT, 'CHECKER ก็เป็น operator: ร่างใบของเงินกู้ก้อนใหญ่ได้ 201', ownRequest, 201);
    const ownRow = ownRequest.json?.data ?? {};
    const ownItem = await queueItemFor(ownRow.id, tokens.checker1);
    check(CAT, 'คิวบอกผู้ร่างชัดเจน: รายการที่ maker เห็นขึ้น flagged (blockedForUser true, canDecide false)', {
      input: `GET /approvals/pending ด้วย token ของคนที่ร่างใบ ${ownRow.requestNo}`,
      expected: 'blockedForUser true, canDecide false, currentLevel CHECKER',
      actual: `blockedForUser=${ownItem?.blockedForUser}, canDecide=${ownItem?.canDecide}, level=${ownItem?.currentLevel}, remaining=${ownItem?.remainingLevels?.join(',')}`,
      pass: ownItem?.blockedForUser === true && ownItem?.canDecide === false && ownItem?.currentLevel === 'CHECKER',
    });
    statusCheck(CAT, 'คนร่างอนุมัติใบตัวเองไม่ได้: 422 maker-checker separation (ทุกขั้นตอน)', await decideCall(ownItem.stepId, { decision: 'APPROVE', reason: 'I drafted it' }, tokens.checker1), 422, {
      messageIncludes: 'maker cannot approve their own request',
    });

    const expectedBigLevels = widen(levelsFromAmount(num(ownRow.repricingAmount), TH), RESTRUCTURE_FLOOR);
    check(CAT, 'เงินกู้ก้อนใหญ่ (> head threshold) ต้องเพิ่มชั้น ADMIN เหนือ floor เดิม', {
      input: `คิวของใบ ${ownRow.requestNo} (repricing ${fmt(cent(ownRow.repricingAmount))}, headThreshold ${fmt(TH.headThreshold)})`,
      expected: `remainingLevels ${expectedBigLevels.join(',')}`,
      actual: `remaining=${ownItem?.remainingLevels?.join(',')}`,
      pass: (ownItem?.remainingLevels ?? []).join(',') === expectedBigLevels.join(',') && expectedBigLevels.includes('ADMIN'),
    });

    const bigSteps = await stepsOf(ownItem.workflowId);
    const adminStep = bigSteps.find((s) => s.level === 'ADMIN');
    if (adminStep) {
      statusCheck(CAT, 'ข้ามชั้นไปตัดสิน ADMIN step ทั้งที่คิวอยู่ CHECKER: 409 (ต้องเรียงชั้น)', await decideCall(adminStep.id, { decision: 'APPROVE', reason: 'out of order' }, tokens.admin), 409, {
        messageIncludes: 'not the current level',
      });
    } else {
      check(CAT, 'ข้ามชั้นไปตัดสิน ADMIN step ทั้งที่คิวอยู่ CHECKER: 409 (ต้องเรียงชั้น)', {
        input: `levels ของใบ ${ownRow.requestNo}`,
        expected: `มี ADMIN step ให้ลองข้าม (${expectedBigLevels.join(',')})`,
        actual: `steps = ${bigSteps.map((s) => s.level).join(',') || 'ไม่มี'}`,
        pass: false,
        note: 'เคส remainingLevels ด้านบนแดง จึงทดสอบการข้ามชั้นไม่ได้ — ไม่ใช่บั๊กของเครื่องอนุมัติ',
      });
    }

    const checkerFirst = await decideCall(smallQueueItem.stepId, { decision: 'APPROVE', reason: 'checked the hardship file' }, tokens.checker2);
    statusCheck(CAT, 'CHECKER อนุมัติชั้นแรก: 200', checkerFirst, 200);
    const stillPending = await addendumOf(smallId);
    check(CAT, 'ผ่านชั้นแรกแล้ว ใบยัง PENDING_APPROVAL และเงื่อนไขเงินกู้ยังไม่ขยับ (ยังไม่มีอะไรถูกแก้)', {
      input: `GET /api/restructures/${smallRow.requestNo}`,
      expected: `status PENDING_APPROVAL, loan rate ${L2.rate}, term ${L2.termMonths}`,
      actual: `status=${stillPending?.request?.status}, rate=${stillPending?.loan?.interestRate}, term=${stillPending?.loan?.termMonths}, remaining=${(await queueItemFor(smallId, tokens.head))?.remainingLevels?.join(',')}`,
      pass:
        stillPending?.request?.status === 'PENDING_APPROVAL' &&
        stillPending?.loan?.interestRate === L2.rate &&
        stillPending?.loan?.termMonths === L2.termMonths,
    });

    const headStepItem = await queueItemFor(smallId, tokens.checker2);
    statusCheck(CAT, 'CHECKER อนุมัติชั้น HEAD ไม่ได้: 403 (ระดับอำนาจไม่ถึง)', await decideCall(headStepItem.stepId, { decision: 'APPROVE', reason: 'checker cannot sign the head level' }, tokens.checker2), 403, {
      messageIncludes: 'cannot decide a HEAD approval step',
    });
    statusCheck(CAT, 'HEAD อนุมัติชั้นสุดท้าย: 200 → workflow APPROVED', await decideCall(headStepItem.stepId, { decision: 'APPROVE', reason: 'committee agreed' }, tokens.head), 200);

    const approvedRow = await addendumOf(smallId);
    const approvedLoanView = await loanView(L2.id);
    check(CAT, 'อนุมัติครบแล้ว = APPROVED + บันทึกผู้ตัดสิน/เหตุผล/เวลา แต่สัญญายังไม่เปลี่ยน (ต้อง apply ก่อน)', {
      input: `GET /api/restructures/${smallRow.requestNo} + GET /api/loans/${L2.loanNumber}`,
      expected: `status APPROVED, decidedBy/decidedAt/decisionReason ถูกบันทึก, loan rate ${L2.rate}, term ${L2.termMonths}, waiver null, outstanding ${fmt(sumCents(L2.billed))}`,
      actual: `status=${approvedRow?.request?.status}, decidedBy=${approvedRow?.request?.decidedBy ? 'set' : 'null'}, decidedAt=${approvedRow?.request?.decidedAt ? 'set' : 'null'}, reason=${approvedRow?.request?.decisionReason}, rate=${approvedRow?.loan?.interestRate}, term=${approvedRow?.loan?.termMonths}, waiver=${approvedRow?.waiver ? 'present' : 'null'}, outstanding=${fmt(cent(approvedLoanView?.outstanding?.total))}`,
      pass:
        approvedRow?.request?.status === 'APPROVED' &&
        !!approvedRow?.request?.decidedBy &&
        !!approvedRow?.request?.decidedAt &&
        approvedRow?.request?.decisionReason === 'committee agreed' &&
        approvedRow?.loan?.interestRate === L2.rate &&
        approvedRow?.loan?.termMonths === L2.termMonths &&
        approvedRow?.waiver === null &&
        cent(approvedLoanView?.outstanding?.total) === sumCents(L2.billed),
    });

    const rejected = await createAddendum(
      { loanId: L2.id, hardshipReason: 'This second paper should not survive review', changeTypes: ['INTEREST_RATE_REDUCTION'], newInterestRate: Number((P12.interestRate / 4).toFixed(6)) },
      tokens.checker1,
    );
    statusCheck(CAT, 'ร่างใบที่สองบนเงินกู้เดิม (รอชั้นอนุมัติ): 201', rejected, 201);
    const rejectedRow0 = rejected.json?.data ?? {};
    const rejectedItem = await queueItemFor(rejectedRow0.id, tokens.checker2);
    statusCheck(CAT, 'ปฏิเสธโดยไม่ใส่เหตุผล: 400 (ทุกขั้นตอนต้องมีเหตุผลบันทึก)', await decideCall(rejectedItem.stepId, { decision: 'REJECT' }, tokens.checker2), 400, {
      messageIncludes: 'A rejection reason is required',
    });
    statusCheck(CAT, 'ปฏิเสธพร้อมเหตุผล: 200 → ใบ REJECTED และ workflow ปิด', await decideCall(rejectedItem.stepId, { decision: 'REJECT', reason: 'borrower can pay under current terms' }, tokens.checker2), 200);

    const rejectedState = await addendumOf(rejectedRow0.id);
    const rejectAuditCount = Number((await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE loanId = ? AND action = 'APPROVAL_STEP_REJECTED'", [L2.id]))[0].n);
    check(CAT, 'ใบที่ถูกปฏิเสธเก็บเหตุผลไว้ + audit APPROVAL_STEP_REJECTED + ไม่แก้สัญญาและไม่มี waiver', {
      input: `GET /api/restructures/${rejectedRow0.requestNo}`,
      expected: 'status REJECTED, decisionReason ตรงกับที่พิมพ์, waiver null, loan rate ไม่เปลี่ยน, audit APPROVAL_STEP_REJECTED 1 แถว',
      actual: `status=${rejectedState?.request?.status}, reason=${rejectedState?.request?.decisionReason}, waiver=${rejectedState?.waiver ? 'present' : 'null'}, rate=${rejectedState?.loan?.interestRate}, audit=${rejectAuditCount}`,
      pass:
        rejectedState?.request?.status === 'REJECTED' &&
        rejectedState?.request?.decisionReason === 'borrower can pay under current terms' &&
        rejectedState?.waiver === null &&
        rejectedState?.loan?.interestRate === L2.rate &&
        rejectAuditCount === 1,
      note: 'เครื่องอนุมัติบันทึกการปฏิเสธเป็น APPROVAL_STEP_REJECTED (ไม่มี action เฉพาะของ restructure) — ตรวจย้อนหลังก่อนได้ที่ workflow',
    });
    const rejectedMail = await outboxRows(L2.id, 'RESTRUCTURE_DECIDED');
    check(CAT, 'ทุกฝ่ายได้เมลผลการพิจารณาแม้ผลคือปฏิเสธ', {
      input: 'notification_outbox type=RESTRUCTURE_DECIDED ของเงินกู้ L2',
      expected: `>= 1 แถว และต้องมีถึงผู้กู้ ${borrower2.email} กับผู้มีอำนาจทุกคน`,
      actual: `${rejectedMail.length} แถว [${rejectedMail.map((r) => r.recipientEmail).join(', ')}]`,
      pass: rejectedMail.some((r) => r.recipientEmail === borrower2.email) && approverEmails.every((e) => rejectedMail.some((r) => r.recipientEmail === e)),
    });

    const listAll = await listAddenda('?limit=100');
    const listMine = await listAddenda(`?loanId=${L2.id}&limit=100`);
    const listRejected = await listAddenda('?status=REJECTED&limit=100');
    check(CAT, 'GET /api/restructures: data + pagination, กรองด้วย loanId และ status', {
      input: 'GET /api/restructures?limit=100 / ?loanId=..&limit=100 / ?status=REJECTED&limit=100',
      expected: 'pagination {page,limit,total}, ทุกแถวของ loanId ตรงกัน, status filter เหลือแต่ REJECTED',
      actual: `all=${listAll.json?.data?.length}, total=${listAll.json?.pagination?.total}, mine=${listMine.json?.data?.length} [${new Set((listMine.json?.data ?? []).map((r) => r.loanId)).size} loanId], rejected=${listRejected.json?.data?.length} [${[...new Set((listRejected.json?.data ?? []).map((r) => r.status))].join(',')}]`,
      pass:
        !!listAll.json?.pagination &&
        listAll.json.pagination.limit === 100 &&
        (listMine.json?.data ?? []).length >= 1 &&
        (listMine.json?.data ?? []).every((r) => r.loanId === L2.id) &&
        (listRejected.json?.data ?? []).length >= 1 &&
        (listRejected.json?.data ?? []).every((r) => r.status === 'REJECTED'),
    });
    const listUncapped = await listAddenda('?limit=500');
    check(CAT, 'limit เกิน 100 ถูกปัดลง 100 (กันหน้าจอลากทั้งฐานข้อมูล)', {
      input: 'GET /api/restructures?limit=500',
      expected: 'pagination.limit 100',
      actual: `limit=${listUncapped.json?.pagination?.limit}`,
      pass: listUncapped.json?.pagination?.limit === 100,
    });

    // ============================================================ F. apply + relief ผ่าน ledger
    statusCheck(CAT, 'apply ใบที่ถูกปฏิเสธ: 422 (มีเฉพาะใบ APPROVED ที่บังคับใช้ได้)', await applyAddendum(rejectedRow0.id), 422, {
      messageIncludes: 'only an approved one can be applied',
    });
    statusCheck(CAT, 'VIEWER บังคับใช้ใบไม่ได้: 403', await applyAddendum(smallId, tokens.viewer), 403, { messageIncludes: 'Requires role' });
    const applyAsMaker = await applyAddendum(smallId, tokens.op1);
    statusCheck(CAT, 'MAKER (คนที่ไม่มีส่วนอนุมัติใบนี้) บังคับใช้ได้ — แยก "ผู้ตัดสิน" กับ "ผู้แก้ทะเบียน" ออกจากกัน', applyAsMaker, 200);
    const appliedSmall = applyAsMaker.json?.data ?? {};
    check(CAT, 'apply ใบลดดอกเบี้ยอย่างเดียว: เงื่อนไขใหม่มีผล, สถานะ APPLIED, ไม่มี waiver (ใบนี้ออกแบบไว้แบบนั้น)', {
      input: `POST /api/restructures/${smallRow.requestNo}/apply`,
      expected: `loan rate ${validRate}, term ${L2.termMonths}, status APPLIED, waiver null, outstanding ยัง ${fmt(sumCents(L2.billed))}`,
      actual: `rate=${appliedSmall?.loan?.interestRate}, term=${appliedSmall?.loan?.termMonths}, status=${appliedSmall?.request?.status}, waiver=${appliedSmall?.waiver ? 'present' : 'null'}, outstanding=${fmt(cent(appliedSmall?.loan?.outstanding))}, appliedBy=${appliedSmall?.request?.appliedBy ? 'set' : 'null'}`,
      pass:
        appliedSmall?.loan?.interestRate === validRate &&
        appliedSmall?.loan?.termMonths === L2.termMonths &&
        appliedSmall?.request?.status === 'APPLIED' &&
        appliedSmall?.waiver === null &&
        cent(appliedSmall?.loan?.outstanding) === sumCents(L2.billed) &&
        !!appliedSmall?.request?.appliedAt,
    });
    statusCheck(CAT, 'apply ซ้ำ: 409 (บังคับใช้ได้ครั้งเดียวต่อใบ)', await applyAddendum(smallId), 409, { messageIncludes: 'already been applied' });

    // คำขอหลัก: ลดดอก + ขยายเวลา + เปลี่ยนผู้ชำระ + relieve ดอก ในใบเดียว
    const reliefAmount = toLak(Math.floor(L1.billed.PAST_INTEREST / 3));
    const combined = await createAddendum({
      loanId: L1.id,
      hardshipReason: 'Borrower defaulted after the main client terminated the contract; the guarantor takes over payments',
      changeTypes: ['INTEREST_RATE_REDUCTION', 'TERM_EXTENSION', 'PAYER_CHANGE', 'INTEREST_RELIEF'],
      newInterestRate: validRate,
      newTermMonths: L1.termMonths + 6,
      newPayerCustomerId: guarantor.id,
      interestReliefAmount: reliefAmount,
    });
    statusCheck(CAT, 'ร่างใบเดียวที่ขอทั้ง 4 อย่าง (ลดดอก/ขยายเวลา/เปลี่ยนผู้ชำระ/relieve ดอก): 201', combined, 201);
    const combinedRow = combined.json?.data ?? {};
    const combinedId = combinedRow.id;
    check(CAT, 'after terms สะท้อนทั้ง 4 คำขอ และ relief ผูกกับดอกเบี้ยที่ยังค้างเท่านั้น', {
      input: `POST /api/restructures บน ${L1.loanNumber}`,
      expected: `rate ${L1.rate}->${validRate}, term ${L1.termMonths}->${L1.termMonths + 6}, payer ${payer.id}->${guarantor.id}, relief ${fmt(cent(reliefAmount))} <= ดอกค้าง ${fmt(L1.billed.PAST_INTEREST)}`,
      actual: `rate=${combinedRow.beforeTerms?.interestRate}->${combinedRow.afterTerms?.interestRate}, term=${combinedRow.beforeTerms?.termMonths}->${combinedRow.afterTerms?.termMonths}, payer=${combinedRow.beforeTerms?.payerCustomerId}->${combinedRow.afterTerms?.payerCustomerId}, relief=${fmt(cent(combinedRow.interestReliefAmount))}, snapshot=${combinedRow.collateralSnapshot?.passed}`,
      pass:
        combinedRow.beforeTerms?.interestRate === L1.rate &&
        combinedRow.afterTerms?.interestRate === validRate &&
        combinedRow.afterTerms?.termMonths === L1.termMonths + 6 &&
        combinedRow.beforeTerms?.payerCustomerId === payer.id &&
        combinedRow.afterTerms?.payerCustomerId === guarantor.id &&
        cent(combinedRow.interestReliefAmount) === cent(reliefAmount) &&
        combinedRow.collateralSnapshot?.passed === true,
    });

    const combinedLevels = await approveThrough(combinedId);
    const expectedCombinedLevels = widen(levelsFromAmount(num(combinedRow.repricingAmount), TH), RESTRUCTURE_FLOOR);
    check(CAT, 'ใบหลักผ่านชั้นตาม floor + threshold ของยอดที่ถูก re-price (ไม่มีชั้นไหนถูกข้าม)', {
      input: `เดินคิว + อนุมัติสำหรับใบ ${combinedRow.requestNo}`,
      expected: `levels ${expectedCombinedLevels.join(',')} (ผู้ร่าง test_op1 ไม่ได้ตัดสิน)`,
      actual: `${combinedLevels.join(',')} approved`,
      pass: combinedLevels.join(',') === expectedCombinedLevels.join(','),
    });
    const combinedApproved = await addendumOf(combinedId);
    check(CAT, 'ก่อน apply: ใบ APPROVED แล้วแต่สัญญายังเป็นของเดิมทุกตัว (อนุมัติ ≠ แก้ทะเบียน)', {
      input: `GET /api/restructures/${combinedRow.requestNo}`,
      expected: `rate ${L1.rate}, term ${L1.termMonths}, waiver null`,
      actual: `status=${combinedApproved?.request?.status}, rate=${combinedApproved?.loan?.interestRate}, term=${combinedApproved?.loan?.termMonths}, waiver=${combinedApproved?.waiver ? 'present' : 'null'}`,
      pass:
        combinedApproved?.request?.status === 'APPROVED' &&
        combinedApproved?.loan?.interestRate === L1.rate &&
        combinedApproved?.loan?.termMonths === L1.termMonths &&
        combinedApproved?.waiver === null,
    });

    const mainScheduleBefore = await scheduleView(L1.id, TODAY);
    const mainOutstandingBefore = outstandingOf(await loanView(L1.id));
    const applyCombined = await applyAddendum(combinedId, tokens.op2);
    statusCheck(CAT, 'บังคับใช้ใบหลัก (operator อีกคนเป็นคนแก้ทะเบียน): 200', applyCombined, 200);
    const appliedMain = applyCombined.json?.data ?? {};
    check(CAT, 'apply แล้ว: อัตรา/term ใหม่มีผลจริง แต่ยอดคงเหลือยังไม่ขยับเพราะ relief ยังเป็นแค่ draft', {
      input: `POST /api/restructures/${combinedRow.requestNo}/apply โดย test_op2`,
      expected: `rate ${validRate}, term ${L1.termMonths + 6}, outstanding ยัง ${fmt(sumCents(mainOutstandingBefore))}, waiver WAIVER/PENDING_APPROVAL ${fmt(cent(reliefAmount))}`,
      actual: `rate=${appliedMain?.loan?.interestRate}, term=${appliedMain?.loan?.termMonths}, outstanding=${fmt(cent(appliedMain?.loan?.outstanding))}, waiver=${appliedMain?.waiver?.transactionType}:${appliedMain?.waiver?.status}:${fmt(cent(appliedMain?.waiver?.amount))}`,
      pass:
        appliedMain?.loan?.interestRate === validRate &&
        appliedMain?.loan?.termMonths === L1.termMonths + 6 &&
        cent(appliedMain?.loan?.outstanding) === sumCents(mainOutstandingBefore) &&
        appliedMain?.waiver?.transactionType === 'WAIVER' &&
        appliedMain?.waiver?.status === 'PENDING_APPROVAL' &&
        cent(appliedMain?.waiver?.amount) === cent(reliefAmount),
    });

    const mainScheduleAfter = await scheduleView(L1.id, TODAY);
    check(CAT, 'term ใหม่สะท้อนในตารางงวดทันที: จำนวนงวดเพิ่มจาก 12 เป็น 18', {
      input: `GET /api/loans/${L1.loanNumber}/schedule ก่อน/หลัง apply`,
      expected: `periods ${L1.termMonths} -> ${L1.termMonths + 6}`,
      actual: `${mainScheduleBefore?.periods?.length} -> ${mainScheduleAfter?.periods?.length} (periodCount ${mainScheduleAfter?.periodCount})`,
      pass:
        mainScheduleBefore?.periods?.length === L1.termMonths &&
        mainScheduleAfter?.periods?.length === L1.termMonths + 6 &&
        mainScheduleAfter?.termMonths === L1.termMonths + 6,
    });

    const mainParties = appliedMain?.parties ?? [];
    check(CAT, 'เปลี่ยนผู้ชำระแทนตอน apply: คนเก่า RELEASED, คนใหม่ ACTIVE เป็น PAYER (ผู้ค้ำยังค้ำอยู่)', {
      input: 'parties ใน response หลัง apply',
      expected: 'PAYER:ACTIVE 1, PAYER:RELEASED 1, GUARANTOR:ACTIVE 1',
      actual: mainParties.map((p) => `${p.role}:${p.status}`).join(', '),
      pass:
        mainParties.filter((p) => p.role === 'PAYER' && p.status === 'ACTIVE').length === 1 &&
        mainParties.filter((p) => p.role === 'PAYER' && p.status === 'RELEASED').length === 1 &&
        mainParties.some((p) => p.role === 'GUARANTOR' && p.status === 'ACTIVE'),
    });
    const swapRows = await rows(conn, "SELECT status, releaseReason FROM loan_parties WHERE loanId = ? AND role = 'PAYER'", [L1.id]);
    check(CAT, 'เหตุผลของผู้ชำระคนเก่าอ้างเลขใบ (Replaced as payer by addendum RS-......)', {
      input: 'loan_parties role PAYER ของ L1',
      expected: `RELEASED ที่ releaseReason = "Replaced as payer by addendum ${combinedRow.requestNo}"`,
      actual: swapRows.map((r) => `${r.status}:${r.releaseReason}`).join(' | '),
      pass: swapRows.some(
        (r) => r.status === 'RELEASED' && String(r.releaseReason).includes(`Replaced as payer by addendum ${combinedRow.requestNo}`),
      ),
    });

    const waiverId = appliedMain?.waiver?.id;
    statusCheck(CAT, 'waiver ที่ยังไม่มีใครอนุมัติโพสต์ไม่ได้: 422 (relief ต้องเดินผ่าน engine เหมือนทุกตัว)', await api('POST', `/api/transactions/${waiverId}/post`, { token: tokens.admin }), 422, {
      messageIncludes: 'Only APPROVED transactions can be posted',
    });
    const waiverItem = await queueItemFor(waiverId, tokens.checker2);
    check(CAT, 'relief ที่ apply สร้างเป็น "งานอนุมัติชิ้นใหม่" ตามยอด relief (ไม่ใช่ floor ของใบปรับโครงสร้าง)', {
      input: 'GET /approvals/pending ของ waiver ที่เพิ่ง draft',
      expected: `subjectType FINANCIAL_TRANSACTION, currentLevel CHECKER, amount ${fmt(cent(reliefAmount))}`,
      actual: `subjectType=${waiverItem?.subjectType}, level=${waiverItem?.currentLevel}, amount=${fmt(cent(waiverItem?.amount))}, remaining=${waiverItem?.remainingLevels?.join(',')}`,
      pass:
        waiverItem?.subjectType === 'FINANCIAL_TRANSACTION' &&
        cent(waiverItem?.amount) === cent(reliefAmount) &&
        (waiverItem?.remainingLevels ?? []).join(',') === levelsFromAmount(num(waiverItem?.amount), TH).join(','),
      note: 'waiver ของ relief ใช้ชั้นตามยอดของมันเอง (floor ผูกกับใบ addendum เท่านั้น) — ถ้ายอดเล็กก็ชั้นเดียว',
    });
    statusCheck(CAT, 'CHECKER อนุมัติ waiver ของ relief: 200', await decideCall(waiverItem.stepId, { decision: 'APPROVE', reason: 'relief granted under the addendum' }, tokens.checker2), 200);
    statusCheck(CAT, 'โพสต์ waiver ผ่าน engine ปกติ: 200 — ตรงนี้เท่านั้นที่หนี้ดอกเบี้ยลดลง', await api('POST', `/api/transactions/${waiverId}/post`, { token: tokens.admin }), 200);

    const afterRelief = outstandingOf(await loanView(L1.id));
    const expectedAfter = {
      PENALTY: L1.billed.PENALTY,
      PAST_INTEREST: L1.billed.PAST_INTEREST - cent(reliefAmount),
      PAST_PRINCIPAL: L1.billed.PAST_PRINCIPAL,
    };
    check(CAT, 'ledger ปิดตาม: ดอกคงเหลือ = บิลทั้งก้อน - relief, เงินต้นไม่ถูกแตะ', {
      input: `GET /api/loans/${L1.loanNumber} หลังโพสต์ waiver ${fmt(cent(reliefAmount))}`,
      expected: `${asText(expectedAfter)} (รวม ${fmt(sumCents(expectedAfter))})`,
      actual: `${asText(afterRelief)} (รวม ${fmt(sumCents(afterRelief))})`,
      pass: COMPS.every((c) => afterRelief[c] === expectedAfter[c]),
    });
    const waiverLines = await rows(conn, 'SELECT component, CAST(amount AS CHAR) amount FROM financial_transaction_lines WHERE transactionId = ? ORDER BY component', [waiverId]);
    check(CAT, 'เส้น ledger ของ waiver มีเฉพาะ PAST_INTEREST และจำนวนตรงกับ relief (รายงานอ่านเครื่องหมายตามนี้)', {
      input: 'financial_transaction_lines ของรายการ waiver',
      expected: `1 เส้น PAST_INTEREST, |amount| = ${fmt(cent(reliefAmount))}`,
      actual: waiverLines.map((l) => `${l.component}=${l.amount}`).join(', '),
      pass:
        waiverLines.length === 1 &&
        waiverLines[0].component === 'PAST_INTEREST' &&
        Math.abs(cent(waiverLines[0].amount)) === cent(reliefAmount),
    });

    const reliefSchedule = await scheduleView(L1.id, TODAY);
    check(CAT, 'ตารางงวดแสดง relief เป็น "relieved" ไม่ใช่ "paid" (เงินไม่ได้เข้า — รายงานต้องแยกออก)', {
      input: 'GET /schedule totals.relieved / totals.paid',
      expected: `relieved.PAST_INTEREST ${fmt(cent(reliefAmount))}, paid ทุกตัว 0.00`,
      actual: `relieved=${fmt(cent(reliefSchedule?.totals?.relieved?.PAST_INTEREST))}, paid=${fmt(cent(reliefSchedule?.totals?.paid?.PAST_INTEREST))}/${fmt(cent(reliefSchedule?.totals?.paid?.PAST_PRINCIPAL))}`,
      pass:
        cent(reliefSchedule?.totals?.relieved?.PAST_INTEREST) === cent(reliefAmount) &&
        cent(reliefSchedule?.totals?.paid?.PAST_INTEREST ?? 0) === 0 &&
        cent(reliefSchedule?.totals?.paid?.PAST_PRINCIPAL ?? 0) === 0,
    });

    const mailTypes = ['RESTRUCTURE_REQUESTED', 'RESTRUCTURE_DECIDED', 'RESTRUCTURE_APPLIED', 'PARTY_RELEASED', 'PARTY_REGISTERED'];
    for (const type of mailTypes) {
      const got = await outboxRows(L1.id, type);
      check(CAT, `แจ้งเตือนประเภท ${type} ถึงทุกฝ่ายที่เกี่ยวข้อง (ผู้กู้ ผู้ค้ำ ผู้ชำระแทน ทีมอนุมัติ)`, {
        input: `notification_outbox WHERE loanId=${L1.loanNumber} AND type=${type}`,
        expected: '>= 1 แถว และครอบคลุมที่อยู่ที่เกี่ยวข้อง',
        actual: `${got.length} แถว [${[...new Set(got.map((r) => r.recipientEmail))].join(', ')}]`,
        pass: got.length > 0,
      });
    }
    const releasedMail = await outboxRowsForParty(L1.id, 'PARTY_RELEASED', payer.fullName);
    check(CAT, 'คนที่เพิ่งถูกเปลี่ยนออกจากการเป็นผู้ชำระยังได้เมลของตัวเอง (ทั้งที่แถวกลายเป็น RELEASED แล้ว)', {
      input: 'PARTY_RELEASED ของผู้ชำระคนเดิม',
      expected: `มีแถวถึง ${payer.email}`,
      actual: releasedMail.map((r) => r.recipientEmail).join(', '),
      pass: releasedMail.length > 0 && releasedMail.every((r) => !!r.recipientEmail),
    });

    // ---- ความคุ้มครองต้องยังยืนอยู่ ณ วันบังคับใช้ ไม่ใช่แค่วันที่ยื่น
    const securedAddendum = await createAddendum({
      loanId: L4.id,
      hardshipReason: 'Work stopped for two months, asking for a lower rate',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: validRate,
    });
    statusCheck(CAT, 'ร่างใบของกู้ที่มีหลักประกันครบ: 201', securedAddendum, 201);
    const securedRow = securedAddendum.json?.data ?? {};
    await approveThrough(securedRow.id);
    const livePledges = (await collateralOf(L4.id)).collaterals.filter((c) => c.status === 'PLEDGED');
    const largest = livePledges.reduce((a, b) => (num(b.appraisedValue) > num(a.appraisedValue) ? b : a), livePledges[0]);
    statusCheck(CAT, 'ก่อน apply ถอนหลักประกันรายการใหญ่ออก: 200 (การถอนเป็นอำนาจหัวหน้า)', await releasePledgeCall(L4.id, largest.id, 'valuation withdrawn before the addendum was applied', tokens.head), 200);
    statusCheck(CAT, 'apply ใบที่ประกันไม่ครบแล้ว: 422 — ตรวจความคุ้มทุนใหม่ ณ วันบังคับใช้ ไม่ได้ใช้ตัวเลขที่ snapshot ไว้', await applyAddendum(securedRow.id), 422, {
      messageIncludes: 'Collateral check failed',
    });
    const snapshotKept = await addendumOf(securedRow.id);
    const coverageNow = await coverageOf(L4.id);
    check(CAT, 'หลักฐานวันยื่นยังเก็บอยู่ครบ: collateralSnapshot ของใบนี้ต่างจาก coverage ปัจจุบัน', {
      input: `GET /api/restructures/${securedRow.requestNo}`,
      expected: 'snapshot.passed true, coverage ปัจจุบัน passed false',
      actual: `snapshot=${JSON.stringify({ passed: snapshotKept?.request?.collateralSnapshot?.passed, total: snapshotKept?.request?.collateralSnapshot?.appraisedTotal, percent: snapshotKept?.request?.collateralSnapshot?.coveragePercent })}, now=${JSON.stringify({ passed: coverageNow?.coverage?.passed, percent: coverageNow?.coverage?.coveragePercent })}, status=${snapshotKept?.request?.status}`,
      pass:
        snapshotKept?.request?.collateralSnapshot?.passed === true &&
        coverageNow?.coverage?.passed === false &&
        snapshotKept?.request?.status === 'APPROVED',
      note: 'ใบไม่ถูกเผา: apply ที่ล้มเหลวยัง APPROVED และยังไม่ APPLIED จึงบังคับใช้ได้ใหม่เมื่อประกันกลับมาครบ',
    });
    await pledgeCall(L4.id, { type: 'DEPOSIT', description: `Replacement deposit ${L4.loanNumber}`, appraisedValue: toLak(billedL4), valuedAt: TODAY });
    statusCheck(CAT, 'จดหลักประกันตัวแทนจนครบแล้ว apply ผ่าน: 200 (ยืนยันว่า 422 ก่อนหน้าเป็นเรื่องความคุ้มทุนปัจจุบัน)', await applyAddendum(securedRow.id), 200);

    // ---- สองใบอนุมัติพร้อมกันบนสัญญาเดียว: ใบที่ค้างอยู่ต้องไม่ถูกนำมาใช้ทับ
    const driftA = await createAddendum({
      loanId: L4.id,
      hardshipReason: 'First of two approved addenda on one contract',
      changeTypes: ['INTEREST_RATE_REDUCTION'],
      newInterestRate: Number((P12.interestRate / 3).toFixed(6)),
    });
    const driftB = await createAddendum({
      loanId: L4.id,
      hardshipReason: 'Second of two approved addenda on one contract',
      changeTypes: ['TERM_EXTENSION'],
      newTermMonths: L4.termMonths + 6,
    });
    const driftARow = driftA.json?.data ?? {};
    const driftBRow = driftB.json?.data ?? {};
    await approveThrough(driftARow.id);
    await approveThrough(driftBRow.id);
    statusCheck(CAT, 'มีสองใบอนุมัติพร้อมกัน: บังคับใช้ใบหลังก่อนได้ 200 (term เปลี่ยนจริง)', await applyAddendum(driftBRow.id), 200);
    statusCheck(CAT, 'แล้วใบแรกกลายเป็นคนละสัญญากับที่อนุมัติ: 422 ต้องร่างใหม่ ห้าม apply ทับ', await applyAddendum(driftARow.id), 422, {
      messageIncludes: 'no longer carries the terms this addendum was approved against',
    });

    // ---- relief ซ้ำบนดอกเบี้ยก้อนเดียวกันไม่ได้
    const reliefOne = await createAddendum({
      loanId: L2.id,
      hardshipReason: 'Relieve the whole outstanding interest once',
      changeTypes: ['INTEREST_RELIEF'],
      interestReliefAmount: toLak(L2.billed.PAST_INTEREST),
    });
    statusCheck(CAT, 'ขอ relief ดอกเบี้ยทั้งก้อนที่ยังค้าง (ไม่เกินที่ค้าง): 201', reliefOne, 201);
    const reliefOneRow = reliefOne.json?.data ?? {};
    const reliefTwo = await createAddendum({
      loanId: L2.id,
      hardshipReason: 'A second paper asking for the same interest again',
      changeTypes: ['INTEREST_RELIEF'],
      interestReliefAmount: toLak(L2.billed.PAST_INTEREST),
    });
    statusCheck(CAT, 'ใบที่สองขอ relief ดอกก้อนเดียวกัน (ตอนนั้นยังค้างอยู่ครบ): 201 — ระบบไม่ได้ lock ล่วงหน้า', reliefTwo, 201);
    const reliefTwoRow = reliefTwo.json?.data ?? {};
    await approveThrough(reliefOneRow.id);
    await approveThrough(reliefTwoRow.id);
    const reliefOneApplied = await applyAddendum(reliefOneRow.id);
    statusCheck(CAT, 'apply ใบแรก: 200 + draft waiver เท่าดอกเบี้ยทั้งก้อน', reliefOneApplied, 200);
    const reliefOneWaiver = reliefOneApplied.json?.data?.waiver?.id;
    await approveThrough(reliefOneWaiver);
    statusCheck(CAT, 'โพสต์ waiver ตัวแรก: 200 → ดอกเบี้ยค้างเหลือ 0', await api('POST', `/api/transactions/${reliefOneWaiver}/post`, { token: tokens.admin }), 200);
    const zeroInterest = outstandingOf(await loanView(L2.id));
    statusCheck(CAT, 'apply ใบที่สอง (ดอกที่อ้างถูก relieve ไปแล้ว): 422 และบอกตรง ๆ ว่ายอดคงเหลือไม่พอ', await applyAddendum(reliefTwoRow.id), 422, {
      messageIncludes: 'cannot cancel more interest than is still owed',
    });
    check(CAT, 'ยืนยันว่าดอกเบี้ยของกู้ก้อนนั้นเป็น 0 จริงและเงินต้นยังอยู่ครบ (relief ไม่กินเงินต้น)', {
      input: `GET /api/loans/${L2.loanNumber}`,
      expected: `PAST_INTEREST 0.00, PAST_PRINCIPAL ${fmt(L2.billed.PAST_PRINCIPAL)}`,
      actual: asText(zeroInterest),
      pass: zeroInterest.PAST_INTEREST === 0 && zeroInterest.PAST_PRINCIPAL === L2.billed.PAST_PRINCIPAL,
    });
    const failedApplyState = await addendumOf(reliefTwoRow.id);
    check(CAT, 'ใบที่ apply ไม่สำเร็จยังค้างที่ APPROVED (ไม่ถูกเผา) และไม่มี waiver ใหม่โผล่มา', {
      input: `GET /api/restructures/${reliefTwoRow.requestNo}`,
      expected: 'status APPROVED, waiver null',
      actual: `status=${failedApplyState?.request?.status}, waiver=${failedApplyState?.waiver ? 'present' : 'null'}`,
      pass: failedApplyState?.request?.status === 'APPROVED' && failedApplyState?.waiver === null,
    });

    // ============================================================ G. audit trail + สิทธิ์คิว
    const auditActions = await rows(conn, 'SELECT action, COUNT(*) n FROM audit_logs WHERE loanId IN (?) GROUP BY action', [created.loans]);
    const actionMap = Object.fromEntries(auditActions.map((r) => [r.action, Number(r.n)]));
    const wantedActions = [
      'LOAN_PARTY_REGISTERED',
      'LOAN_PARTY_REENGAGED',
      'LOAN_PARTY_RELEASED',
      'LOAN_COLLATERAL_PLEDGED',
      'LOAN_COLLATERAL_RELEASED',
      'RESTRUCTURE_REQUESTED',
      'RESTRUCTURE_REQUEST_APPROVED',
      'RESTRUCTURE_APPLIED',
      'TRANSACTION_CREATED',
      'TRANSACTION_POSTED',
    ];
    check(CAT, 'audit ครอบคลุมทุกการเปลี่ยนแปลงของหมวดนี้ (ตั้ง/ตั้งใหม่/ปลด party, จด/ปลดทรัพย์, ขอ/อนุมัติ/บังคับใช้, draft/โพสต์ waiver)', {
      input: 'audit_logs action counts ของเงินกู้ที่ suite นี้สร้าง',
      expected: `มีครบ ${wantedActions.length} action: ${wantedActions.join(', ')}`,
      actual: JSON.stringify(actionMap),
      pass: wantedActions.every((a) => (actionMap[a] ?? 0) > 0),
    });
    const applyAudit = (await rows(conn, "SELECT reason FROM audit_logs WHERE loanId = ? AND action = 'RESTRUCTURE_APPLIED' LIMIT 1", [L1.id]))[0]?.reason ?? '';
    check(CAT, 'audit ของ apply บรรยาย "จากเงื่อนไขไหนไปเงื่อนไขไหน" + ยอด relief ที่ draft ไว้', {
      input: 'audit_logs reason ของ RESTRUCTURE_APPLIED บน L1',
      expected: `อ้าง rate ${L1.rate} -> ${validRate}, term ${L1.termMonths} -> ${L1.termMonths + 6}, relief ${reliefAmount} (ตัวเลขตามที่ JS แสดง ไม่ใช่ทศนิยม 2 ตำแหน่ง)`,
      actual: applyAudit,
      pass:
        applyAudit.includes(`${L1.rate} -> ${validRate}`) &&
        applyAudit.includes(`${L1.termMonths} -> ${L1.termMonths + 6}`) &&
        applyAudit.includes(String(reliefAmount)) &&
        /waiver/i.test(applyAudit),
    });
    statusCheck(CAT, 'MAKER เข้าคิวรออนุมัติไม่ได้: 403 (คิวมีไว้สำหรับผู้มีอำนาจ)', await api('GET', '/api/approvals/pending?limit=100', { token: tokens.op1 }), 403, {
      messageIncludes: 'Requires role',
    });

    // ============================================================ H. ข้อสังเกต: การขยายเวลา re-spread งวดเก่า
    const overdueLoan = await newLoan({ customer: borrower1, principal: principalBelow(TH.checkerThreshold * 0.6), disbursedAt: daysAgo(200), label: 'HARDSHIP-SPREAD' });
    await ensureCoverage(overdueLoan, 'EQUIPMENT');
    const spreadBefore = await scheduleView(overdueLoan.id, TODAY);
    const chargedBefore = (spreadBefore?.periods ?? [])
      .filter((p) => p.index <= 3)
      .reduce((acc, p) => acc + cent(p.principalDue) + cent(p.interestDue), 0);
    const spreadAddendum = await createAddendum({
      loanId: overdueLoan.id,
      hardshipReason: 'Business stalled; asking to stretch the remaining repayments',
      changeTypes: ['TERM_EXTENSION'],
      newTermMonths: overdueLoan.termMonths + 6,
    });
    statusCheck(CAT, 'ร่างใบขยายเวลาของกู้ที่งวดผ่านไปแล้วหลายงวด (ดอกเบี้ยทั้งก้อน bill ตอนปล่อย): 201', spreadAddendum, 201);
    const spreadRow = spreadAddendum.json?.data ?? {};
    await approveThrough(spreadRow.id);
    statusCheck(CAT, 'apply ใบขยายเวลา: 200', await applyAddendum(spreadRow.id), 200);
    const spreadAfter = await scheduleView(overdueLoan.id, TODAY);
    const chargedAfter = (spreadAfter?.periods ?? [])
      .filter((p) => p.index <= 3)
      .reduce((acc, p) => acc + cent(p.principalDue) + cent(p.interestDue), 0);
    const totalAfter = (spreadAfter?.periods ?? []).reduce((acc, p) => acc + cent(p.principalDue) + cent(p.interestDue), 0);
    check(CAT, 'เงินทั้งก้อนไม่หาย: Σค่างวดหลังขยาย = หนี้ที่ bill ไว้ใน ledger เท่าเดิม (จำนวนงวดเพิ่ม)', {
      input: 'Σ periods(principalDue + interestDue) ก่อน/หลังขยายเวลา',
      expected: fmt(sumCents(overdueLoan.billed)),
      actual: `${fmt(totalAfter)} จาก ${spreadAfter?.periods?.length} งวด (เดิม ${spreadBefore?.periods?.length})`,
      pass: totalAfter === sumCents(overdueLoan.billed),
    });
    const spreadOutstandingNow = sumCents(outstandingOf(await loanView(overdueLoan.id)));
    check(CAT, 'F-HSR-1: งวดที่ "ถึงกำหนดไปแล้ว" ต้องเก็บจำนวนเงินเท่าเดิม — การขยายเวลาต้องไม่ re-price ย้อนหลัง', {
      input: 'Σ charge ของงวด 1-3 ก่อน/หลังขยายเวลา (ledger ไม่เปลี่ยน)',
      expected: `${fmt(chargedBefore)} (งวดที่ผ่านไปแล้วต้องไม่ถูกลดเพื่อทำยอดใหม่)`,
      actual: `หลังขยายเหลือ ${fmt(chargedAfter)} (ต่างไป ${fmt(chargedBefore - chargedAfter)}), ledger ยังมียอดคงเหลือเท่าเดิม ${fmt(spreadOutstandingNow)}`,
      pass: chargedAfter === chargedBefore,
      note:
        'ตารางงวด derive จาก disbursedAt + termMonths ตามที่ล็อกไว้ การขยาย term จึงเฉลี่ยค่างวดทั้งเล่มใหม่ ทำให้ยอด "ถึงกำหนด" ' +
        'ของงวดที่ค้างอยู่แล้วต่ำลง และฐานที่คิดค่าปรับก็ต่ำตาม — ยอดใน ledger และรายงาน monthly ยังตรงกัน (ดูเคสข้างบน) ' +
        'แต่เจ้าของระบบต้องตัดสินใจว่าจะ freeze งวดที่ผ่านไปแล้วหรือไม่ จึงรายงานไว้ ไม่ได้แก้สูตร',
    });

    // ============================================================ I. คืนของ + ตรวจความสะอาด
    await collateralPins.restore();
    await settle(400);
    await purge();

    const counts = {};
    for (const t of TABLES) counts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`, []))[0].n);
    const dirty = TABLES.filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: แถวทุกตารางที่ suite นี้แตะกลับเท่าก่อนเริ่ม (ลูกค้า/เงินกู้/party/ทรัพย์/ใบปรับ/ledger/audit/outbox)', {
      input: 'row counts ก่อน vs หลัง',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      pass: dirty.length === 0,
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.map((t) => `${t} ${baseline[t]}->${counts[t]}`).join(', ')}` : '',
    });

    const policyAfterRun = (await api('GET', '/api/config/collateral')).json?.data?.policy;
    check(CAT, 'คืน policy หลักประกันเป็นค่าที่พบก่อนเริ่มรัน (ไม่ทิ้งเพดานที่เคสทดลองตั้งไว้)', {
      input: 'GET /api/config/collateral หลัง restore',
      expected: JSON.stringify(baselinePolicy),
      actual: JSON.stringify(policyAfterRun),
      pass: JSON.stringify(policyAfterRun) === JSON.stringify(baselinePolicy),
    });

    const leftovers = {
      customers: await rows(conn, 'SELECT COUNT(*) n FROM customers WHERE fullName LIKE ?', [`${HS}%`]).then((r) => Number(r[0].n)),
      loans: await rows(conn, 'SELECT COUNT(*) n FROM loans WHERE note LIKE ?', [`${HS}%`]).then((r) => Number(r[0].n)),
      parties: await rows(conn, 'SELECT COUNT(*) n FROM loan_parties', []).then((r) => Number(r[0].n)),
      pledges: await rows(conn, 'SELECT COUNT(*) n FROM loan_collaterals', []).then((r) => Number(r[0].n)),
      restructures: await rows(conn, 'SELECT COUNT(*) n FROM restructure_requests', []).then((r) => Number(r[0].n)),
      restructureWorkflows: await rows(conn, "SELECT COUNT(*) n FROM approval_workflows WHERE subjectType = 'RESTRUCTURE_REQUEST'", []).then((r) => Number(r[0].n)),
    };
    check(CAT, 'ไม่มีแถวของ suite ค้างในตารางใหม่ทั้งสาม (loan_parties/loan_collaterals/restructure_requests) และ workflow ของ restructure ก็ว่าง', {
      input: 'leftover counts',
      expected: 'customers 0, loans 0, parties 0, pledges 0, restructures 0, restructure workflows 0',
      actual: JSON.stringify(leftovers),
      pass: Object.values(leftovers).every((n) => n === 0),
    });
    const seededActive = Number((await rows(conn, "SELECT COUNT(*) n FROM loans WHERE status = 'ACTIVE'", []))[0].n);
    check(CAT, 'เล่ม seed ยังอยู่ครบ (suite นี้ไม่ได้กินเงินกู้ของข้อมูลจำลอง)', {
      input: 'COUNT loans WHERE status = ACTIVE หลัง purge',
      expected: '> 0 (เงินกู้ seed ยังอยู่ครบทุกฉบับ)',
      actual: `${seededActive} ฉบับ`,
      pass: seededActive > 0,
    });
  } finally {
    await collateralPins.restore().catch(() => {});
    await purge().catch(() => {});
  }
}
