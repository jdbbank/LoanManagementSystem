// Deterministic dataset builder for the pre-production test run.
// Pure JS: it returns rows + the independently computed expectations and never touches the
// database or server/src, so the same output can be replayed against a fresh DB.
import { createHash } from 'node:crypto';
import {
  COMPONENTS,
  accruedPenaltyCents,
  addDays,
  allocateComponents,
  billedInterestCents,
  buildSchedule,
  emptyComponents,
  fmt,
  growth,
  monthKeys,
  newLoanState,
  periodCount,
  postEvent,
  reverseAllocation,
  toCents,
  toLak,
  totalOf,
} from './oracle.mjs';

const PAD = (n, w = 6) => String(n).padStart(w, '0');

/** Stored ComponentAmounts are LAK numbers, so internal cents must be converted on the way out. */
const centsToLakObject = (obj) => (obj ? Object.fromEntries(COMPONENTS.map((c) => [c, toLak(obj[c] ?? 0)])) : null);

/** Signed ledger lines: a payment reduces outstanding, so its lines are negative (reports read the sign). */
const negCents = (obj) => Object.fromEntries(COMPONENTS.map((c) => [c, -(obj?.[c] ?? 0)]));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), 61 | t))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Bytes that pass a JPEG magic-byte sniff without shipping a real photo into the repo. */
function jpegBytes(rng, sizeKb) {
  const body = Buffer.alloc(Math.max(1, sizeKb) * 1024);
  for (let i = 0; i < body.length; i++) body[i] = Math.floor(rng() * 256);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF', 'ascii'), body, Buffer.from([0xff, 0xd9])]);
}

function pngBytes(rng, sizeKb) {
  const body = Buffer.alloc(Math.max(1, sizeKb) * 1024);
  for (let i = 0; i < body.length; i++) body[i] = Math.floor(rng() * 256);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body, Buffer.from([0x00, 0x00])]);
}

const TEST_PASSWORD = 'Tst@2026#a';
const REFERENCE_NOW = '2026-10-13T09:30:00.000Z';
const FROM_MONTH = '2025-07';
const TO_MONTH = '2026-10';

export const USERS = [
  { username: 'test_admin', role: 'ADMIN', fullName: 'ທົດສະເລກ Admin', email: 'test_admin@test.local', verified: 1 },
  { username: 'test_head', role: 'HEAD_APPROVER', fullName: 'Head Approver Test Lao', email: 'test_head@test.local', verified: 1 },
  { username: 'test_checker1', role: 'CHECKER', fullName: 'ผู้ทดสอบตรวจสอบ 1', email: 'test_checker1@test.local', verified: 1 },
  { username: 'test_checker2', role: 'CHECKER', fullName: 'Second Checker Test', email: 'test_checker2@test.local', verified: 1 },
  { username: 'test_op1', role: 'MAKER', fullName: 'ນາງ ສອນເພັດ ໄຊຍະພອນ', email: 'test_op1@test.local', verified: 1 },
  { username: 'test_op2', role: 'MAKER', fullName: 'Mr. Somchai Maker Two', email: 'test_op2@test.local', verified: 1 },
  { username: 'test_view1', role: 'VIEWER', fullName: 'View Only Tester', email: 'test_view1@test.local', verified: 1 },
  { username: 'test_disabled', role: 'MAKER', fullName: 'Disabled Maker', email: 'test_disabled@test.local', verified: 1, isActive: 0 },
  { username: 'test_noemail', role: 'CHECKER', fullName: 'No Email Checker', email: null, verified: 0 },
  { username: 'test_unverified', role: 'MAKER', fullName: 'Unverified Maker', email: 'test_unverified@test.local', verified: 0 },
  { username: 'test_deleted', role: 'VIEWER', fullName: 'Soft Deleted Viewer', email: 'test_deleted@test.local', verified: 1, deleted: true },
];

export const PRODUCTS = [
  { code: 'TST-FLAT-M12', name: 'Test Flat 1.5%/mo 12m', interestRate: 1.5, interestRatePeriod: 'MONTH', termValue: 12, termUnit: 'MONTH', penaltyPolicy: { mode: 'PERCENT_OF_OVERDUE', ratePercent: 2, amount: 0, period: 'MONTH', graceDays: 5, maxPercentOfPrincipal: 20 } },
  { code: 'TST-FLAT-M6', name: 'Test Flat 1.8%/mo 6m', interestRate: 1.8, interestRatePeriod: 'MONTH', termValue: 6, termUnit: 'MONTH', penaltyPolicy: { mode: 'PERCENT_OF_OVERDUE', ratePercent: 3, amount: 0, period: 'MONTH', graceDays: 0, maxPercentOfPrincipal: 30 } },
  { code: 'TST-DAY-RATE', name: 'Test 0.05%/day 90d', interestRate: 0.05, interestRatePeriod: 'DAY', termValue: 90, termUnit: 'DAY', penaltyPolicy: { mode: 'FIXED_PER_PERIOD', ratePercent: 0, amount: 5000, period: 'DAY', graceDays: 3, maxPercentOfPrincipal: 10 } },
  { code: 'TST-WEEK-TERM', name: 'Test 0.4%/week 26w', interestRate: 0.4, interestRatePeriod: 'WEEK', termValue: 26, termUnit: 'WEEK', penaltyPolicy: { mode: 'PERCENT_OF_OVERDUE', ratePercent: 1, amount: 0, period: 'WEEK', graceDays: 7, maxPercentOfPrincipal: 0 } },
  { code: 'TST-YEAR-TERM', name: 'Test 18%/yr 2y', interestRate: 18, interestRatePeriod: 'YEAR', termValue: 2, termUnit: 'YEAR', penaltyPolicy: { mode: 'NONE', ratePercent: 0, amount: 0, period: 'MONTH', graceDays: 0, maxPercentOfPrincipal: 0 } },
  { code: 'TST-FIXED-PEN', name: 'Test Flat 1.2%/mo 24m fixed penalty', interestRate: 1.2, interestRatePeriod: 'MONTH', termValue: 24, termUnit: 'MONTH', penaltyPolicy: { mode: 'FIXED_PER_PERIOD', ratePercent: 0, amount: 500000, period: 'MONTH', graceDays: 15, maxPercentOfPrincipal: 25 } },
  { code: 'TST-NOPEN-ZERO', name: 'Test zero-rate 3m micro loan', interestRate: 0, interestRatePeriod: 'MONTH', termValue: 3, termUnit: 'MONTH', penaltyPolicy: { mode: 'NONE', ratePercent: 0, amount: 0, period: 'MONTH', graceDays: 0, maxPercentOfPrincipal: 0 } },
  { code: 'TST-INACTIVE', name: 'Test retired product', interestRate: 1, interestRatePeriod: 'MONTH', termValue: 6, termUnit: 'MONTH', penaltyPolicy: { mode: 'NONE', ratePercent: 0, amount: 0, period: 'MONTH', graceDays: 0, maxPercentOfPrincipal: 0 }, isActive: 0 },
];

const CUSTOMER_NAMES = [
  'ນາງ ຄຳໜີ ພົມມະຈັນ', 'Mr. Khamla Systems Three', 'นาง บัวคำ กสิกร', 'ທາວັນ ເທບພະກອດ',
  'Miss Noy Lao Four', 'นาย ສີ ພົນທະລາ', 'Somsak Plain Six', 'ນາງ ມະລີ ໂຄຈັນ',
  'ທ້າວ ບຸນມີ ຈັນສີ', 'Ms. Boupha Interest Nine', 'นาง ลัดดา เทสต์', 'ສີ ຄຳມີ ລັດສີ',
  'Kou Khamla Writing Twelve', 'ນາງ ດາວີ ແສງ', 'Mr. Test Latin Only Fourteen', 'Mr. Principal Amount Big',
  'ນາງ ຄໍາ ຟີ ຂະນີ', 'ทศ ເທสต์ Mixed Script', 'Vientiane Last Customer', 'Xaysomboun Overflow Credit',
  'ນາງ ສີວັນ ພະລາ (no KYC)', 'Mr. Pending Review Twenty Two', 'นาง บัวทอง รออนุมัติ', 'Somsak No Documents',
  'ທ້າວ ໄຊ ປະຕິເສດ KYC', 'Miss Family Book Twenty Six',
];

/** One recipe per loan so every row of the locked validation matrix is represented. */
const LOAN_RECIPES = [
  { no: 1, product: 'TST-FLAT-M12', customer: 1, principal: 20000000, disbursedAt: '2025-07-10', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2025-08-10', amount: 2000000 },
    { type: 'PAYMENT', at: '2025-09-10', amount: 2000000 },
    { type: 'PAYMENT', at: '2025-10-10', amount: 2000000 },
    { type: 'PAYMENT', at: '2025-11-10', amount: 2000000 },
    { type: 'PAYMENT', at: '2026-01-10', amount: 2000000 },
    { type: 'PAYMENT_PENDING', at: '2026-09-30', amount: 1500000 },
    { type: 'TX_PENDING', at: '2026-09-25', txType: 'PENALTY', amount: 300000, reason: 'Accrual awaiting checker approval' },
  ] },
  { no: 2, product: 'TST-FLAT-M6', customer: 2, principal: 5000000, disbursedAt: '2025-08-15', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2025-09-10', label: 'early-full' },
  ] },
  { no: 3, product: 'TST-FLAT-M12', customer: 3, principal: 8000000, disbursedAt: '2025-09-01', maker: 'test_op2', events: [
    { type: 'PAYMENT', at: '2026-01-05', overpayBy: 560000 },
  ] },
  { no: 4, product: 'TST-FLAT-M12', customer: 3, principal: 3000000, disbursedAt: '2025-10-05', maker: 'test_op2', events: [
    { type: 'PAYMENT', at: '2026-02-05', amount: 1000000 },
    { type: 'PAYMENT', at: '2026-03-20', useCredit: 560000, amount: 400000 },
    { type: 'PAYMENT', at: '2026-06-18', label: 'settle-rest' },
  ] },
  { no: 5, product: 'TST-FIXED-PEN', customer: 4, principal: 15000000, disbursedAt: '2025-11-20', maker: 'test_op1', events: [
    { type: 'PENALTY', at: '2026-02-28', amount: 1000000 },
    { type: 'PAYMENT', at: '2026-03-02', amount: 1200000 },
    { type: 'PAYMENT_REJECTED', at: '2026-07-15', amount: 900000, reason: 'Bank slip does not match the cash received' },
    { type: 'TX_REJECTED', at: '2026-06-10', txType: 'PENALTY', amount: 400000, reason: 'Penalty was calculated before the grace period ended' },
    { type: 'PAYMENT_RESUBMITTED', at: '2026-08-05', amount: 1000000 },
  ] },
  { no: 6, product: 'TST-DAY-RATE', customer: 5, principal: 1000000, disbursedAt: '2026-01-05', maker: 'test_op2', events: [
    { type: 'PAYMENT', at: '2026-02-05', amount: 350000 },
    { type: 'PAYMENT', at: '2026-03-06', amount: 350000 },
    { type: 'PAYMENT', at: '2026-04-10', amount: 345000 },
  ] },
  { no: 7, product: 'TST-WEEK-TERM', customer: 6, principal: 2500000, disbursedAt: '2026-02-03', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2026-02-10', amount: 200000 },
    { type: 'PAYMENT', at: '2026-02-17', amount: 200000 },
    { type: 'PAYMENT_REJECTED', at: '2026-04-02', amount: 50000, reason: 'Amount received below the requested allocation' },
    { type: 'PAYMENT', at: '2026-04-20', amount: 300000 },
  ] },
  { no: 8, product: 'TST-YEAR-TERM', customer: 7, principal: 50000000, disbursedAt: '2025-12-31', maker: 'test_op2', events: [
    { type: 'PAYMENT', at: '2026-06-15', amount: 10000000 },
    { type: 'PAYMENT_PENDING', at: '2026-10-01', amount: 2000000 },
  ] },
  { no: 9, product: 'TST-NOPEN-ZERO', customer: 8, principal: 100, disbursedAt: '2026-05-31', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2026-06-30', amount: 33.34 },
    { type: 'PAYMENT', at: '2026-07-31', amount: 33.33 },
    { type: 'PAYMENT', at: '2026-08-31', label: 'settle-rest' },
  ] },
  { no: 10, product: 'TST-FLAT-M12', customer: 9, principal: 200000000, disbursedAt: '2025-07-31', maker: 'test_op2', events: [
    { type: 'PENALTY', at: '2025-12-31', amount: 4000000 },
    { type: 'PAYMENT', at: '2026-01-31', amount: 50000000, override: { to: { PENALTY: 2000000 } } },
    { type: 'PAYMENT', at: '2026-04-15', amount: 10000000 },
  ] },
  { no: 11, product: 'TST-FLAT-M6', customer: 10, principal: 6000000, disbursedAt: '2025-10-10', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2026-01-10', label: 'settle-rest' },
    { type: 'REVERSAL', at: '2026-02-11', of: 'settle-rest', label: 'full-reversal' },
  ] },
  { no: 12, product: 'TST-FLAT-M12', customer: 11, principal: 12000000, disbursedAt: '2025-11-11', maker: 'test_op2', events: [
    { type: 'PENALTY', at: '2026-02-11', amount: 300000 },
    { type: 'PAYMENT', at: '2026-02-12', amount: 2000000 },
    { type: 'PAYMENT', at: '2026-03-12', amount: 2000000 },
    { type: 'PAYMENT', at: '2026-04-12', amount: 2000000 },
    { type: 'REVERSAL', at: '2026-06-01', ofIndex: -1, amount: 1500000, label: 'partial-reversal' },
  ] },
  { no: 13, product: 'TST-FLAT-M12', customer: 12, principal: 45000000, disbursedAt: '2026-01-13', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2026-05-13', amount: 12000000, label: 'big-payment' },
    { type: 'REVERSAL', at: '2026-07-20', of: 'big-payment', label: 'admin-final-reversal' },
  ] },
  { no: 14, product: 'TST-FIXED-PEN', customer: 13, principal: 9000000, disbursedAt: '2025-12-05', maker: 'test_op2', events: [
    { type: 'PAYMENT', at: '2026-03-05', amount: 3000000, label: 'downstream-base' },
    { type: 'SETTLEMENT', at: '2026-06-30', agreed: 5000000, status: 'APPROVED' },
    { type: 'ADJUSTMENT', at: '2026-07-01', delta: { PAST_PRINCIPAL: -250000 }, label: 'downstream-adjustment' },
  ] },
  { no: 15, product: 'TST-FLAT-M12', customer: 14, principal: 7500000, disbursedAt: '2025-09-18', maker: 'test_op1', events: [
    { type: 'SETTLEMENT', at: '2026-04-18', agreed: 6000000, status: 'APPROVED', label: 'agreement-only' },
  ] },
  { no: 16, product: 'TST-FLAT-M12', customer: 15, principal: 11000000, disbursedAt: '2025-08-20', maker: 'test_op2', events: [
    { type: 'SETTLEMENT', at: '2026-01-20', agreed: 9000000, status: 'APPROVED' },
    { type: 'SETTLEMENT_PAYMENT', at: '2026-02-20', amount: 9000000 },
  ] },
  { no: 17, product: 'TST-FLAT-M6', customer: 16, principal: 4000000, disbursedAt: '2026-01-31', maker: 'test_op1', events: [
    { type: 'PENALTY', at: '2026-05-31', amount: 240000 },
    { type: 'SETTLEMENT', at: '2026-08-31', agreed: 4360000, status: 'APPROVED' },
    { type: 'SETTLEMENT_PAYMENT', at: '2026-09-15', amount: 4120000 },
    { type: 'WAIVER', at: '2026-09-16', amount: 240000, component: 'PAST_PRINCIPAL', label: 'shortfall-waiver' },
  ] },
  { no: 18, product: 'TST-FLAT-M12', customer: 17, principal: 13000000, disbursedAt: '2025-10-25', maker: 'test_op2', events: [
    { type: 'WRITE_OFF', at: '2026-06-30', label: 'full-write-off' },
  ] },
  { no: 19, product: 'TST-FLAT-M12', customer: 18, principal: 16000000, disbursedAt: '2025-11-28', maker: 'test_op1', events: [
    { type: 'PAYMENT', at: '2026-02-28', amount: 4000000 },
    { type: 'WRITE_OFF', at: '2026-08-31', amount: 5000000, label: 'partial-write-off' },
  ] },
  { no: 20, product: 'TST-FLAT-M6', customer: 19, principal: 2000000, disbursedAt: '2026-03-15', maker: 'test_op2', events: [
    { type: 'WRITE_OFF', at: '2026-06-15', label: 'write-off-then-reversal' },
    { type: 'WRITE_OFF_REVERSAL', at: '2026-09-20', label: 'reopen-after-write-off' },
  ] },
  { no: 21, product: 'TST-FLAT-M12', customer: 20, principal: 1000000, disbursedAt: '2026-04-30', maker: 'test_op1', events: [
    { type: 'PENALTY', at: '2026-08-30', amount: 200000 },
    { type: 'WRITE_OFF', at: '2026-09-30', label: 'write-off-then-pay' },
    { type: 'WRITE_OFF_REVERSAL', at: '2026-10-05', amount: 150000 },
    { type: 'PAYMENT', at: '2026-10-06', amount: 1050000, label: 'pay-after-reopen' },
  ] },
];

const VERIFIED_DOC_SETS = [
  ['NATIONAL_ID:FRONT', 'NATIONAL_ID:BACK', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'],
  ['PASSPORT:MAIN', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'],
  ['ID_CARD:FRONT', 'ID_CARD:BACK', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'],
];

/**
 * The first 20 customers all hold a loan, so they must be VERIFIED — a seeded loan on an
 * unverified customer would contradict the locked disbursement gate. KYC gap cases live on
 * customers 21-26 so they stay clean subjects for the upload/verify/reject tests.
 */
const KYC_CASES = [
  ...Array.from({ length: 20 }, (_, i) => ({
    status: 'VERIFIED',
    docs: VERIFIED_DOC_SETS[i % 3],
    ...(i === 2 ? { expiringSoon: true } : {}),
    ...(i === 3 ? { expired: true } : {}),
    ...(i === 16 ? { docs: ['FAMILY_BOOK:MAIN', ...VERIFIED_DOC_SETS[0]] } : {}),
  })),
  { status: 'PENDING', docs: ['NATIONAL_ID:FRONT', 'NATIONAL_ID:BACK', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'] },
  { status: 'PENDING', docs: ['ID_CARD:FRONT', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'] },
  { status: 'PENDING', docs: ['PASSPORT:MAIN', 'SELFIE_WITH_ID:MAIN', 'SIGNATURE:MAIN'] },
  { status: 'NOT_VERIFIED', docs: [] },
  { status: 'NOT_VERIFIED', docs: ['NATIONAL_ID:FRONT'] },
  { status: 'NOT_VERIFIED', docs: ['NATIONAL_ID:FRONT', 'NATIONAL_ID:BACK'] },
  { status: 'REJECTED', docs: ['NATIONAL_ID:FRONT', 'SELFIE_WITH_ID:MAIN'], reason: 'ID image is unreadable and the selfie does not match the card photo' },
];

export function buildDataset({ seed = 12345, referenceNow = REFERENCE_NOW } = {}) {
  const rng = mulberry32(seed);
  const nowIso = referenceNow;
  const nowDate = nowIso.slice(0, 10);

  const rows = {
    users: [], customers: [], loan_products: [], loans: [], financial_transactions: [],
    financial_transaction_lines: [], payment_requests: [], payment_allocations: [],
    approval_workflows: [], approval_steps: [], audit_logs: [], customer_credits: [],
    credit_ledger: [], settlement_agreements: [], kyc_documents: [], kyc_document_contents: [],
    user_avatars: [], user_avatar_contents: [],
  };

  const users = USERS.map((u, i) => {
    const row = {
      id: `00000000-0000-4000-8000-${PAD(i + 1, 12)}`,
      username: u.username,
      passwordHash: `SEED_BCRYPT_${u.username}`,
      fullName: u.fullName,
      role: u.role,
      isActive: u.isActive ?? 1,
      email: u.email,
      isEmailVerified: u.verified,
      createdAt: '2025-06-20 08:00:00.000',
      lastLoginAt: u.isActive === 0 ? null : `2026-10-1${(i % 3) + 1} 0${(i % 9)}:15:00.000`,
      passwordChangedAt: '2025-06-20 08:00:00.000',
      deletedAt: u.deleted ? '2026-09-01 10:00:00.000' : null,
    };
    rows.users.push(row);
    return row;
  });
  const byName = Object.fromEntries(users.map((u) => [u.username, u]));

  const products = PRODUCTS.map((p, i) => {
    const row = {
      id: `00000000-1000-4000-8000-${PAD(i + 1, 12)}`,
      code: p.code,
      name: p.name,
      interestRate: p.interestRate,
      interestRatePeriod: p.interestRatePeriod,
      termValue: p.termValue,
      termUnit: p.termUnit,
      termMonths: periodCount(p.termValue, p.termUnit),
      currency: 'LAK',
      description: `Seeded test product ${p.code}`,
      isActive: p.isActive ?? 1,
      penaltyPolicy: p.penaltyPolicy,
      createdAt: '2025-06-21 03:00:00.000',
    };
    rows.loan_products.push(row);
    return row;
  });
  const productByCode = Object.fromEntries(products.map((p) => [p.code, p]));

  const KYC_POLICY_SNAPSHOT = {
    maxFileSizeKb: 5120, maxFilesPerRequest: 1, allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
    allowedDocumentTypes: ['NATIONAL_ID', 'ID_CARD', 'PASSPORT', 'FAMILY_BOOK', 'SELFIE_WITH_ID', 'SIGNATURE'],
    requiredIdentityTypes: ['NATIONAL_ID', 'ID_CARD', 'PASSPORT'], requireSelfieWithId: true,
    requireSignature: true, requireFamilyBook: false, acceptExpiredDocuments: false, expiryWarningDays: 60,
    maxTotalBytesPerCustomer: 31457280, blockDisbursementUntilVerified: true, reverifyOnDocumentChange: true,
  };

  const customers = CUSTOMER_NAMES.map((name, i) => {
    const kase = KYC_CASES[i];
    const reviewer = kase.status === 'VERIFIED' || kase.status === 'REJECTED' ? byName.test_checker1 : null;
    const submitter = kase.docs.length ? byName.test_op1 : null;
    const row = {
      id: `00000000-2000-4000-8000-${PAD(i + 1, 12)}`,
      customerNumber: `CUST-TST-${PAD(i + 1, 4)}`,
      fullName: name,
      phone: `+85620${PAD(Math.floor(rng() * 9000000) + 1000000, 7)}`,
      email: `customer${PAD(i + 1, 2)}@test.local`,
      nationalId: `01${PAD(Math.floor(rng() * 99999999), 8)}${PAD(i + 1, 2)}`,
      address: `Test address ${i + 1}, Vientiane`,
      createdAt: `2025-06-${PAD(22 + (i % 6), 2)} 04:00:00.000`,
      kycStatus: kase.status,
      kycSubmittedBy: submitter?.id ?? null,
      kycSubmittedAt: kase.status === 'NOT_VERIFIED' && kase.docs.length ? null : (submitter ? `2026-09-${PAD(10 + (i % 8), 2)} 05:00:00.000` : null),
      kycReviewedBy: reviewer?.id ?? null,
      kycReviewedAt: reviewer ? `2026-09-${PAD(12 + (i % 8), 2)} 06:30:00.000` : null,
      kycRejectionReason: kase.reason ?? null,
      kycAppliedPolicy: reviewer ? KYC_POLICY_SNAPSHOT : null,
    };
    rows.customers.push(row);
    return row;
  });

  // KYC documents + their stored bytes (checksum is sha256 of the exact bytes served back).
  customers.forEach((customer, ci) => {
    const kase = KYC_CASES[ci];
    kase.docs.forEach((spec, di) => {
      const [documentType, variant] = spec.split(':');
      const sizeKb = 20 + Math.floor(rng() * 180);
      const data = jpegBytes(rng, sizeKb);
      const id = `00000000-3000-4000-8000-${PAD(ci * 100 + di + 1, 12)}`;
      const expired = kase.expired && documentType === 'NATIONAL_ID';
      const expiring = kase.expiringSoon && documentType === 'NATIONAL_ID';
      const row = {
        id,
        customerId: customer.id,
        documentType,
        variant,
        fileName: `${customer.customerNumber.toLowerCase()}-${documentType.toLowerCase()}-${variant.toLowerCase()}.jpg`,
        mimeType: 'image/jpeg',
        sizeBytes: data.length,
        checksum: sha256(data),
        issuedAt: '2023-04-11',
        expiresAt: expired ? '2026-05-01' : expiring ? addDays(nowDate, 21) : '2029-04-11',
        note: di === 0 ? 'Seeded test document' : null,
        uploadedBy: byName.test_op1.id,
        createdAt: `2026-09-${PAD(8 + (ci % 9), 2)} 0${di}:20:00.000`,
        _data: data,
      };
      rows.kyc_documents.push(row);
      rows.kyc_document_contents.push({ documentId: id, data, createdAt: row.createdAt });
    });
  });

  // Two staff avatars so the avatar read/replace/delete paths have seeded data.
  for (const [username, sizeKb] of [['test_admin', 24], ['test_op1', 48]]) {
    const data = pngBytes(rng, sizeKb);
    const id = `00000000-a000-4000-8000-${PAD(rows.user_avatars.length + 1, 12)}`;
    rows.user_avatars.push({
      id,
      userId: byName[username].id,
      fileName: `${username}.png`,
      mimeType: 'image/png',
      sizeBytes: data.length,
      checksum: sha256(data),
      uploadedBy: byName.test_admin.id,
      createdAt: '2026-09-05 09:00:00.000',
      updatedAt: '2026-09-05 09:00:00.000',
    });
    rows.user_avatar_contents.push({ avatarId: id, data, createdAt: '2026-09-05 09:00:00.000' });
  }

  const states = {};
  const txSeq = { n: 0 };
  const nextTxNo = () => `FT-TST-${PAD(++txSeq.n)}`;
  const auditSeq = { n: 0 };
  const audit = (entry) => {
    rows.audit_logs.push({
      id: `00000000-9000-4000-8000-${PAD(++auditSeq.n, 12)}`,
      currency: 'LAK',
      ip: '127.0.0.1',
      userAgent: 'seed-test-data',
      ...entry,
    });
  };

  const levelsForAmount = (lak) => (lak > 10000000 ? ['CHECKER', 'HEAD', 'ADMIN'] : lak > 1000000 ? ['CHECKER', 'HEAD'] : ['CHECKER']);
  const deciderFor = (level) => (level === 'CHECKER' ? byName.test_checker1 : level === 'HEAD' ? byName.test_head : byName.test_admin);

  function workflowFor(subjectType, subjectId, amountLak, { status, decidedAt, maker, stepsPendingFrom = null }) {
    const levels = levelsForAmount(amountLak);
    const wfId = `00000000-8000-4000-8000-${PAD(rows.approval_workflows.length + 1, 12)}`;
    let firstPendingIndex = status === 'PENDING' ? (stepsPendingFrom ?? 0) : levels.length;
    rows.approval_workflows.push({
      id: wfId,
      subjectType,
      subjectId,
      requiredLevels: levels,
      currentLevelIndex: firstPendingIndex,
      status,
      completedAt: status === 'PENDING' ? null : decidedAt,
      createdAt: decidedAt ?? nowIso.slice(0, 19).replace('T', ' '),
    });
    levels.forEach((level, i) => {
      const decided = i < firstPendingIndex;
      const decider = deciderFor(level);
      rows.approval_steps.push({
        id: `00000000-8100-4000-8000-${PAD(rows.approval_steps.length + 1, 12)}`,
        workflowId: wfId,
        level,
        status: decided ? 'APPROVED' : 'PENDING',
        userId: decided ? decider.id : null,
        reason: decided ? null : 'Awaiting decision in the seeded queue',
        decidedAt: decided ? decidedAt : null,
        createdAt: decidedAt ?? nowIso.slice(0, 19).replace('T', ' '),
      });
      if (decided) {
        audit({
          action: 'APPROVAL_STEP_APPROVED', userId: decider.id, makerUserId: maker?.id, checkerUserId: decider.id,
          transactionId: subjectType === 'FINANCIAL_TRANSACTION' ? subjectId : null,
          amount: amountLak, newStatus: 'APPROVED', createdAt: decidedAt,
        });
      }
    });
    return wfId;
  }

  function transaction({ loan, state, type, amountCents, at, status = 'POSTED', maker, reason, referenceTransactionId, sourceRequestId, settlementAgreementId, componentAmounts = null, lines = null }) {
    const id = `00000000-4000-4000-8000-${PAD(rows.financial_transactions.length + 1, 12)}`;
    const amountLak = toLak(amountCents);
    rows.financial_transactions.push({
      id,
      referenceNo: nextTxNo(),
      transactionType: type,
      status,
      loanId: loan.id,
      customerId: loan.customerId,
      amount: amountLak,
      currency: 'LAK',
      referenceTransactionId: referenceTransactionId ?? null,
      sourceRequestId: sourceRequestId ?? null,
      settlementAgreementId: settlementAgreementId ?? null,
      componentAmounts: centsToLakObject(componentAmounts),
      reason: reason ?? null,
      rejectionReason: status === 'REJECTED' ? reason : null,
      createdBy: maker.id,
      postedBy: status === 'POSTED' ? deciderFor('ADMIN').id : null,
      approvedAt: status === 'POSTED' ? at : null,
      postedAt: status === 'POSTED' ? at : null,
      createdAt: at,
    });
    if (status === 'POSTED' && lines) {
      for (const c of COMPONENTS) {
        if (!lines[c]) continue;
        rows.financial_transaction_lines.push({
          id: `00000000-4100-4000-8000-${PAD(rows.financial_transaction_lines.length + 1, 12)}`,
          transactionId: id,
          component: c,
          amount: toLak(lines[c]),
          createdAt: at,
        });
      }
    }
    audit({
      action: 'TRANSACTION_CREATED', transactionId: id, transactionType: type, loanId: loan.id, customerId: loan.customerId,
      userId: maker.id, makerUserId: maker.id, amount: amountLak, currency: 'LAK', newStatus: status, reason: reason ?? null,
      referenceTransactionId: referenceTransactionId ?? null, sourceRequestId: sourceRequestId ?? null, createdAt: at,
    });
    if (status === 'POSTED') {
      audit({
        action: 'TRANSACTION_POSTED', transactionId: id, transactionType: type, loanId: loan.id, customerId: loan.customerId,
        userId: byName.test_admin.id, makerUserId: maker.id, amount: amountLak, currency: 'LAK',
        previousStatus: 'APPROVED', newStatus: 'POSTED', createdAt: at,
      });
      workflowFor('FINANCIAL_TRANSACTION', id, amountLak, { status: 'APPROVED', decidedAt: at, maker });
    } else if (status === 'PENDING_APPROVAL') {
      workflowFor('FINANCIAL_TRANSACTION', id, amountLak, { status: 'PENDING', decidedAt: null, maker, stepsPendingFrom: 0 });
    } else if (status === 'REJECTED') {
      const wfId = `00000000-8000-4000-8000-${PAD(rows.approval_workflows.length + 1, 12)}`;
      rows.approval_workflows.push({
        id: wfId, subjectType: 'FINANCIAL_TRANSACTION', subjectId: id, requiredLevels: levelsForAmount(amountLak),
        currentLevelIndex: 0, status: 'REJECTED', completedAt: at, createdAt: at,
      });
      rows.approval_steps.push({
        id: `00000000-8100-4000-8000-${PAD(rows.approval_steps.length + 1, 12)}`,
        workflowId: wfId, level: 'CHECKER', status: 'REJECTED', userId: byName.test_checker2.id, reason, decidedAt: at, createdAt: at,
      });
      audit({
        action: 'APPROVAL_STEP_REJECTED', transactionId: id, transactionType: type, loanId: loan.id, customerId: loan.customerId,
        userId: byName.test_checker2.id, checkerUserId: byName.test_checker2.id, makerUserId: maker.id, amount: amountLak,
        previousStatus: 'PENDING_APPROVAL', newStatus: 'REJECTED', reason, createdAt: at,
      });
    }
    return { id, referenceNo: rows.financial_transactions.at(-1).referenceNo };
  }

  function paymentRequest({ loan, maker, cashCents, creditCents, at, status, reason, allocations, previousRequestId, settlementAgreementId }) {
    const id = `00000000-5000-4000-8000-${PAD(rows.payment_requests.length + 1, 12)}`;
    rows.payment_requests.push({
      id,
      requestNo: `PR-TST-${PAD(rows.payment_requests.length + 1)}`,
      loanId: loan.id,
      customerId: loan.customerId,
      cashAmount: toLak(cashCents),
      creditApplied: toLak(creditCents),
      currency: 'LAK',
      status,
      previousRequestId: previousRequestId ?? null,
      settlementAgreementId: settlementAgreementId ?? null,
      note: status === 'PENDING' ? 'Seeded request waiting in the approval queue' : null,
      rejectionReason: status === 'REJECTED' ? reason : null,
      createdBy: maker.id,
      approvedBy: status === 'APPROVED' ? byName.test_checker1.id : null,
      rejectedBy: status === 'REJECTED' ? byName.test_checker2.id : null,
      approvedAt: status === 'APPROVED' ? at : null,
      rejectedAt: status === 'REJECTED' ? at : null,
      createdAt: at,
    });
    for (const [component, cents] of Object.entries(allocations ?? {})) {
      if (component === '__proposed' || !cents) continue;
      rows.payment_allocations.push({
        id: `00000000-5100-4000-8000-${PAD(rows.payment_allocations.length + 1, 12)}`,
        paymentRequestId: id,
        component,
        proposedAmount: toLak(allocations.__proposed?.[component] ?? cents),
        finalAmount: toLak(cents),
        overridden: status === 'APPROVED' && (allocations.__proposed?.[component] ?? cents) !== cents,
        createdAt: at,
      });
    }
    audit({
      action: status === 'REJECTED' ? 'PAYMENT_REQUEST_REJECTED' : status === 'PENDING' ? 'PAYMENT_REQUEST_CREATED' : 'PAYMENT_REQUEST_APPROVED',
      loanId: loan.id, customerId: loan.customerId, sourceRequestId: id, userId: status === 'REJECTED' ? byName.test_checker2.id : maker.id,
      makerUserId: maker.id, amount: toLak(cashCents + creditCents), currency: 'LAK', newStatus: status, reason: reason ?? null, createdAt: at,
    });
    return id;
  }

  const credits = {};
  function creditRow(customerId) {
    if (!credits[customerId]) {
      credits[customerId] = {
        id: `00000000-6000-4000-8000-${PAD(rows.customer_credits.length + 1, 12)}`,
        customerId,
        currency: 'LAK',
        balance: 0,
        updatedAt: nowIso.slice(0, 19).replace('T', ' '),
      };
      rows.customer_credits.push(credits[customerId]);
    }
    return credits[customerId];
  }

  function creditEvent(customerId, type, cents, transactionId, at) {
    const account = creditRow(customerId);
    account.balance = toLak(toCents(account.balance) + (type === 'ACCRUED' ? cents : -cents));
    account.updatedAt = at;
    rows.credit_ledger.push({
      id: `00000000-6100-4000-8000-${PAD(rows.credit_ledger.length + 1, 12)}`,
      customerId,
      type,
      amount: toLak(cents),
      balanceAfter: account.balance,
      transactionId: transactionId ?? null,
      createdAt: at,
    });
    audit({
      action: type === 'ACCRUED' ? 'CREDIT_ACCRUED' : 'CREDIT_USED',
      customerId, transactionId, amount: toLak(cents), currency: 'LAK',
      newBalance: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0, total: account.balance }, createdAt: at,
    });
  }

  const loans = [];
  const perLoanExpected = {};
  const settlementIds = new Map();
  // Customer credit is a customer-level pool, so it must survive across that customer's loans.
  const creditPool = {};

  for (const recipe of LOAN_RECIPES) {
    const product = productByCode[recipe.product];
    const customer = customers[recipe.customer - 1];
    const maker = byName[recipe.maker];
    const loan = {
      id: `00000000-7000-4000-8000-${PAD(recipe.no, 12)}`,
      loanNumber: `LN-TST-${PAD(recipe.no)}`,
      customerId: customer.id,
      productId: product.id,
      status: 'ACTIVE',
      principalAmount: recipe.principal,
      interestRate: product.interestRate,
      interestRatePeriod: product.interestRatePeriod,
      termValue: product.termValue,
      termUnit: product.termUnit,
      termMonths: product.termMonths,
      currency: 'LAK',
      outstandingPenalty: 0,
      outstandingPastInterest: 0,
      outstandingPastPrincipal: 0,
      currentOutstanding: 0,
      disbursedAt: `${recipe.disbursedAt} 02:00:00.000`,
      createdAt: `${recipe.disbursedAt} 01:45:00.000`,
      updatedAt: nowIso.slice(0, 19).replace('T', ' '),
      penaltyPolicy: product.penaltyPolicy,
    };
    rows.loans.push(loan);
    loans.push(loan);

    const principalCents = toCents(recipe.principal);
    const interestCents = billedInterestCents({
      principalCents,
      ratePercent: product.interestRate,
      rateUnit: product.interestRatePeriod,
      termValue: product.termValue,
      termUnit: product.termUnit,
    });
    const state = newLoanState(loan.id, customer.id, { ...emptyComponents(), PAST_INTEREST: interestCents, PAST_PRINCIPAL: principalCents }, principalCents);
    states[loan.id] = state;

    transaction({
      loan, state, type: 'DISBURSEMENT', amountCents: principalCents + interestCents,
      at: loan.disbursedAt.replace(' ', 'T').slice(0, 19),
      status: 'POSTED', maker,
      componentAmounts: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: principalCents },
      lines: { PENALTY: 0, PAST_INTEREST: interestCents, PAST_PRINCIPAL: principalCents },
    });
    audit({
      action: 'LOAN_DISBURSED', loanId: loan.id, customerId: customer.id, userId: maker.id, makerUserId: maker.id,
      amount: recipe.principal, currency: 'LAK', newStatus: 'ACTIVE',
      newBalance: { PENALTY: 0, PAST_INTEREST: toLak(interestCents), PAST_PRINCIPAL: recipe.principal, total: toLak(interestCents + principalCents) },
      createdAt: loan.disbursedAt,
    });
    state.components.PAST_PRINCIPAL = principalCents;
    state.components.PAST_INTEREST = interestCents;
    state.history.push({
      type: 'DISBURSEMENT',
      at: recipe.disbursedAt,
      afterCents: principalCents + interestCents,
      allocation: emptyComponents(),
      creditAccruedCents: 0,
    });

    const postedPayments = [];
    let lastRejected = null;
    let lastWriteOffTarget = null;
    let lastWriteOffId = null;
    creditPool[customer.id] ??= 0;

    for (const ev of recipe.events) {
      const at = `${ev.at} 07:30:00.000`;
      const atIso = at.slice(0, 19);
      const outstandingCents = totalOf(state.components);

      if (ev.type === 'PAYMENT' || ev.type === 'SETTLEMENT_PAYMENT' || ev.type === 'PAYMENT_PENDING' || ev.type === 'PAYMENT_RESUBMITTED') {
        let amountCents = ev.amount != null ? toCents(ev.amount) : outstandingCents;
        if (ev.overpayBy) amountCents += toCents(ev.overpayBy);
        // useCredit is the credit *portion* of this payment, so it can never exceed the payment itself.
        const useCredit = ev.useCredit
          ? Math.min(toCents(ev.useCredit), creditPool[customer.id], outstandingCents, amountCents)
          : 0;
        const cashCents = amountCents - useCredit;
        const status = ev.type === 'PAYMENT_PENDING' ? 'PENDING' : 'APPROVED';

        const { allocation, overpaymentCents } = allocateComponents(amountCents, state.components);
        const proposed = ev.override ? { ...allocation, PENALTY: toCents(ev.override.to.PENALTY) } : allocation;
        const requestId = paymentRequest({
          loan, maker, cashCents, creditCents: useCredit, at, status, reason: null,
          allocations: { ...allocation, __proposed: proposed },
          previousRequestId: ev.type === 'PAYMENT_RESUBMITTED' ? lastRejected?.id : null,
          settlementAgreementId: ev.settlementId ?? settlementIds.get(loan.id) ?? null,
        });
        lastRejected = ev.type === 'PAYMENT_RESUBMITTED' ? null : lastRejected;

        if (status === 'PENDING') {
          postedPayments.push({ requestId, amountCents, allocation, at, posted: false, label: ev.label });
          continue;
        }

        const result = postEvent(state, {
          type: ev.type === 'SETTLEMENT_PAYMENT' ? 'SETTLEMENT_PAYMENT' : 'PAYMENT',
          amountCents: cashCents, creditAppliedCents: useCredit, postedAtIso: ev.at,
        });
        const tx = transaction({
          loan, state, type: ev.type === 'SETTLEMENT_PAYMENT' ? 'SETTLEMENT_PAYMENT' : 'PAYMENT',
          amountCents: cashCents + useCredit, at: atIso, status: 'POSTED', maker, sourceRequestId: requestId,
          settlementAgreementId: ev.settlementId ?? settlementIds.get(loan.id) ?? null,
          componentAmounts: result.allocation, lines: negCents(result.allocation),
          reason: ev.override ? 'Staff override of the proposed allocation' : null,
        });
        if (useCredit) creditEvent(customer.id, 'USED', useCredit, tx.id, at);
        creditPool[customer.id] -= useCredit;
        if (result.creditAccruedCents) {
          creditEvent(customer.id, 'ACCRUED', result.creditAccruedCents, tx.id, at);
          creditPool[customer.id] += result.creditAccruedCents;
        }
        postedPayments.push({ id: tx.id, requestId, amountCents, allocation: result.allocation, at, posted: true, label: ev.label });
        continue;
      }

      if (ev.type === 'PAYMENT_REJECTED') {
        const requestId = paymentRequest({ loan, maker, cashCents: toCents(ev.amount), creditCents: 0, at, status: 'REJECTED', reason: ev.reason, allocations: null });
        lastRejected = { id: requestId };
        continue;
      }

      if (ev.type === 'TX_PENDING' || ev.type === 'TX_REJECTED') {
        const cents = toCents(ev.amount);
        const components =
          ev.txType === 'WAIVER' || ev.txType === 'WRITE_OFF' || ev.txType === 'ADJUSTMENT'
            ? { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0, [ev.component]: ev.txType === 'ADJUSTMENT' ? -cents : cents }
            : null;
        transaction({
          loan, state, type: ev.txType, amountCents: cents, at: atIso,
          status: ev.type === 'TX_PENDING' ? 'PENDING_APPROVAL' : 'REJECTED',
          maker, componentAmounts: components, reason: ev.reason ?? `Seeded ${ev.txType.toLowerCase()} awaiting approval`,
        });
        continue;
      }

      if (ev.type === 'PENALTY') {
        const cents = ev.amount != null ? toCents(ev.amount) : accruedPenaltyCents({
          overdueBaseCents: state.components.PAST_PRINCIPAL + state.components.PAST_INTEREST,
          principalCents,
          asOfIso: ev.at,
          firstOverdueIso: addDays(recipe.disbursedAt, 30),
          policy: product.penaltyPolicy,
        });
        postEvent(state, { type: 'PENALTY', amountCents: cents, postedAtIso: ev.at });
        transaction({ loan, state, type: 'PENALTY', amountCents: cents, at: atIso, status: 'POSTED', maker, reason: 'Seeded penalty accrual', lines: { PENALTY: cents, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 } });
        continue;
      }

      if (ev.type === 'REVERSAL') {
        const source = ev.of
          ? postedPayments.find((p) => p.label === ev.of && p.posted)
          : ev.ofIndex != null
            ? postedPayments.at(ev.ofIndex)
            : postedPayments.at(-1);
        if (!source?.posted || !source.id) throw new Error(`dataset: loan ${recipe.no} reversal has no posted source payment`);
        const amountCents = ev.amount != null ? toCents(ev.amount) : source.amountCents;
        const originalAllocation = source.allocation;
        if (amountCents > totalOf(originalAllocation)) {
          throw new Error(`dataset: loan ${recipe.no} reversal ${fmt(amountCents)} exceeds the original allocation ${fmt(totalOf(originalAllocation))}`);
        }
        const { reversed } = reverseAllocation(originalAllocation, amountCents);
        postEvent(state, { type: 'PAYMENT_REVERSAL', amountCents, originalAllocation, postedAtIso: ev.at });
        transaction({
          loan, state, type: 'PAYMENT_REVERSAL', amountCents, at: atIso, status: 'POSTED', maker,
          referenceTransactionId: source.id, reason: ev.label ?? 'Seeded payment reversal', lines: reversed,
        });
        continue;
      }

      if (ev.type === 'WAIVER') {
        const cents = toCents(ev.amount);
        const components = ev.component ? { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0, [ev.component]: cents } : { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: cents };
        postEvent(state, { type: 'WAIVER', amountCents: cents, components, postedAtIso: ev.at });
        transaction({
          loan, state, type: 'WAIVER', amountCents: cents, at: atIso, status: 'POSTED', maker,
          componentAmounts: components, lines: negCents(components), reason: ev.label ?? 'Seeded waiver',
        });
        continue;
      }

      if (ev.type === 'ADJUSTMENT') {
        const delta = Object.fromEntries(COMPONENTS.map((c) => [c, toCents(ev.delta?.[c] ?? 0)]));
        const magnitude = COMPONENTS.reduce((s, c) => s + Math.abs(delta[c]), 0);
        postEvent(state, { type: 'ADJUSTMENT', amountCents: magnitude, components: delta, postedAtIso: ev.at });
        transaction({
          loan, state, type: 'ADJUSTMENT', amountCents: magnitude, at: atIso, status: 'POSTED', maker,
          componentAmounts: delta, lines: delta, reason: ev.label ?? 'Seeded adjustment',
        });
        continue;
      }

      if (ev.type === 'WRITE_OFF' || ev.type === 'WRITE_OFF_REVERSAL') {
        const cents =
          ev.amount != null
            ? toCents(ev.amount)
            : ev.type === 'WRITE_OFF_REVERSAL'
              ? totalOf(lastWriteOffTarget ?? emptyComponents())
              : totalOf(state.components);
        if (ev.type === 'WRITE_OFF') {
          const target = allocateComponents(cents, state.components).allocation;
          lastWriteOffTarget = target;
          const statusBefore = state.status;
          postEvent(state, { type: 'WRITE_OFF', amountCents: cents, components: target, postedAtIso: ev.at });
          lastWriteOffId = transaction({ loan, state, type: 'WRITE_OFF', amountCents: cents, at: atIso, status: 'POSTED', maker, componentAmounts: target, lines: negCents(target), reason: ev.label ?? 'Seeded write-off' }).id;
          // a partial write-off keeps the loan ACTIVE, so no status-change audit in that case
          if (state.status !== statusBefore) {
            audit({ action: 'LOAN_STATUS_CHANGED', loanId: loan.id, customerId: customer.id, userId: maker.id, previousStatus: statusBefore, newStatus: state.status, amount: toLak(cents), createdAt: at });
          }
        } else {
          // A write-off reversal restores what the write-off removed, never the (already zero)
          // components currently outstanding.
          const base = lastWriteOffTarget ?? { ...emptyComponents(), PAST_PRINCIPAL: principalCents, PAST_INTEREST: interestCents };
          const target = reverseAllocation(base, cents).reversed;
          const statusBefore = state.status;
          postEvent(state, { type: 'WRITE_OFF_REVERSAL', amountCents: cents, components: target, postedAtIso: ev.at });
          transaction({ loan, state, type: 'WRITE_OFF_REVERSAL', amountCents: cents, at: atIso, status: 'POSTED', maker, referenceTransactionId: lastWriteOffId ?? null, lines: target, reason: ev.label ?? 'Seeded write-off reversal' });
          if (state.status !== statusBefore) {
            audit({ action: 'LOAN_STATUS_CHANGED', loanId: loan.id, customerId: customer.id, userId: maker.id, previousStatus: statusBefore, newStatus: state.status, amount: toLak(cents), createdAt: at });
          }
        }
        continue;
      }

      if (ev.type === 'SETTLEMENT') {
        const id = `00000000-8500-4000-8000-${PAD(rows.settlement_agreements.length + 1, 12)}`;
        rows.settlement_agreements.push({
          id,
          agreementNo: `SA-TST-${PAD(rows.settlement_agreements.length + 1)}`,
          loanId: loan.id,
          customerId: customer.id,
          agreedAmount: ev.agreed,
          currency: 'LAK',
          status: ev.status,
          reason: ev.label ?? 'Seeded settlement agreement',
          createdBy: maker.id,
          decidedBy: byName.test_head.id,
          decidedAt: ev.status === 'APPROVED' ? at : null,
          decisionReason: ev.status === 'APPROVED' ? 'Agreed with the customer, shortfall handled separately' : null,
          createdAt: at,
        });
        workflowFor('SETTLEMENT_AGREEMENT', id, ev.agreed, { status: ev.status === 'APPROVED' ? 'APPROVED' : 'PENDING', decidedAt: at, maker });
        audit({ action: 'SETTLEMENT_AGREEMENT_CREATED', loanId: loan.id, customerId: customer.id, userId: maker.id, makerUserId: maker.id, amount: ev.agreed, currency: 'LAK', newStatus: 'PENDING_APPROVAL', createdAt: at });
        if (ev.status === 'APPROVED') {
          audit({ action: 'SETTLEMENT_AGREEMENT_APPROVED', loanId: loan.id, customerId: customer.id, userId: byName.test_head.id, headApproverUserId: byName.test_head.id, amount: ev.agreed, previousStatus: 'PENDING_APPROVAL', newStatus: 'APPROVED', createdAt: at });
        }
        ev.createdId = id;
        settlementIds.set(loan.id, id);
        continue;
      }

      throw new Error(`dataset: unknown event type ${ev.type} on loan ${recipe.no}`);
    }

    loan.status = state.status;
    loan.outstandingPenalty = toLak(state.components.PENALTY);
    loan.outstandingPastInterest = toLak(state.components.PAST_INTEREST);
    loan.outstandingPastPrincipal = toLak(state.components.PAST_PRINCIPAL);
    loan.currentOutstanding = toLak(totalOf(state.components));

    perLoanExpected[loan.loanNumber] = {
      loanId: loan.id,
      customerId: customer.id,
      customerNumber: customer.customerNumber,
      product: product.code,
      status: loan.status,
      principal: fmt(principalCents),
      billedInterest: fmt(interestCents),
      outstanding: { PENALTY: fmt(state.components.PENALTY), PAST_INTEREST: fmt(state.components.PAST_INTEREST), PAST_PRINCIPAL: fmt(state.components.PAST_PRINCIPAL), total: fmt(totalOf(state.components)) },
      periodCount: periodCount(product.termValue, product.termUnit),
      scheduleDueDates: buildSchedule({ startIso: recipe.disbursedAt, principalCents, interestCents, termValue: product.termValue, termUnit: product.termUnit }).map((p) => p.dueDate),
      postedTransactionCount: rows.financial_transactions.filter((t) => t.loanId === loan.id && t.status === 'POSTED').length,
      pendingTransactionCount: rows.financial_transactions.filter((t) => t.loanId === loan.id && t.status !== 'POSTED' && t.status !== 'REJECTED').length,
    };
  }

  const months = monthKeys(`${FROM_MONTH}-01`, `${TO_MONTH}-01`);
  const lastDayOfMonth = (m) => {
    const [y, mo] = m.split('-').map(Number);
    return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  };

  const postedTx = rows.financial_transactions
    .filter((t) => t.status === 'POSTED')
    .map((t) => {
      const allocation = t.componentAmounts
        ? Object.fromEntries(COMPONENTS.map((c) => [c, toCents(t.componentAmounts[c] ?? 0)]))
        : emptyComponents();
      const req = t.sourceRequestId ? rows.payment_requests.find((r) => r.id === t.sourceRequestId) : null;
      return {
        id: t.id,
        loanId: t.loanId,
        customerId: t.customerId,
        transactionType: t.transactionType,
        amountCents: toCents(t.amount),
        allocation,
        postedAtIso: t.postedAt.slice(0, 10),
        creditAppliedCents: req ? toCents(req.creditApplied) : 0,
      };
    });

  const monthlyCents = Object.fromEntries(
    months.map((m) => [m, { disbursedCash: 0, booked: 0, moneyIn: 0, collected: 0, interestPaid: 0, penaltyPaid: 0, principalPaid: 0, penaltyCharged: 0, reversed: 0, waived: 0, writtenOff: 0, transactions: 0 }]),
  );
  for (const tx of postedTx) {
    const bucket = monthlyCents[tx.postedAtIso.slice(0, 7)];
    if (!bucket) continue;
    bucket.transactions += 1;
    if (tx.transactionType === 'DISBURSEMENT') {
      // Cash handed to the customer is the principal; the ledger also books the flat interest.
      bucket.disbursedCash += tx.allocation.PAST_PRINCIPAL;
      bucket.booked += tx.amountCents;
    }
    if (tx.transactionType === 'PAYMENT' || tx.transactionType === 'SETTLEMENT_PAYMENT') {
      bucket.moneyIn += tx.amountCents;
      bucket.collected += tx.amountCents;
      bucket.interestPaid += tx.allocation.PAST_INTEREST;
      bucket.penaltyPaid += tx.allocation.PENALTY;
      bucket.principalPaid += tx.allocation.PAST_PRINCIPAL;
    }
    if (tx.transactionType === 'PAYMENT_REVERSAL') {
      bucket.reversed += tx.amountCents;
      bucket.collected -= tx.amountCents;
    }
    if (tx.transactionType === 'WAIVER') bucket.waived += tx.amountCents;
    if (tx.transactionType === 'WRITE_OFF') bucket.writtenOff += tx.amountCents;
    if (tx.transactionType === 'PENALTY') bucket.penaltyCharged += tx.amountCents;
  }
  const monthly = Object.fromEntries(
    Object.entries(monthlyCents).map(([m, b]) => [
      m,
      {
        disbursedCash: fmt(b.disbursedCash),
        booked: fmt(b.booked),
        moneyIn: fmt(b.moneyIn),
        collected: fmt(b.collected),
        interestPaid: fmt(b.interestPaid),
        penaltyPaid: fmt(b.penaltyPaid),
        principalPaid: fmt(b.principalPaid),
        penaltyCharged: fmt(b.penaltyCharged),
        reversed: fmt(b.reversed),
        waived: fmt(b.waived),
        writtenOff: fmt(b.writtenOff),
        transactions: b.transactions,
      },
    ]),
  );

  // Month-end book value replayed from the oracle history of every loan (posted events only).
  const closingOutstandingByMonth = {};
  const closingByLoan = {};
  for (const m of months) {
    const end = lastDayOfMonth(m);
    let total = 0;
    for (const loan of loans) {
      let value = 0;
      for (const step of states[loan.id].history) {
        if (step.at <= end) value = step.afterCents;
      }
      total += value;
      (closingByLoan[loan.loanNumber] ??= {})[m] = fmt(value);
    }
    closingOutstandingByMonth[m] = fmt(total);
  }

  // Mechanical restatement of GET /api/reports/monthly: the same source rows (POSTED amounts and
  // signed component lines) aggregated the way the endpoint does. `monthly` above is the
  // business-truth view; a divergence between the two is a finding about the endpoint, not the data.
  const postedMonth = new Map(
    rows.financial_transactions.filter((t) => t.status === 'POSTED').map((t) => [t.id, t.postedAt.slice(0, 7)]),
  );
  const span = monthKeys('2024-01-01', `${TO_MONTH}-01`);
  const comp = Object.fromEntries(
    span.map((m) => [m, { principalPaid: 0, interestPaid: 0, penaltyPaid: 0, interestAccrued: 0, penaltyAdded: 0, outstandingDelta: 0 }]),
  );
  for (const line of rows.financial_transaction_lines) {
    const m = postedMonth.get(line.transactionId);
    const b = m && comp[m];
    if (!b) continue;
    const cents = toCents(line.amount);
    b.outstandingDelta += cents;
    if (cents < 0) {
      if (line.component === 'PAST_PRINCIPAL') b.principalPaid += -cents;
      if (line.component === 'PAST_INTEREST') b.interestPaid += -cents;
      if (line.component === 'PENALTY') b.penaltyPaid += -cents;
    } else {
      if (line.component === 'PAST_INTEREST') b.interestAccrued += cents;
      if (line.component === 'PENALTY') b.penaltyAdded += cents;
    }
  }
  const openedByMonth = Object.fromEntries(span.map((m) => [m, 0]));
  for (const loan of loans) {
    const m = String(loan.createdAt).slice(0, 7);
    if (openedByMonth[m] !== undefined) openedByMonth[m] += 1;
  }
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const growthLike = (current, previous) => {
    if (previous === undefined) return { absolute: 0, percent: null };
    const absolute = r2(current - previous);
    return { absolute, percent: previous === 0 ? null : r2((absolute / Math.abs(previous)) * 100) };
  };
  const apiRows = {};
  let runningClosing = 0;
  span.forEach((m, i) => {
    const mm = monthlyCents[m];
    const b = comp[m];
    const current = {
      month: m,
      disbursed: toLak(mm?.booked ?? 0),
      moneyIn: toLak(mm?.moneyIn ?? 0),
      reversed: toLak(mm?.reversed ?? 0),
      writtenOff: toLak(mm?.writtenOff ?? 0),
      waived: toLak(mm?.waived ?? 0),
      penaltyCharged: toLak(mm?.penaltyCharged ?? 0),
      principalPaid: toLak(b.principalPaid),
      interestPaid: toLak(b.interestPaid),
      penaltyPaid: toLak(b.penaltyPaid),
      interestAccrued: toLak(b.interestAccrued),
      penaltyAdded: toLak(b.penaltyAdded),
      outstandingDelta: toLak(b.outstandingDelta),
      loansOpened: openedByMonth[m],
      transactions: mm?.transactions ?? 0,
    };
    runningClosing = r2(runningClosing + current.outstandingDelta);
    current.closingOutstanding = runningClosing;
    current.collected = r2(current.moneyIn - current.reversed);
    const prev = i > 0 ? apiRows[span[i - 1]] : undefined;
    const lastYear = i >= 12 ? apiRows[span[i - 12]] : undefined;
    current.mom = {
      collected: growthLike(current.collected, prev?.collected),
      disbursed: growthLike(current.disbursed, prev?.disbursed),
      outstanding: growthLike(current.closingOutstanding, prev?.closingOutstanding),
    };
    current.yoy = {
      collected: growthLike(current.collected, lastYear?.collected),
      disbursed: growthLike(current.disbursed, lastYear?.disbursed),
      outstanding: growthLike(current.closingOutstanding, lastYear?.closingOutstanding),
    };
    apiRows[m] = current;
  });

  const collectedCents = months.map((m) => monthlyCents[m].collected);
  const disbursedCents = months.map((m) => monthlyCents[m].booked);
  const outstandingCents = months.map((m) => toCents(closingOutstandingByMonth[m]));

  const comparisons = {};
  const compare = (series, i, offset) => {
    if (offset === null) return { absolute: 0, percent: null };
    const g = growth(series[i], series[i - offset]);
    return { absolute: toLak(g.absolute), percent: g.percent };
  };
  months.forEach((m, i) => {
    const prev = i > 0 ? 1 : null;
    const yoy = i >= 12 ? 12 : null;
    comparisons[m] = {
      collected: { mom: compare(collectedCents, i, prev), yoy: compare(collectedCents, i, yoy) },
      disbursed: { mom: compare(disbursedCents, i, prev), yoy: compare(disbursedCents, i, yoy) },
      outstanding: { mom: compare(outstandingCents, i, prev), yoy: compare(outstandingCents, i, yoy) },
    };
  });

  const loanBook = rows.loans.reduce((s, l) => s + toCents(l.currentOutstanding), 0);
  const ledger = Object.values(states).reduce((s, st) => s + totalOf(st.components), 0);

  // The window the report endpoint returns for ?months=N, assembled the way the endpoint does it.
  const reportWindow = (count) => {
    const list = [];
    for (let back = count - 1; back >= 0; back -= 1) {
      const idx = Number(TO_MONTH.slice(0, 4)) * 12 + Number(TO_MONTH.slice(5, 7)) - 1 - back;
      list.push(`${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}`);
    }
    const rowsW = list.map((m) => apiRows[m] ?? null);
    const totals = rowsW.reduce(
      (a, r) => ({
        disbursed: r2(a.disbursed + r.disbursed),
        moneyIn: r2(a.moneyIn + r.moneyIn),
        reversed: r2(a.reversed + r.reversed),
        collected: r2(a.collected + r.collected),
        interestPaid: r2(a.interestPaid + r.interestPaid),
        penaltyPaid: r2(a.penaltyPaid + r.penaltyPaid),
        writtenOff: r2(a.writtenOff + r.writtenOff),
        loansOpened: a.loansOpened + r.loansOpened,
      }),
      { disbursed: 0, moneyIn: 0, reversed: 0, collected: 0, interestPaid: 0, penaltyPaid: 0, writtenOff: 0, loansOpened: 0 },
    );
    return {
      from: list[0],
      to: TO_MONTH,
      months: count,
      openingOutstanding: r2(rowsW[0].closingOutstanding - rowsW[0].outstandingDelta),
      closingOutstanding: rowsW.at(-1).closingOutstanding,
      loanBookOutstanding: toLak(loanBook),
      rows: rowsW,
      totals,
    };
  };

  const expected = {
    meta: { seed, referenceNow: nowIso, from: FROM_MONTH, to: TO_MONTH, currency: 'LAK', generatedBy: 'scripts/test/oracle.mjs' },
    loans: perLoanExpected,
    monthly,
    apiRows,
    report: { months12: reportWindow(12), months6: reportWindow(6), months16: reportWindow(16) },
    closingOutstandingByMonth,
    closingOutstandingByLoan: closingByLoan,
    comparisons,
    totals: {
      disbursed: fmt(disbursedCents.reduce((a, b) => a + b, 0)),
      disbursedCash: fmt(months.reduce((a, m) => a + monthlyCents[m].disbursedCash, 0)),
      collected: fmt(collectedCents.reduce((a, b) => a + b, 0)),
      interestPaid: fmt(months.reduce((s, m) => s + monthlyCents[m].interestPaid, 0)),
      penaltyPaid: fmt(months.reduce((s, m) => s + monthlyCents[m].penaltyPaid, 0)),
      principalPaid: fmt(months.reduce((s, m) => s + monthlyCents[m].principalPaid, 0)),
      reversed: fmt(months.reduce((s, m) => s + monthlyCents[m].reversed, 0)),
      waived: fmt(months.reduce((s, m) => s + monthlyCents[m].waived, 0)),
      writtenOff: fmt(months.reduce((s, m) => s + monthlyCents[m].writtenOff, 0)),
      postedTransactions: postedTx.length,
      closingOutstanding: fmt(toCents(closingOutstandingByMonth[months.at(-1)])),
      loanBookOutstanding: fmt(loanBook),
      ledgerOutstanding: fmt(ledger),
      ledgerMatchesLoanBook: ledger === loanBook,
    },
    rowCounts: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.length])),
    credits: Object.fromEntries(
      rows.customer_credits.map((c) => [
        c.customerId,
        { balance: c.balance, ledger: rows.credit_ledger.filter((l) => l.customerId === c.customerId).map((l) => ({ type: l.type, amount: l.amount, balanceAfter: l.balanceAfter })) },
      ]),
    ),
    statuses: Object.fromEntries(rows.loans.map((l) => [l.loanNumber, l.status])),
    invariant: {
      monthsWithNoCollections: months.filter((m, i) => collectedCents[i] === 0),
      monthsWithNoDisbursements: months.filter((m, i) => disbursedCents[i] === 0),
      largestOutstandingLoan: rows.loans.slice().sort((a, b) => toCents(b.currentOutstanding) - toCents(a.currentOutstanding))[0]?.loanNumber,
      writtenOffLoans: rows.loans.filter((l) => l.status === 'WRITTEN_OFF').map((l) => l.loanNumber),
      closedLoans: rows.loans.filter((l) => l.status === 'CLOSED').map((l) => l.loanNumber),
      activeLoans: rows.loans.filter((l) => l.status === 'ACTIVE').length,
    },
  };

  return { rows, expected, users, products, customers, loans, states, settlementIds };
}

export { TEST_PASSWORD, REFERENCE_NOW, FROM_MONTH, TO_MONTH, KYC_CASES, LOAN_RECIPES };
