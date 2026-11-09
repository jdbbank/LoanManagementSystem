// 3.19 หลักฐานทางการเงิน: บัญชีธนาคารของลูกค้าพร้อมเอกสารยืนยันบัญชี (ตอนลงทะเบียน/อัปเดตข้อมูลการเงิน)
// และสลิปโอน/ใบรับเงินสดของการปล่อยกู้ (หลังอนุมัติแล้ว) พร้อมตัวเลือกว่าจะรับผ่านบัญชีหรือเงินสด
//
// Suite นี้เป็นเจ้าของทุกแถวที่มันเขียน (ลูกค้า บัญชีธนาคาร เอกสารหลักฐาน เงินกู้+ledger ช่องทางปล่อยกู้
// audit และ outbox ของ 2 event ใหม่) และลบออกทั้งหมดตอนจบ จึงรันซ้ำบนเล่มเดิมได้ นโยบาย evidence ถูก pin
// ไว้ที่ค่า shipped ของเซิร์ฟเวอร์ระหว่างรัน และคืนค่าที่พบก่อนเริ่มตอนจบ เพราะหลายเคสเปลี่ยนนโยบายเพื่อพิสูจน์กฎ
//
// ไม่มีการเรียก SMTP/SMS จริง: การแจ้งเตือนตรวจเป็นแถว notification_outbox ตาม transport=log
//
// เลขบัญชีเก็บเป็น plain text ในคอลัมน์ (ระบบต้องเอาไปเทียบ statement ย้อนหลังได้) แต่ต้อง "ออกจากเซิร์ฟเวอร์"
// ในรูปปิด 4 หลักสุดท้ายเท่านั้น -- suite นี้จึงไล่ดูทุกช่องทางที่เลขนี้จะรั่วได้: REST response,
// รายการเงินกู้, เนื้อหาอีเมล, payload, audit reason และไบนารีของเอกสาร
//
// มี 2 เคสที่ตั้งใจให้แดงเพื่อบันทึกข้อสังเกต (ห้ามแก้กฎที่ล็อกไว้เพื่อให้เทสต์ผ่าน จึงรายงานแทนการแก้):
//   F-EVD-1 -- normalizeAccountNumber แค่ยุบช่องว่างเป็นหนึ่งตัว ไม่ได้ลบออก "5 5 0..." กับ "550..." จึงลงทะเบียนซ้ำกันได้
//   F-EVD-2 -- maskAccountNumber คืนค่าทั้งเส้นเมื่อเลขยาวไม่เกิน 4 หลัก ซึ่งขัดกับสัญญา "แสดงเฉพาะ 4 หลักสุดท้าย"
// ข้อสังเกตที่ไม่ได้แดงไว้ (แก้ฝั่งเทสต์แทน เพราะพฤติกรรมเซิร์ฟเวอร์ถูกต้องแล้ว):
//   F-EVD-3 -- แถว outbox ของ CUSTOMER_REGISTERED ที่ส่งถึงพนักงานมี customerId เป็น NULL (emitter ใส่มันเฉพาะผู้รับที่เป็นลูกค้า)
//              จึงย้อนหา "อีเมลฉบับนี้เรื่องลูกค้าคนไหน" จากคอลัมน์ไม่ได้ suite ต้องกวาดด้วยช่วงเวลาการรันแทน
import { readFileSync } from 'node:fs';
import {
  ROOT,
  api as http,
  check,
  errorMessage,
  payloadOf,
  pinPolicies,
  rows,
  settle,
  statusCheck,
  unseal,
  utcSql,
} from '../lib/harness.mjs';
import { fakeImageBytes, jpegBytes, multipartWithFields, pngBytes, webpBytes } from '../lib/files.mjs';

const CAT = 'evidence';
const EV = 'E2E Evidence';
const NOT_A_UUID = 'evidence-not-a-uuid';
const PRINCIPAL = 3_000_000;
const EVIDENCE_TYPES = ['CUSTOMER_BANK_ACCOUNT_REGISTERED', 'LOAN_DISBURSEMENT_EVIDENCE_UPLOADED'];
/** ชื่อไฟล์ที่ suite นี้เป็นคนอัปใต้เงินกู้จริง — ใช้ตรวจว่า payload fileName มาจากการอัปโหลด ไม่ใช่ค่าที่แต่งขึ้น */
const UPLOADED_SLIPS = new Set(['evidence.png', 'slip.jpg', 'webp-slip.webp']);

const num = (v) => Number(v ?? 0);
const day = (v) => String(v ?? '').slice(0, 10);
const stamp = (isoDay) => `${isoDay}T00:00:00.000Z`;
const today = () => day(new Date().toISOString());
const lower = (list) => list.map((e) => String(e).toLowerCase()).sort();

/**
 * ค่า label ที่เซิร์ฟเวอร์ใช้แสดงในอีเมล อ่านจาก source ตรง ๆ แทนที่จะคัดลอกมาอีกที่หนึ่ง
 * (แบบเดียวกับที่ suite 11 อ่านรายการ code จาก DEFAULT_TEMPLATES) มิฉะนั้นเทสต์จะเขียวทั้งที่
 * ข้อความในอีเมลถูกแก้ไปแล้ว
 */
const EVENTS_SRC = readFileSync(`${ROOT}server/src/services/notification-events.service.ts`, 'utf8');
const CHANNEL_LABEL = Object.fromEntries(
  [...EVENTS_SRC.matchAll(/\[DisbursementChannel\.(\w+)\]:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]),
);
const NOT_RECORDED = /const NOT_RECORDED = '([^']+)'/.exec(EVENTS_SRC)?.[1] ?? '';

/** เลขบัญชี 12 หลักที่กำหนดได้ + หน้ากากที่ควรเห็น (กฎฝั่งเซิร์ฟเวอร์: '*' เท่าจำนวนหลักที่ไม่ใช่ 4 หลักท้าย) */
const accountNo = (n) => `55${String(n).padStart(10, '0')}`;
const maskOf = (raw) => {
  const compact = String(raw).replace(/\s+/g, '');
  if (compact.length <= 4) return compact;
  return `${'*'.repeat(Math.min(compact.length - 4, 12))}${compact.slice(-4)}`;
};

/** placeholder ทั้งหมดที่เทมเพลตใช้อ่านได้จากข้อความจริง */
const placeholdersOf = (t) =>
  [
    ...new Set(
      `${t?.subject ?? ''}\n${t?.bodyHtml ?? ''}\n${t?.bodyText ?? ''}`.match(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g) ?? [],
    ),
  ]
    .map((m) => m.replace(/[{}]/g, '').trim())
    .sort();

/** เนื้อหาอีเมลเก็บแบบ sealed -- ต้องเปิดก่อนจึงจะตรวจได้ว่าไม่มีเลขบัญชีเต็มเส้นหลุดไป */
const mailText = (row) => `${unseal(row.subject)}\n${unseal(row.bodyHtml)}\n${unseal(row.bodyText)}`;

/** ชุดหลักฐาน KYC ครบตาม policy shipped (ต้องใช้เพื่อผ่านประตูปล่อยกู้) */
const KYC_DOCS = [
  ['NATIONAL_ID', 'id-card.png', 'image/png', { issuedAt: '2022-03-09', expiresAt: '2028-03-09' }],
  ['SELFIE_WITH_ID', 'selfie.jpg', 'image/jpeg', {}],
  ['SIGNATURE', 'signature.png', 'image/png', {}],
];

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  // ctx.api ใส่ token admin ให้เมื่อไม่ระบุ -- เคสที่อยากทดสอบ "ไม่ล็อกอิน" ต้องส่ง token:null ตรง ๆ
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));

  // ต้องจับเวลาก่อน pin นโยบาย มิฉะนั้น audit row ของการ pin จะตกค้างนอกหน้าต่างที่ purge ใช้กวาด
  const STARTED_AT = Date.now();

  const products = (await api('GET', '/api/loan-products')).json.products ?? [];
  const P = products.find((p) => p.code === 'TST-FLAT-M12');
  if (!P) throw new Error('product TST-FLAT-M12 is missing from the seeded book');

  const pins = await pinPolicies(api, ['evidence']);
  const shippedPolicy = pins.defaults.evidence;

  const TABLES = [
    'customers',
    'loans',
    'customer_bank_accounts',
    'evidence_documents',
    'evidence_document_contents',
    'kyc_documents',
    'kyc_document_contents',
    'financial_transactions',
    'financial_transaction_lines',
    'notification_outbox',
    'audit_logs',
  ];
  /** จำนวนแถวต้องจับหลัง purge ครั้งแรกเท่านั้น มิฉะนั้นเศษจากการรันครั้งที่ crash จะถูกนับเป็น baseline */
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
  const emailOf = (username) =>
    rows(conn, 'SELECT email FROM users WHERE username = ?', [username]).then((r) => String(r[0]?.email ?? '').toLowerCase());

  /**
   * ทุกอย่างที่ suite นี้เขียนผูกกับลูกค้าที่มันสร้าง (ชื่อขึ้นต้นด้วย marker เดียวกัน) จึงไล่ลบจากตารางลูก
   * ก่อน (contents -> documents -> accounts -> ledger/outbox/audit -> loans -> KYC -> customers) และเก็บแถว
   * ของการรันครั้งก่อนที่ crash ทิ้งไว้ด้วย; 2 event ใหม่มีเฉพาะ suite นี้เป็นผู้เขียน จึงกวาดตาม type ได้ตรง ๆ
   */
  const purge = async () => {
    const custIds = (await rows(conn, 'SELECT id FROM customers WHERE fullName LIKE ?', [`${EV}%`])).map((r) => r.id);
    // CUSTOMER_REGISTERED ที่ถึงพนักงานไม่มี customerId (F-EVD-3) จึงกวาดตามช่วงเวลาของการรันแบบนี้ (เดียวกับ audit CONFIG_UPDATED)
    const staffMails = "DELETE FROM notification_outbox WHERE type = 'CUSTOMER_REGISTERED' AND customerId IS NULL AND createdAt >= ?";
    if (!custIds.length) {
      await conn.query('DELETE FROM notification_outbox WHERE type IN (?)', [EVIDENCE_TYPES]);
      await conn.query(staffMails, [utcSql(STARTED_AT)]);
      await conn.query("DELETE FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND createdAt >= ?", [utcSql(STARTED_AT)]);
      return;
    }
    const loanIds = (await rows(conn, 'SELECT id FROM loans WHERE customerId IN (?)', [custIds])).map((r) => r.id);
    const docWhere = loanIds.length
      ? ["(ownerType = 'CUSTOMER' AND ownerId IN (?)) OR (ownerType = 'LOAN' AND ownerId IN (?))", [custIds, loanIds]]
      : ["ownerType = 'CUSTOMER' AND ownerId IN (?)", [custIds]];
    const docIds = (await rows(conn, `SELECT id FROM evidence_documents WHERE ${docWhere[0]}`, docWhere[1])).map((r) => r.id);
    if (docIds.length) {
      await conn.query('DELETE FROM evidence_document_contents WHERE documentId IN (?)', [docIds]);
      await conn.query('DELETE FROM evidence_documents WHERE id IN (?)', [docIds]);
    }
    await conn.query('DELETE FROM customer_bank_accounts WHERE customerId IN (?)', [custIds]);
    if (loanIds.length) {
      await conn.query(
        'DELETE FROM financial_transaction_lines WHERE transactionId IN (SELECT id FROM financial_transactions WHERE loanId IN (?))',
        [loanIds],
      );
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [loanIds]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [loanIds]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [loanIds]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [loanIds]);
    }
    // การแจ้ง CREATED/KYC ของลูกค้าที่ suite นี้สร้างไม่ใช่ 2 event ใหม่ จึงเก็บด้วย customerId ไม่ใช่ type
    await conn.query('DELETE FROM notification_outbox WHERE customerId IN (?)', [custIds]);
    await conn.query(staffMails, [utcSql(STARTED_AT)]);
    await conn.query('DELETE FROM notification_outbox WHERE type IN (?)', [EVIDENCE_TYPES]);
    await conn.query(
      'DELETE FROM kyc_document_contents WHERE documentId IN (SELECT id FROM kyc_documents WHERE customerId IN (?))',
      [custIds],
    );
    await conn.query('DELETE FROM kyc_documents WHERE customerId IN (?)', [custIds]);
    await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [custIds]);
    await conn.query('DELETE FROM audit_logs WHERE customerId IN (?)', [custIds]);
    await conn.query('DELETE FROM customers WHERE id IN (?)', [custIds]);
    await conn.query("DELETE FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND createdAt >= ?", [utcSql(STARTED_AT)]);
  };

  // ------------------------------------------------------------------ builders
  let seq = 0;
  const newCustomer = async (label) => {
    seq += 1;
    const res = await api('POST', '/api/customers', {
      token: tokens.op1,
      body: {
        fullName: `${EV} ${label}`,
        phone: `0209${String(77000 + seq)}`,
        email: `e2e.evidence.${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@test.local`,
        nationalId: `E2EVF-${String(seq).padStart(3, '0')}`,
        address: 'Test address, Vientiane',
      },
    });
    if (res.status !== 201) throw new Error(`customer ${label}: ${res.status} ${errorMessage(res)}`);
    return res.json.customer;
  };

  /** upload ครบชุด + submit + ให้ CHECKER ตรวจ (ใช้ตอน setup เท่านั้น เพื่อให้ปล่อยกู้ได้) */
  const verifyKyc = async (customer, seed) => {
    const base = `/api/customers/${customer.id}/kyc`;
    for (const [index, [documentType, filename, type, extra]] of KYC_DOCS.entries()) {
      const buffer = documentType === 'SELFIE_WITH_ID' ? jpegBytes(seed + index) : pngBytes(seed + index);
      const res = await api('POST', `${base}/documents`, {
        token: tokens.op1,
        form: multipartWithFields(buffer, { documentType, ...extra }, { filename, type }),
      });
      if (res.status !== 201) throw new Error(`kyc upload ${documentType}: ${res.status} ${errorMessage(res)}`);
    }
    const submitted = await api('POST', `${base}/submit`, { token: tokens.op1, body: {} });
    if (submitted.status !== 200) throw new Error(`kyc submit: ${submitted.status} ${errorMessage(submitted)}`);
    const verified = await api('POST', `${base}/verify`, { token: tokens.checker2, body: { note: 'e2e evidence setup' } });
    if (verified.status !== 200) throw new Error(`kyc verify: ${verified.status} ${errorMessage(verified)}`);
  };

  const newLoan = async ({ customer, label, disbursedAt = today(), extra = {}, token = tokens.op1 }) => {
    const res = await api('POST', '/api/loans', {
      token,
      body: {
        customerId: customer.id,
        productId: P.id,
        principalAmount: PRINCIPAL,
        termValue: P.termValue,
        termUnit: P.termUnit,
        disbursedAt: stamp(disbursedAt),
        note: `${EV} ${label}`,
        ...extra,
      },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    return { id: res.json.data.loan.id, loanNumber: res.json.data.loan.loanNumber, disbursement: res.json.data.disbursement };
  };

  // ------------------------------------------------------------------ endpoint wrappers
  const bankBase = (customerId) => `/api/customers/${customerId}/bank-accounts`;
  const registerBank = (customerId, body, token = tokens.op1) => api('POST', bankBase(customerId), { token, body });
  const listBank = (customerId, query = '') => api('GET', `${bankBase(customerId)}${query}`).then((r) => r.json?.data ?? null);
  const closeBank = (customerId, accountId, body, token = tokens.head) =>
    api('POST', `${bankBase(customerId)}/${accountId}/close`, { token, body });
  const primaryBank = (customerId, accountId, token = tokens.op1) =>
    api('POST', `${bankBase(customerId)}/${accountId}/primary`, { token, body: {} });

  const evidenceBase = (kind, id) => `/api/${kind}/${id}/evidence`; // kind: 'customers' | 'loans'
  const listEvidence = (kind, id, query = '') => api('GET', `${evidenceBase(kind, id)}${query}`).then((r) => r.json?.data ?? null);
  const uploadEvidence = (kind, id, buffer, fields, { filename = 'evidence.png', type = 'image/png', token = tokens.op1 } = {}) =>
    api('POST', evidenceBase(kind, id), { token, form: multipartWithFields(buffer, fields, { filename, type }) });
  const deleteEvidenceCall = (kind, id, documentId, token = tokens.op1) =>
    api('DELETE', `${evidenceBase(kind, id)}/${documentId}`, { token });
  const contentOf = (kind, id, documentId, token = tokens.op1) =>
    api('GET', `${evidenceBase(kind, id)}/${documentId}/content`, { token, binary: true });

  const patchDisbursement = (loanId, body, token = tokens.op1) => api('PATCH', `/api/loans/${loanId}/disbursement`, { token, body });
  const loanDetail = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data ?? null;

  /** แถว outbox ของ 2 event ใหม่ ซึ่ง payload ถูก seal ไว้จึงเปิดผ่าน payloadOf ก่อนเสมอ */
  const outboxRows = async (type, { loanId = null, customerId = null } = {}) => {
    const where = ['type = ?'];
    const params = [type];
    if (loanId) {
      where.push('loanId = ?');
      params.push(loanId);
    }
    if (customerId) {
      where.push('customerId = ?');
      params.push(customerId);
    }
    const found = await rows(
      conn,
      `SELECT id, type, status, subject, recipientEmail, recipientName, bodyHtml, bodyText, payload, customerId, loanId, userId
         FROM notification_outbox WHERE ${where.join(' AND ')} ORDER BY recipientEmail`,
      params,
    );
    return found.map((r) => ({ ...r, payload: payloadOf(r), text: mailText(r) }));
  };

  try {
    await purge();
    baseline = await captureBaseline();

    const custA = await newCustomer('A-ACCOUNTS');
    const custB = await newCustomer('B-OTHER');
    const custD = await newCustomer('D-ACTOR');
    await verifyKyc(custA, 1);
    await verifyKyc(custB, 5);

    // ================================================== A. นโยบายหลักฐานผ่าน /api/config/evidence
    const cfg = await api('GET', '/api/config/evidence');
    statusCheck(CAT, 'GET /api/config/evidence ตอบ 200', cfg, 200, { input: 'GET /api/config/evidence' });
    const cfgData = cfg.json?.data ?? {};
    const livePolicy = cfgData.policy ?? {};
    check(CAT, 'config คืน policy + defaults + checksum ครบทั้ง 3 ช่อง และ policy มี 4 กุญแจ', {
      input: 'data keys',
      expected: '{policy, defaults, checksum} + maxFileSizeKb/maxFilesPerRequest/allowedMimeTypes/maxTotalBytesPerOwner',
      actual: `${JSON.stringify(Object.keys(cfgData))} policy=${JSON.stringify(livePolicy)}`,
      pass:
        ['policy', 'defaults', 'checksum'].every((k) => cfgData[k] !== undefined) &&
        ['maxFileSizeKb', 'maxFilesPerRequest', 'allowedMimeTypes', 'maxTotalBytesPerOwner'].every(
          (k) => livePolicy[k] !== undefined && livePolicy[k] !== null,
        ),
    });
    check(CAT, 'ค่าที่ pin ไว้ตรงกับ shipped defaults (ไม่ค้างจาก suite ก่อนหน้า)', {
      input: 'policy vs defaults',
      expected: JSON.stringify(shippedPolicy),
      actual: JSON.stringify(livePolicy),
      pass: JSON.stringify(livePolicy) === JSON.stringify(shippedPolicy),
    });
    check(CAT, 'ประเภทไฟล์ที่อนุญาตมีแต่ image/* ที่ sniffer จำได้จริง', {
      input: 'allowedMimeTypes',
      expected: 'ทุกตัวขึ้นต้น image/ และไม่ซ้ำกัน',
      actual: JSON.stringify(livePolicy.allowedMimeTypes),
      pass:
        Array.isArray(livePolicy.allowedMimeTypes) &&
        livePolicy.allowedMimeTypes.length > 0 &&
        livePolicy.allowedMimeTypes.every((m) => m.startsWith('image/')) &&
        new Set(livePolicy.allowedMimeTypes).size === livePolicy.allowedMimeTypes.length,
    });
    check(CAT, 'โควตาต่อเจ้าของต้องอย่างน้อยเท่าขนาดภาพ 1 ภาพ (กันตั้งค่าที่อัปโหลดอะไรไม่ได้เลย)', {
      input: 'maxTotalBytesPerOwner vs maxFileSizeKb',
      expected: '>= maxFileSizeKb * 1024',
      actual: `${livePolicy.maxTotalBytesPerOwner} vs ${num(livePolicy.maxFileSizeKb) * 1024}`,
      pass: num(livePolicy.maxTotalBytesPerOwner) >= num(livePolicy.maxFileSizeKb) * 1024,
    });

    statusCheck(CAT, 'MAKER แก้ นโยบายหลักฐานไม่ได้: 403', await api('PUT', '/api/config/evidence', { token: tokens.op1, body: { maxFileSizeKb: 64 } }), 403, {
      input: 'PUT /api/config/evidence ด้วย test_op1',
      messageIncludes: 'Requires role',
    });
    statusCheck(CAT, 'VIEWER แก้ นโยบายหลักฐานไม่ได้: 403', await api('PUT', '/api/config/evidence', { token: tokens.viewer, body: { maxFileSizeKb: 64 } }), 403, {
      input: 'PUT /api/config/evidence ด้วย test_view1',
    });
    statusCheck(CAT, 'ไม่ส่ง token อ่านนโยบายไม่ได้: 401', await api('GET', '/api/config/evidence', { token: null }), 401, {
      input: 'GET /api/config/evidence anonymous',
    });
    statusCheck(CAT, 'maxFileSizeKb = 0 ต้องตกที่ validation: 400', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { maxFileSizeKb: 0 } }), 400, {
      input: 'PUT {maxFileSizeKb:0}',
    });
    statusCheck(CAT, 'maxFileSizeKb เกินเพดานของระบบ: 400', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { maxFileSizeKb: 102_401 } }), 400, {
      input: 'PUT {maxFileSizeKb:102401}',
    });
    statusCheck(CAT, 'ปิดประเภทไฟล์ให้เหลือศูนย์: 400 (schema ห้าม array ว่าง)', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { allowedMimeTypes: [] } }), 400, {
      input: 'PUT {allowedMimeTypes:[]}',
    });
    statusCheck(
      CAT,
      'โควตาน้อยกว่าขนาดภาพ 1 ภาพ: 422 (assertPolicyMakesSense ไม่ใช่ validation รูปทรง)',
      await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { maxFileSizeKb: 64, maxTotalBytesPerOwner: 1024 } }),
      422,
      { input: 'PUT {maxFileSizeKb:64, maxTotalBytesPerOwner:1024}', messageIncludes: 'maxTotalBytesPerOwner' },
    );
    const policyAfterBadPut = (await api('GET', '/api/config/evidence')).json?.data?.policy;
    check(CAT, 'PUT ที่ถูกปฏิเสธไม่เปลี่ยนค่าที่ใช้งานอยู่ (validate ก่อนเขียน system_config)', {
      input: 'policy หลัง 422',
      expected: JSON.stringify(shippedPolicy),
      actual: JSON.stringify(policyAfterBadPut),
      pass: JSON.stringify(policyAfterBadPut) === JSON.stringify(shippedPolicy),
    });
    statusCheck(
      CAT,
      'ส่งประเภทไฟล์ที่ sniffer ไม่รู้จัก (image/gif): 422',
      await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { allowedMimeTypes: ['image/gif'] } }),
      422,
      { input: 'PUT {allowedMimeTypes:["image/gif"]}', messageIncludes: 'Only image uploads are supported' },
    );

    const patched = await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { maxFilesPerRequest: 3 } });
    statusCheck(CAT, 'แก้ นโยบายจริงตอบ 200 + คืนค่าใหม่', patched, 200);
    check(CAT, 'checksum เปลี่ยนเมื่อนโยบายเปลี่ยน (audit เก็บ checksum ไม่ใช่ข้อความดิบ)', {
      input: 'checksum ก่อน vs หลัง PUT {maxFilesPerRequest:3}',
      expected: 'คนละค่ากัน',
      actual: `${cfgData.checksum} -> ${patched.json?.data?.checksum}`,
      pass: !!patched.json?.data?.checksum && patched.json.data.checksum !== cfgData.checksum,
    });
    const configAudit = await rows(
      conn,
      "SELECT reason FROM audit_logs WHERE action = 'CONFIG_UPDATED' AND createdAt >= ? ORDER BY createdAt DESC LIMIT 1",
      [utcSql(STARTED_AT)],
    );
    check(CAT, 'audit CONFIG_UPDATED ของนโยบายหลักฐานบรรยายก่อน/หลังแบบย่อ', {
      input: 'audit reason ล่าสุด',
      expected: 'reason มี files<=, quota= และลูกศร ->',
      actual: configAudit[0]?.reason ?? '(ไม่มีแถว)',
      pass: /files<=/.test(configAudit[0]?.reason ?? '') && /->/.test(configAudit[0]?.reason ?? ''),
    });
    statusCheck(CAT, 'คืนนโยบายเป็น shipped defaults: 200', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: shippedPolicy }), 200);

    // ================================================== B. บันทึกรับบัญชีธนาคารของลูกค้า
    const acc1 = accountNo(1);
    const registered = await registerBank(custA.id, {
      bankName: 'BCEL',
      accountNumber: acc1,
      accountHolderName: custA.fullName,
      branch: 'Chanthabouly',
      note: 'proof of account pending',
    });
    statusCheck(CAT, 'MAKER ลงทะเบียนบัญชีครั้งแรก: 201', registered, 201, { input: `POST ${bankBase(custA.id)}` });
    const accView = registered.json?.data ?? {};
    check(CAT, 'response ตอบกลับเป็นเลขแบบปิด mask ไม่ใช่เลขทั้งเส้น', {
      input: `accountNumber = ${acc1}`,
      expected: maskOf(acc1),
      actual: accView.accountNumber,
      pass: accView.accountNumber === maskOf(acc1),
      note: 'เก็บ plain text ในคอลัมน์เพื่อเทียบ statement ย้อนหลังได้ แต่ห้ามหลุดออก response',
    });
    check(CAT, 'บัญชีแรกของลูกค้ากลายเป็น primary อัตโนมัติ + สถานะ ACTIVE', {
      input: 'data.isPrimary/status',
      expected: 'isPrimary true, status ACTIVE',
      actual: `${accView.isPrimary}/${accView.status}`,
      pass: accView.isPrimary === true && accView.status === 'ACTIVE',
    });

    const storedRaw = await rows(conn, 'SELECT accountNumber, isPrimary, status FROM customer_bank_accounts WHERE id = ?', [accView.id]);
    check(CAT, 'ในฐานข้อมูลยังเก็บเลขจริงไว้ และคอลัมน์อื่นตรงตามที่ส่ง', {
      input: 'customer_bank_accounts row',
      expected: `${acc1}, isPrimary 1, ACTIVE`,
      actual: `${storedRaw[0]?.accountNumber}, isPrimary ${storedRaw[0]?.isPrimary}, ${storedRaw[0]?.status}`,
      pass: storedRaw[0]?.accountNumber === acc1 && num(storedRaw[0]?.isPrimary) === 1 && storedRaw[0]?.status === 'ACTIVE',
    });

    const dup = await registerBank(custA.id, { bankName: 'BCEL', accountNumber: acc1, accountHolderName: custA.fullName });
    statusCheck(CAT, 'เลขเดียวกันลงทะเบียนซ้ำ: 409', dup, 409, {
      input: `POST ${bankBase(custA.id)} ซ้ำเลขเดิม`,
      messageIncludes: 'already registered',
    });

    const spacedNo = acc1.split('').join(' ');
    const spaced = await registerBank(custA.id, { bankName: 'BCEL', accountNumber: spacedNo, accountHolderName: custA.fullName });
    check(CAT, 'F-EVD-1: เลขเดียวกันที่คั่นด้วยช่องว่างต้องถือว่าซ้ำ (409) -- กันบัญชีเดียวเป็นสองแถว', {
      input: `accountNumber "${spacedNo}" เทียบกับ "${acc1}"`,
      expected: 'HTTP 409',
      actual: `HTTP ${spaced.status} ${errorMessage(spaced)}`,
      pass: spaced.status === 409,
      note:
        'normalizeAccountNumber (server/src/services/bank-account.service.ts) ใช้ raw.replace(/\\s+/g, " ").trim() ซึ่งแค่ยุบช่องว่างหลายตัวเหลือหนึ่งตัว ไม่ได้ลบออก ' +
        'ทั้งที่ comment ของฟังก์ชันเขียนว่า "Whitespace-insensitive so 1 2 3 4 and 1234 cannot be filed as two accounts" -- ผลคือ UNIQUE (customerId, accountNumber) กันไม่อยู่ ' +
        'ลูกค้าหนึ่งคนมีสองแถวที่เลขเส้นเดียวกันคนละรูปแบบพิมพ์ และ mask ของทั้งสองแถวเหมือนกันสนิท จึงเลือกผิดแถวได้เงียบ ๆ ' +
        'ทางแก้คือ replace(/\\s+/g, "") แต่มีผลกับข้อมูลที่ลงทะเบียนไว้แล้ว จึงรายงานไว้ก่อนไม่ได้แก้เอง',
    });
    if (spaced.status === 201) {
      const both = await rows(conn, 'SELECT id, accountNumber FROM customer_bank_accounts WHERE customerId = ?', [custA.id]);
      check(CAT, 'หลักฐานของ F-EVD-1: สองแถวที่เลขต่างกันเฉพาะช่องว่างถูกเก็บไว้จริง', {
        input: 'customer_bank_accounts rows ของ custA',
        expected: '1 แถว (ถ้า normalize ลบช่องว่างออก)',
        actual: `${both.length} แถว: ${both.map((b) => b.accountNumber).join(' | ')}`,
        pass: both.length === 1,
        note: 'เคสนี้แดงตามเจตนา -- ใช้ยืนยันว่าบั๊กไม่ใช่แค่การอ่านโค้ด',
      });
      await conn.query('DELETE FROM customer_bank_accounts WHERE id = ?', [spaced.json?.data?.id]);
    }

    const otherSame = await registerBank(custB.id, { bankName: 'KBDB', accountNumber: acc1, accountHolderName: custB.fullName });
    statusCheck(CAT, 'ลูกค้าอีกคนใช้เลขเดียวกันได้ (unique ผูกกับเจ้าของ): 201', otherSame, 201, {
      input: `POST ${bankBase(custB.id)} เลขเดียวกับ custA`,
    });

    const short = await registerBank(custB.id, { bankName: 'Short Bank', accountNumber: '1234', accountHolderName: custB.fullName });
    statusCheck(CAT, 'บัญชี 4 หลักผ่านการรับข้อมูล (min 4): 201', short, 201);
    check(CAT, 'F-EVD-2: เลขบัญชีทุกหลักต้องถูก mask แม้เส้นสั้นมาก', {
      input: 'accountNumber "1234"',
      expected: 'มีเครื่องหมายปิด mask นำหน้า (ไม่แสดงเลขทั้งเส้น)',
      actual: short.json?.data?.accountNumber,
      pass: String(short.json?.data?.accountNumber ?? '').includes('*'),
      note:
        'maskAccountNumber คืน compact ทั้งเส้นเมื่อ length <= 4 -- เลขธนาคารจริงยาวกว่านี้เสมอ แต่ input ที่ validator รับไว้ (min 4) ' +
        'กลับ "แสดงทั้งหมด" ขัดกับสัญญา "เหลือ 4 หลักสุดท้าย" จึงรายงานเป็นข้อสังเกตความปลอดภัย ไม่ได้แก้กฎ',
    });
    await conn.query('DELETE FROM customer_bank_accounts WHERE id = ?', [short.json?.data?.id]);

    statusCheck(CAT, 'ส่งเลขสั้นกว่า 4 หลัก: 400', await registerBank(custA.id, { bankName: 'TTB', accountNumber: '123', accountHolderName: 'Someone Test' }), 400, {
      input: 'POST {accountNumber:"123"}',
    });
    statusCheck(CAT, 'ชื่อเจ้าของบัญชีว่าง: 400', await registerBank(custA.id, { bankName: 'TTB', accountNumber: accountNo(9), accountHolderName: '' }), 400, {
      input: 'POST {accountHolderName:""}',
    });
    statusCheck(CAT, 'ลงทะเบียนที่ลูกค้าไม่มีอยู่จริง: 404', await registerBank(NOT_A_UUID, { bankName: 'XO', accountNumber: accountNo(2), accountHolderName: 'Someone Test' }), 404, {
      input: `POST /api/customers/${NOT_A_UUID}/bank-accounts`,
      note: 'ต้องการ 404 ไม่ใช่ 500 -- customerId แบบไม่ใช่ uuid ต้องไม่ทำให้ query ระเบิด',
    });
    statusCheck(CAT, 'VIEWER ลงทะเบียนบัญชี: 403', await registerBank(custA.id, { bankName: 'BCL', accountNumber: accountNo(3), accountHolderName: 'Someone Test' }, tokens.viewer), 403, {
      input: 'POST bank-accounts ด้วย test_view1',
    });
    statusCheck(CAT, 'ไม่ล็อกอินอ่านรายการบัญชี: 401', await api('GET', bankBase(custA.id), { token: null }), 401, {
      input: 'GET bank-accounts anonymous',
    });

    const listA = await listBank(custA.id);
    check(CAT, 'GET รายการบัญชีซ่อนเลขทุกแถวและคืน summary ลูกค้า', {
      input: `GET ${bankBase(custA.id)}`,
      expected: `ทุก accountNumber มี mask, JSON ทั้งก้อนไม่มี "${acc1}"`,
      actual: `${JSON.stringify((listA?.accounts ?? []).map((a) => a.accountNumber))} contains=${JSON.stringify(listA).includes(acc1)}`,
      pass:
        !!listA?.customer?.customerNumber &&
        (listA?.accounts ?? []).length > 0 &&
        (listA?.accounts ?? []).every((a) => String(a.accountNumber).includes('*')) &&
        !JSON.stringify(listA).includes(acc1),
    });
    check(CAT, 'primary ขึ้นก่อนแล้วตามด้วยลำดับที่สร้าง (UI เลือกบัญชี default จากแถวแรกได้)', {
      input: 'ลำดับ rows ของ custA',
      expected: 'ACTIVE+isPrimary เป็นแถวแรก',
      actual: (listA?.accounts ?? []).map((a) => `${a.bankName}:${a.status}${a.isPrimary ? '*' : ''}`).join(', '),
      pass: (listA?.accounts ?? []).filter((a) => a.status === 'ACTIVE')[0]?.isPrimary === true,
    });

    // ================================================== C. ปิดบัญชี / สลับ primary / เปิดใหม่
    const acc2 = accountNo(4);
    const second = await registerBank(custA.id, { bankName: 'ACLEDA', accountNumber: acc2, accountHolderName: custA.fullName, isPrimary: true });
    statusCheck(CAT, 'ลงทะเบียนบัญชีที่สองพร้อม isPrimary: 201', second, 201);
    const afterTwo = await listBank(custA.id);
    const primaries = (afterTwo?.accounts ?? []).filter((a) => a.isPrimary && a.status === 'ACTIVE');
    check(CAT, 'มี primary ACTIVE ได้หนึ่งแถวเท่านั้น (การสลับคือการย้าย ไม่ใช่การเพิ่ม)', {
      input: 'isPrimary rows หลังเพิ่มบัญชีที่สอง',
      expected: '1 แถว = บัญชีที่สอง',
      actual: `${primaries.length} แถว: ${primaries.map((p) => p.bankName).join(', ')}`,
      pass: primaries.length === 1 && primaries[0].id === second.json.data.id,
    });

    const acc1Id = accView.id;
    statusCheck(CAT, 'CHECKER ปิดบัญชีไม่ได้: 403 (ต้อง HEAD/ADMIN)', await closeBank(custA.id, acc1Id, { reason: 'no longer used' }, tokens.checker1), 403, {
      input: 'POST /close ด้วย test_checker1',
    });
    statusCheck(CAT, 'ปิดบัญชีโดย HEAD: 200', await closeBank(custA.id, acc1Id, { reason: 'customer moved salary account' }), 200);
    const closedActive = await listBank(custA.id, '?status=ACTIVE');
    const closedAll = await listBank(custA.id);
    check(CAT, 'บัญชีที่ปิดแล้วหลุดจาก ?status=ACTIVE และเก็บประวัติไว้เมื่อไม่กรอง', {
      input: 'GET ?status=ACTIVE vs GET ทั้งหมด',
      expected: 'ACTIVE ไม่มี BCEL / ทั้งหมด 2 แถว (1 ACTIVE + 1 CLOSED)',
      actual: `${JSON.stringify((closedActive?.accounts ?? []).map((a) => a.bankName))} / ${(closedAll?.accounts ?? []).map((a) => `${a.bankName}:${a.status}`).join(', ')}`,
      pass:
        (closedActive?.accounts ?? []).every((a) => a.bankName !== 'BCEL') &&
        (closedAll?.accounts ?? []).length === 2 &&
        (closedAll?.accounts ?? []).filter((a) => a.status === 'CLOSED').length === 1,
    });
    const closedRow = (await rows(conn, 'SELECT closedAt, closeReason, status FROM customer_bank_accounts WHERE id = ?', [acc1Id]))[0];
    check(CAT, 'ปิดบัญชีแล้วต้องปิด timestamp + เหตุผลไว้ตรวจสอบ', {
      input: 'customer_bank_accounts row ของบัญชีแรก',
      expected: 'status CLOSED, closedAt ไม่ว่าง, closeReason = เหตุผลที่ส่ง',
      actual: `${closedRow?.status}, closedAt=${closedRow?.closedAt ? 'yes' : 'NULL'}, reason="${closedRow?.closeReason}"`,
      pass: closedRow?.status === 'CLOSED' && !!closedRow?.closedAt && closedRow?.closeReason === 'customer moved salary account',
    });
    statusCheck(CAT, 'ปิดซ้ำ: 422 (ปิดได้เฉพาะ ACTIVE)', await closeBank(custA.id, acc1Id, { reason: 'again' }), 422, {
      input: 'POST /close ซ้ำ',
      messageIncludes: 'only an ACTIVE one can be closed',
    });
    statusCheck(CAT, 'ตั้งบัญชีที่ปิดแล้วเป็น primary: 422', await primaryBank(custA.id, acc1Id), 422, {
      input: 'POST /primary ของ CLOSED',
      messageIncludes: 'cannot be the primary',
    });
    statusCheck(CAT, 'ปิดบัญชีโดยไม่ส่ง reason: 400', await closeBank(custA.id, second.json.data.id, {}), 400, {
      input: 'POST /close body {}',
    });

    const reopened = await registerBank(custA.id, { bankName: 'BCEL', accountNumber: acc1, accountHolderName: custA.fullName });
    statusCheck(CAT, 'ลงทะเบียนเลขที่ "เคยปิดไปแล้ว" ใหม่: 201 (เปิดแถวเดิม ไม่ใช่ประวัติศาสตร์ซ้ำซ้อน)', reopened, 201, {
      input: 'POST bank-accounts เลขเดียวกับที่ CLOSED อยู่',
    });
    const reopenRow = await rows(conn, 'SELECT id, status, closedAt, closeReason FROM customer_bank_accounts WHERE customerId = ? AND accountNumber = ?', [custA.id, acc1]);
    check(CAT, 'การเปิดใหม่ revive แถวเดิม (id เดียวกัน) และล้าง closedAt/closeReason', {
      input: 'rows ของเลขเดิม',
      expected: '1 แถว, ACTIVE, closedAt NULL, closeReason NULL',
      actual: `${reopenRow.length} แถว ${JSON.stringify(reopenRow.map((r) => `${r.status}/${r.closedAt}/${r.closeReason}`))}`,
      pass: reopenRow.length === 1 && reopenRow[0].status === 'ACTIVE' && !reopenRow[0].closedAt && !reopenRow[0].closeReason,
    });
    statusCheck(CAT, 'ย้าย primary กลับมาที่บัญชีที่เปิดใหม่: 200', await primaryBank(custA.id, acc1Id), 200);
    const afterPrimaryMove = await listBank(custA.id);
    check(CAT, 'การย้าย primary ถอดป้ายแถวเก่าออกจริง (ไม่เหลือสองแถวพร้อมจ่าย)', {
      input: 'isPrimary rows หลัง /primary',
      expected: `1 แถว = ${accView.bankName}`,
      actual: (afterPrimaryMove?.accounts ?? []).map((a) => `${a.bankName}${a.isPrimary ? '*' : ''}`).join(', '),
      pass: (afterPrimaryMove?.accounts ?? []).filter((a) => a.isPrimary).length === 1,
    });

    const bankAudit = await rows(conn, "SELECT action FROM audit_logs WHERE customerId = ? ORDER BY createdAt", [custA.id]);
    const bankActions = [...new Set(bankAudit.map((a) => a.action))];
    check(CAT, 'audit แยก "ลงทะเบียนใหม่" กับ "เปิดบัญชีเดิม" และครอบคลุมการปิด/ย้าย primary', {
      input: 'audit action ของ custA',
      expected: 'มี BANK_ACCOUNT_REGISTERED, BANK_ACCOUNT_REOPENED, BANK_ACCOUNT_CLOSED, BANK_ACCOUNT_PRIMARY_SET',
      actual: bankActions.join(', '),
      pass: ['BANK_ACCOUNT_REGISTERED', 'BANK_ACCOUNT_REOPENED', 'BANK_ACCOUNT_CLOSED', 'BANK_ACCOUNT_PRIMARY_SET'].every((a) =>
        bankActions.includes(a),
      ),
    });
    const accountReasons = await rows(
      conn,
      "SELECT reason FROM audit_logs WHERE customerId = ? AND action LIKE 'BANK_ACCOUNT%'",
      [custA.id],
    );
    check(CAT, 'audit reason ของบัญชีแสดงเลขแบบ mask เท่านั้น', {
      input: 'reason ทุกแถว BANK_ACCOUNT*',
      expected: `มี "${maskOf(acc1)}" และไม่มี "${acc1}"`,
      actual: accountReasons.map((r) => r.reason).join(' || ') || '(ไม่มีแถว)',
      pass:
        accountReasons.length > 0 &&
        accountReasons.every((r) => !String(r.reason).includes(acc1)) &&
        accountReasons.some((r) => String(r.reason).includes(maskOf(acc1))),
    });

    // ================================================== D. เอกสารยืนยันบัญชี (BANK_ACCOUNT_PROOF)
    const proofPng = await uploadEvidence('customers', custA.id, pngBytes(3), {
      kind: 'BANK_ACCOUNT_PROOF',
      bankAccountId: acc1Id,
      note: 'bank statement page 1',
    });
    statusCheck(CAT, 'อัปโหลดภาพยืนยันบัญชี (png) ผ่าน path ของลูกค้า: 201', proofPng, 201, {
      input: `POST ${evidenceBase('customers', custA.id)}`,
    });
    const proofView = proofPng.json?.data ?? {};
    check(CAT, 'เอกสารตอบกลับมีเลขบัญชีแบบ mask + ชื่อธนาคารกำกับ', {
      input: 'data.accountNumber/bankName',
      expected: `${maskOf(acc1)} / BCEL`,
      actual: `${proofView.accountNumber} / ${proofView.bankName}`,
      pass: proofView.accountNumber === maskOf(acc1) && proofView.bankName === 'BCEL',
    });
    const proofBytesRow = await rows(conn, 'SELECT LENGTH(data) n FROM evidence_document_contents WHERE documentId = ?', [proofView.id]);
    check(CAT, 'ไบนารีถูกเก็บใน evidence_document_contents ครบเท่า sizeBytes ที่รายงาน', {
      input: 'LENGTH(data) vs data.sizeBytes',
      expected: String(proofView.sizeBytes),
      actual: String(proofBytesRow[0]?.n ?? 0),
      pass: num(proofBytesRow[0]?.n) === num(proofView.sizeBytes),
    });
    const proofMeta = await rows(conn, 'SELECT checksum, mimeType, fileName FROM evidence_documents WHERE id = ?', [proofView.id]);
    check(CAT, 'metadata เป็น sha256 hex 64 ตัว + mime ที่ดมจาก magic bytes ไม่ใช่จากชื่อไฟล์', {
      input: 'evidence_documents row',
      expected: 'checksum /^[0-9a-f]{64}$/, mimeType image/png, fileName ตามที่ส่ง',
      actual: `${proofMeta[0]?.checksum?.length ?? 0} chars ${proofMeta[0]?.mimeType} ${proofMeta[0]?.fileName}`,
      pass: /^[0-9a-f]{64}$/.test(proofMeta[0]?.checksum ?? '') && proofMeta[0]?.mimeType === 'image/png' && proofMeta[0]?.fileName === 'evidence.png',
    });

    const proofTxt = await uploadEvidence(
      'customers',
      custA.id,
      pngBytes(2),
      { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: acc1Id },
      { filename: 'statement.txt', type: 'text/plain' },
    );
    statusCheck(CAT, 'ภาพจริงที่แปะชื่อ .txt ก็รับไว้ (detection จาก magic bytes): 201', proofTxt, 201);
    check(CAT, 'mime ที่เก็บคือ image/png ไม่ใช่ text/plain', {
      input: 'data.mimeType ของ statement.txt',
      expected: 'image/png',
      actual: proofTxt.json?.data?.mimeType,
      pass: proofTxt.json?.data?.mimeType === 'image/png',
    });

    const proofJpg = await uploadEvidence(
      'customers',
      custA.id,
      jpegBytes(2),
      { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: second.json.data.id },
      { filename: 'statement.jpg', type: 'image/jpeg' },
    );
    statusCheck(CAT, 'อัปโหลด jpeg ให้บัญชีที่สอง: 201', proofJpg, 201);
    const listAfterProofs = await listBank(custA.id);
    const proofCounts = (listAfterProofs?.accounts ?? []).map((a) => `${a.bankName}:${a.proofCount}`).join(',');
    check(CAT, 'proofCount ต่อบัญชีตรงกับจำนวนเอกสารที่อ้าง bankAccountId', {
      input: 'GET bank-accounts proofCount',
      expected: 'BCEL:2, ACLEDA:1',
      actual: proofCounts,
      pass: proofCounts.includes('BCEL:2') && proofCounts.includes('ACLEDA:1'),
    });

    const custList = await listEvidence('customers', custA.id);
    check(CAT, 'GET รายการหลักฐานคืน policy + policyText ต่อท้าย (UI แสดงเงื่อนไขได้ทันที)', {
      input: 'GET evidence',
      expected: 'documents 3 แถว, policy มี 4 ช่อง, policyText มี files<=/mime=/quota=',
      actual: `${custList?.documents?.length} docs / ${custList?.policyText}`,
      pass:
        (custList?.documents ?? []).length === 3 &&
        /files<=/.test(custList?.policyText ?? '') &&
        /mime=/.test(custList?.policyText ?? '') &&
        /quota=/.test(custList?.policyText ?? ''),
    });
    check(CAT, 'ทุกแถวของรายการหลักฐานไม่มีเลขบัญชีเต็มเส้นหลุดมา', {
      input: 'JSON ของ documents',
      expected: `ไม่มี "${acc1}"`,
      actual: (custList?.documents ?? []).map((d) => d.accountNumber).join(','),
      pass: !(custList?.documents ?? []).some((d) => JSON.stringify(d).includes(acc1)),
    });
    const filtered = await listEvidence('customers', custA.id, '?kind=DISBURSEMENT_SLIP');
    check(CAT, 'กรอง ?kind= ได้ และรายการหลักฐานของลูกค้าไม่มีสลิปปน', {
      input: 'GET evidence?kind=DISBURSEMENT_SLIP',
      expected: '0 แถว (kind นี้ผูกกับ loan เท่านั้น)',
      actual: `${filtered?.documents?.length} แถว`,
      pass: (filtered?.documents ?? []).length === 0,
    });
    statusCheck(CAT, '?kind= ไม่รู้จัก: 400', await api('GET', `${evidenceBase('customers', custA.id)}?kind=PASSPORT`), 400, {
      input: 'GET evidence?kind=PASSPORT',
    });

    const content = await contentOf('customers', custA.id, proofView.id);
    check(CAT, 'GET /:documentId/content คืนภาพ inline ตาม mime ที่เก็บ + cache private', {
      input: 'GET content headers',
      expected: '200, image/png, Content-Disposition inline, Cache-Control private, ขนาดตรง sizeBytes',
      actual: `${content.status} ${content.headers['content-type']} ${content.headers['content-disposition']} ${content.headers['cache-control']} ${content.buffer?.length}B`,
      pass:
        content.status === 200 &&
        content.headers['content-type'] === 'image/png' &&
        String(content.headers['content-disposition']).startsWith('inline') &&
        String(content.headers['cache-control']).includes('private') &&
        num(content.buffer?.length) === num(proofView.sizeBytes),
    });
    const viewerRead = await contentOf('customers', custA.id, proofView.id, tokens.viewer);
    statusCheck(CAT, 'VIEWER ดูภาพหลักฐานได้: 200 (เป็นพนักงานฝ่ายอ่าน)', viewerRead, 200, {
      input: 'GET content ด้วย test_view1',
    });
    statusCheck(CAT, 'VIEWER อัปโหลดหลักฐานไม่ได้: 403', await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: acc1Id }, { token: tokens.viewer }), 403, {
      input: 'POST evidence ด้วย test_view1',
    });
    statusCheck(CAT, 'ไม่ล็อกอินอ่านรายการหลักฐาน: 401', await api('GET', evidenceBase('customers', custA.id), { token: null }), 401, {
      input: 'GET evidence anonymous',
    });

    // ================================================== E. เอกสารผิดชนิด / ผิดเจ้าของ / ผิดหลักเกณฑ์
    statusCheck(CAT, 'สลิปโอนอัปใต้ลูกค้า: 422 (kind ผูกกับ loan)', await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'DISBURSEMENT_SLIP' }), 422, {
      input: 'POST customers/:id/evidence {kind:DISBURSEMENT_SLIP}',
      messageIncludes: 'filed under a LOAN',
    });
    statusCheck(
      CAT,
      'สลิปโอนใต้ลูกค้าทั้งที่แนบบัญชี: 422 (owner ผิดก่อนเรื่องบัญชี)',
      await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'DISBURSEMENT_SLIP', bankAccountId: acc1Id }),
      422,
      { input: 'POST customers/:id/evidence {kind:DISBURSEMENT_SLIP, bankAccountId}' },
    );

    // ต้องมีเงินกู้ก่อนจึงจะทดสอบฝั่ง loan ได้
    const loanBank = await newLoan({
      customer: custA,
      label: 'LOAN-BANK',
      extra: { disbursementChannel: 'BANK', disbursementBankAccountId: acc1Id, disbursementReference: 'REF-E2E-001' },
    });
    statusCheck(
      CAT,
      'สลิปโอนอัปใต้เงินกู้โดยไม่ระบุ bankAccountId: 201 (slip ไม่ผูกกับบัญชีรายตัว)',
      await uploadEvidence('loans', loanBank.id, pngBytes(4), { kind: 'DISBURSEMENT_SLIP', note: 'transfer slip 1' }),
      201,
    );
    statusCheck(CAT, 'BANK_ACCOUNT_PROOF ใต้เงินกู้: 422 (kind ผูกกับ customer)', await uploadEvidence('loans', loanBank.id, pngBytes(2), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: acc1Id }), 422, {
      input: 'POST loans/:id/evidence {kind:BANK_ACCOUNT_PROOF}',
      messageIncludes: 'filed under a CUSTOMER',
    });
    statusCheck(CAT, 'BANK_ACCOUNT_PROOF โดยไม่ระบุ bankAccountId: 422', await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'BANK_ACCOUNT_PROOF' }), 422, {
      input: 'POST customers/:id/evidence {kind:BANK_ACCOUNT_PROOF}',
      messageIncludes: 'has to name the account',
    });
    statusCheck(
      CAT,
      'bankAccountId ของลูกค้าอื่น: 404 (ไม่เปิดเผยว่ามีอยู่จริง)',
      await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: otherSame.json.data.id }),
      404,
      { input: 'POST customers/<A>/evidence ด้วยบัญชีของ custB' },
    );
    statusCheck(CAT, 'kind ไม่รู้จักใน form field: 400 (zod enum)', await uploadEvidence('customers', custA.id, pngBytes(2), { kind: 'WEEKLY_REPORT' }), 400, {
      input: 'POST evidence {kind:WEEKLY_REPORT}',
    });
    statusCheck(
      CAT,
      'ส่ง request โดยไม่มีไฟล์: 400',
      await api('POST', evidenceBase('customers', custA.id), { token: tokens.op1, body: { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: acc1Id } }),
      400,
      { input: 'POST evidence JSON ไม่มี multipart file', messageIncludes: 'No file received' },
    );
    statusCheck(
      CAT,
      'ไฟล์ไม่ใช่ภาพ (html แอบมาเป็น png): 415',
      await uploadEvidence('customers', custA.id, fakeImageBytes(), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: acc1Id }, { filename: 'evil.png', type: 'image/png' }),
      415,
      { input: 'POST evidence <html><script>...', messageIncludes: 'Only image uploads' },
    );

    const dupChecksum = await uploadEvidence('customers', custA.id, pngBytes(3), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: second.json.data.id });
    statusCheck(CAT, 'ภาพซ้ำ (sha256 ตรงกัน) ในเจ้าของเดียวกัน: 409', dupChecksum, 409, {
      input: 'POST evidence ไฟล์ bytes เดียวกับที่เคยอัปโหลด',
      messageIncludes: 'already filed',
    });
    statusCheck(
      CAT,
      'ภาพเดียวกันแต่คนละเจ้าของ: 201 (checksum ผูกกับ owner ไม่ใช่ทั้งตาราง)',
      await uploadEvidence('loans', loanBank.id, pngBytes(3), { kind: 'DISBURSEMENT_SLIP' }),
      201,
    );

    const kycAfterProof = await rows(conn, 'SELECT kycStatus FROM customers WHERE id = ?', [custA.id]);
    check(CAT, 'อัปโหลดหลักฐานทางการเงินไม่กระทบสถานะ KYC (ตารางคนละชุดกับ kyc_documents)', {
      input: 'customers.kycStatus หลังอัปโหลดหลายไฟล์',
      expected: 'VERIFIED เหมือนเดิม',
      actual: kycAfterProof[0]?.kycStatus,
      pass: kycAfterProof[0]?.kycStatus === 'VERIFIED',
      note: 'ถ้า evidence ไปแตะ KYC ประตูปล่อยกู้จะปิดลงกลางคัน ซึ่งไม่ใช่เจตนาของหลักฐานทางการเงิน',
    });

    // ================================================== F. ช่องทางปล่อยกู้ (BANK / CASH) ตอนสร้าง + PATCH
    const loanPlain = await newLoan({ customer: custB, label: 'LOAN-PLAIN' });
    check(CAT, 'สร้างเงินกู้แบบไม่ระบุช่องทางยังได้ (backward compatible): disbursement ทุกช่อง null', {
      input: 'POST /api/loans โดยไม่มี disbursementChannel',
      expected: '{channel:null, bankAccountId:null, accountNumber:null, reference:null}',
      actual: JSON.stringify(loanPlain.disbursement),
      pass:
        loanPlain.disbursement?.channel === null &&
        loanPlain.disbursement?.bankAccountId === null &&
        loanPlain.disbursement?.accountNumber === null &&
        loanPlain.disbursement?.reference === null,
      note: 'เหตุที่ไม่บังคับ: กู้เก่าก่อนออก feature นี้ไม่มีใครรู้ว่าเงินไปถึงมืออย่างไร -- การสมมติว่า "โอนเข้าบัญชี" คือเรื่องที่ slip ต้องพิสูจน์ ไม่ใช่ค่า default',
    });
    const plainDetail = await loanDetail(loanPlain.id);
    check(CAT, 'GET /api/loans/:id คืน disbursement view ที่ mask เลขบัญชี (ไม่มีบัญชีก็ null ทั้งคู่)', {
      input: 'data.disbursement ของกู้ที่ยังไม่บันทึก',
      expected: 'channel null, accountNumber null',
      actual: JSON.stringify(plainDetail?.disbursement),
      pass: plainDetail?.disbursement?.channel === null && plainDetail?.disbursement?.accountNumber === null,
    });

    const bankDetail = await loanDetail(loanBank.id);
    check(CAT, 'กู้ที่เลือก BANK ตอนสร้าง เก็บช่องทาง+บัญชี+reference และตอบเลขแบบ mask', {
      input: 'data.disbursement ของ LOAN-BANK',
      expected: `channel BANK, accountNumber ${maskOf(acc1)}, reference REF-E2E-001`,
      actual: JSON.stringify(bankDetail?.disbursement),
      pass:
        bankDetail?.disbursement?.channel === 'BANK' &&
        bankDetail?.disbursement?.accountNumber === maskOf(acc1) &&
        bankDetail?.disbursement?.reference === 'REF-E2E-001' &&
        bankDetail?.disbursement?.bankAccountId === acc1Id,
    });
    const loanColumns = await rows(conn, 'SELECT disbursementChannel, disbursementBankAccountId, disbursementReference FROM loans WHERE id = ?', [loanBank.id]);
    check(CAT, 'คอลัมน์ทั้งสามบน loans ถูกเก็บจริง (ไม่ใช่แค่ของประกอบใน response)', {
      input: 'loans row',
      expected: `BANK / ${acc1Id} / REF-E2E-001`,
      actual: `${loanColumns[0]?.disbursementChannel} / ${loanColumns[0]?.disbursementBankAccountId} / ${loanColumns[0]?.disbursementReference}`,
      pass:
        loanColumns[0]?.disbursementChannel === 'BANK' &&
        loanColumns[0]?.disbursementBankAccountId === acc1Id &&
        loanColumns[0]?.disbursementReference === 'REF-E2E-001',
    });
    const loansList = await api('GET', '/api/loans?limit=100');
    check(CAT, 'รายการกู้รวม (GET /api/loans) ไม่มีเลขบัญชีเต็มเส้นปนมา', {
      input: 'JSON ทั้ง response ของ list',
      expected: `ไม่มี "${acc1}"`,
      actual: `HTTP ${loansList.status}, contains=${JSON.stringify(loansList.json).includes(acc1)}`,
      pass: !JSON.stringify(loansList.json).includes(acc1),
    });

    const badLoan = (body, customerId = custB.id) => api('POST', '/api/loans', {
      token: tokens.op1,
      body: { customerId, productId: P.id, principalAmount: PRINCIPAL, termValue: P.termValue, termUnit: P.termUnit, note: `${EV} BAD`, ...body },
    });
    statusCheck(CAT, 'BANK โดยไม่ระบุบัญชีตั้งแต่ตอนสร้าง: 422', await badLoan({ disbursementChannel: 'BANK' }), 422, {
      input: 'POST /api/loans {channel:BANK} ไม่มี account',
      messageIncludes: 'has to name the receiving account',
    });
    statusCheck(CAT, 'CASH แล้วแนบบัญชีด้วย: 422 (ขัดกันเอง)', await badLoan({ disbursementChannel: 'CASH', disbursementBankAccountId: otherSame.json.data.id }), 422, {
      input: 'POST /api/loans {channel:CASH, bankAccountId}',
      messageIncludes: 'cannot carry a bank account',
    });
    statusCheck(CAT, 'ช่องทางที่ไม่ใช่ enum: 400', await badLoan({ disbursementChannel: 'CRYPTO' }), 400, {
      input: 'POST /api/loans {channel:"CRYPTO"}',
    });
    statusCheck(CAT, 'บัญชีของลูกค้าคนอื่น: 404', await badLoan({ disbursementChannel: 'BANK', disbursementBankAccountId: acc1Id }), 404, {
      input: 'POST /api/loans กู้ลูกค้า B ด้วยบัญชีของ A',
    });

    const tmpAccount = await registerBank(custA.id, { bankName: 'TMPBANK', accountNumber: accountNo(21), accountHolderName: custA.fullName });
    statusCheck(CAT, 'ปิดบัญชีที่เพิ่งลงทะเบียน (เตรียมเคส CLOSED): 200', await closeBank(custA.id, tmpAccount.json.data.id, { reason: 'mistake at counter' }), 200);
    // บัญชีนี้อยู่กับ custA จึงต้องสร้างกู้ของ custA มิฉะนั้นจะกลายเป็นเคส "บัญชีของคนอื่น" (404) ไม่ใช่ CLOSED
    statusCheck(CAT, 'เลือกบัญชีที่ปิดแล้วระหว่างสร้างกู้: 422', await badLoan({ disbursementChannel: 'BANK', disbursementBankAccountId: tmpAccount.json.data.id }, custA.id), 422, {
      input: 'POST /api/loans ด้วย CLOSED account',
      messageIncludes: 'cannot be sent to a closed account',
    });

    statusCheck(CAT, 'PATCH เป็น CASH: ลบบัญชีเดิมทิ้ง (ป้ายบอกว่าเงินไม่ได้ผ่านบัญชี)', await patchDisbursement(loanBank.id, { channel: 'CASH' }), 200);
    const afterCash = await loanDetail(loanBank.id);
    check(CAT, 'หลัง PATCH CASH: channel CASH, bankAccountId null, reference ถูกล้าง', {
      input: 'data.disbursement',
      expected: 'CASH / null / null',
      actual: JSON.stringify(afterCash?.disbursement),
      pass:
        afterCash?.disbursement?.channel === 'CASH' &&
        afterCash?.disbursement?.bankAccountId === null &&
        afterCash?.disbursement?.accountNumber === null &&
        afterCash?.disbursement?.reference === null,
    });
    statusCheck(CAT, 'PATCH กลับมาเป็น BANK + reference ใหม่: 200', await patchDisbursement(loanBank.id, { channel: 'BANK', bankAccountId: acc1Id, reference: 'REF-E2E-002' }), 200);
    const afterBank = (await loanDetail(loanBank.id)).disbursement;
    check(CAT, 'PATCH BANK คืนบัญชีเดิมแบบ mask และ reference ที่ตั้งใหม่', {
      input: 'data.disbursement หลัง PATCH',
      expected: `BANK / ${maskOf(acc1)} / REF-E2E-002`,
      actual: JSON.stringify(afterBank),
      pass: afterBank?.channel === 'BANK' && afterBank?.accountNumber === maskOf(acc1) && afterBank?.reference === 'REF-E2E-002',
    });
    statusCheck(CAT, 'PATCH ด้วย VIEWER: 403', await patchDisbursement(loanBank.id, { channel: 'CASH' }, tokens.viewer), 403, {
      input: 'PATCH disbursement ด้วย test_view1',
    });
    statusCheck(CAT, 'PATCH เงินกู้ที่ไม่มีจริง: 404', await patchDisbursement(NOT_A_UUID, { channel: 'CASH' }), 404, {
      input: `PATCH /api/loans/${NOT_A_UUID}/disbursement`,
    });
    statusCheck(CAT, 'PATCH โดยไม่ส่ง channel: 400', await patchDisbursement(loanBank.id, { reference: 'x' }), 400, {
      input: 'PATCH body {reference} เท่านั้น',
    });
    statusCheck(CAT, 'PATCH BANK โดยไม่ระบุบัญชี: 422 (เป็นกฎธุรกิจ ไม่ใช่รูปทรงข้อมูล)', await patchDisbursement(loanBank.id, { channel: 'BANK' }), 422, {
      input: 'PATCH {channel:BANK} เท่านั้น',
      messageIncludes: 'has to name the receiving account',
    });
    statusCheck(CAT, 'PATCH CASH แล้วยังแนบบัญชีมา: 422 (เหมือนฝั่งสร้างกู้)', await patchDisbursement(loanBank.id, { channel: 'CASH', bankAccountId: acc1Id }), 422, {
      input: 'PATCH {channel:CASH, bankAccountId}',
      messageIncludes: 'cannot carry a bank account',
    });
    const channelAudit = await rows(conn, "SELECT previousStatus, newStatus, reason FROM audit_logs WHERE loanId = ? AND action = 'LOAN_DISBURSEMENT_CHANNEL_SET' ORDER BY createdAt", [loanBank.id]);
    check(CAT, 'ทุกการเปลี่ยนช่องทางมี audit ก่อน/หลัง และ reason ไม่มีเลขเต็มเส้น', {
      input: 'audit rows ของ LOAN-BANK',
      expected: '>= 2 แถว (BANK->CASH, CASH->BANK) และไม่มีแถวไหนมี acc1 แบบ plain',
      actual: `${channelAudit.length} แถว ${JSON.stringify(channelAudit.map((a) => `${a.previousStatus}->${a.newStatus}`))}`,
      pass: channelAudit.length >= 2 && channelAudit.every((a) => !String(a.reason).includes(acc1)),
    });

    // ================================================== G. สลิปการปล่อยกู้ (หลักฐานฝ่ายเงินกู้)
    const slip = await uploadEvidence('loans', loanBank.id, jpegBytes(5), { kind: 'DISBURSEMENT_SLIP', note: 'transfer slip from bank app' }, { filename: 'slip.jpg', type: 'image/jpeg' });
    statusCheck(CAT, 'MAKER อัปโหลดสลิปโอนหลังอนุมัติแล้ว: 201', slip, 201, { input: `POST ${evidenceBase('loans', loanBank.id)}` });
    const slipView = slip.json?.data ?? {};
    check(CAT, 'สลิปไม่ผูกกับบัญชีรายตัว (bankAccountId null, accountNumber null)', {
      input: 'data.bankAccountId/accountNumber',
      expected: 'null / null',
      actual: `${slipView.bankAccountId} / ${slipView.accountNumber}`,
      pass: slipView.bankAccountId === null && slipView.accountNumber === null,
    });
    const slipLedger = await rows(conn, "SELECT COUNT(*) n FROM financial_transactions WHERE loanId = ? AND transactionType = 'DISBURSEMENT' AND status = 'POSTED'", [loanBank.id]);
    const loanState = await loanDetail(loanBank.id);
    check(CAT, 'อัปโหลดสลิปไม่เปลี่ยน ledger และไม่เปลี่ยนสถานะกู้ (เป็นหลักฐานเท่านั้น)', {
      input: 'financial_transactions DISBURSEMENT POSTED + loans.status',
      expected: '1 แถว POSTED (ตอนสร้าง), ACTIVE',
      actual: `${slipLedger[0]?.n} แถว / ${loanState?.loan?.status}`,
      pass: num(slipLedger[0]?.n) === 1 && loanState?.loan?.status === 'ACTIVE',
    });

    const loanList = await listEvidence('loans', loanBank.id);
    const loanFiles = (loanList?.documents ?? []).map((d) => d.fileName).sort().join(',');
    check(CAT, 'รายการหลักฐานของกู้มีเฉพาะเอกสารของกู้จริง (owner มาจาก path เสมอ)', {
      input: 'GET loans/:id/evidence',
      expected: 'ทุกแถว ownerType LOAN และมี slip.jpg อยู่ด้วย',
      actual: `${(loanList?.documents ?? []).length} แถว / ${JSON.stringify((loanList?.documents ?? []).map((d) => d.ownerType))} / ${loanFiles}`,
      pass: (loanList?.documents ?? []).length >= 3 && (loanList?.documents ?? []).every((d) => d.ownerType === 'LOAN') && loanFiles.includes('slip.jpg'),
    });
    statusCheck(CAT, 'เรียกภาพสลิปผ่าน path ของลูกค้า (คนละ owner): 404', await api('GET', `${evidenceBase('customers', custA.id)}/${slipView.id}/content`, { token: tokens.op1, binary: true }), 404, {
      input: 'GET customers/<A>/evidence/<loanDoc>/content',
      note: 'owner มาจาก path จึงไม่มีทางดูเอกสารของกู้ผ่านรายการลูกค้าได้เลย',
    });
    statusCheck(CAT, 'ล้างเอกสารผ่าน path ของเจ้าของอื่น: 404 (ก่อนถึงขั้นสิทธิ์)', await deleteEvidenceCall('customers', custA.id, slipView.id), 404, {
      input: 'DELETE customers/<A>/evidence/<loanDoc>',
    });
    statusCheck(CAT, 'เจ้าของอื่น (op2) ลบสลิปของ op1: 403', await deleteEvidenceCall('loans', loanBank.id, slipView.id, tokens.op2), 403, {
      input: 'DELETE loans/<id>/evidence/<doc> ด้วย test_op2',
      messageIncludes: 'Only the uploader or an ADMIN',
    });

    const webpUpload = await uploadEvidence('loans', loanBank.id, webpBytes(2), { kind: 'DISBURSEMENT_SLIP' }, { filename: 'webp-slip.webp', type: 'image/webp' });
    statusCheck(CAT, 'webp ก็รับ (sniffer จำได้): 201', webpUpload, 201);
    check(CAT, 'mime จาก magic bytes ของ webp ถูกเก็บตรง', {
      input: 'data.mimeType',
      expected: 'image/webp',
      actual: webpUpload.json?.data?.mimeType,
      pass: webpUpload.json?.data?.mimeType === 'image/webp',
    });
    statusCheck(CAT, 'เจ้าของลบเอง: 200', await deleteEvidenceCall('loans', loanBank.id, webpUpload.json.data.id), 200);
    const goneMeta = await rows(conn, 'SELECT COUNT(*) n FROM evidence_documents WHERE id = ?', [webpUpload.json.data.id]);
    const goneContent = await rows(conn, 'SELECT COUNT(*) n FROM evidence_document_contents WHERE documentId = ?', [webpUpload.json.data.id]);
    check(CAT, 'ลบแล้วหายทั้ง metadata และไบนารี (ไม่ทิ้ง blob ค้าง)', {
      input: 'COUNT ของ docs/contents หลัง DELETE',
      expected: '0 / 0',
      actual: `${goneMeta[0]?.n} / ${goneContent[0]?.n}`,
      pass: num(goneMeta[0]?.n) === 0 && num(goneContent[0]?.n) === 0,
    });
    statusCheck(CAT, 'ลบซ้ำ: 404', await deleteEvidenceCall('loans', loanBank.id, webpUpload.json.data.id), 404);
    const reUpload = await uploadEvidence('loans', loanBank.id, webpBytes(2), { kind: 'DISBURSEMENT_SLIP' }, { filename: 'webp-slip.webp', type: 'image/webp' });
    statusCheck(CAT, 'หลังลบแล้ว อัปไฟล์เดิมกลับมาได้ (แก้ผิด = ลบ + อัปใหม่)', reUpload, 201, {
      input: 'POST ไฟล์ bytes เดิมที่เคย 409',
      note: 'ยืนยันว่า 409 duplicate เป็นกันซ้ำ ไม่ใช่ล็อกถาวร',
    });
    statusCheck(CAT, 'ADMIN ลบไฟล์ที่ op1 อัปได้ (ผู้ดูแลแก้ผิดแทนได้ แต่มี audit): 200', await deleteEvidenceCall('loans', loanBank.id, reUpload.json.data.id, tokens.admin), 200);

    const evidenceActions = await rows(
      conn,
      'SELECT action, COUNT(*) n FROM audit_logs WHERE action IN (?, ?, ?) AND (customerId = ? OR loanId IN (SELECT id FROM loans WHERE customerId = ?)) GROUP BY action',
      ['EVIDENCE_UPLOADED', 'EVIDENCE_DELETED', 'LOAN_DISBURSEMENT_CHANNEL_SET', custA.id, custA.id],
    );
    const actionMap = Object.fromEntries(evidenceActions.map((r) => [r.action, Number(r.n)]));
    check(CAT, 'audit ครอบคลุมหมวดนี้ครบ (จด/ปิด/เปิดกลับ/ย้าย primary/อัปโหลด/ลบ/เปลี่ยนช่องทาง)', {
      input: 'audit_logs action counts ของ custA และกู้ของมัน',
      expected: 'มี EVIDENCE_UPLOADED, EVIDENCE_DELETED, LOAN_DISBURSEMENT_CHANNEL_SET พร้อม BANK_ACCOUNT_* จากข้อ C',
      actual: JSON.stringify(actionMap),
      pass: ['EVIDENCE_UPLOADED', 'EVIDENCE_DELETED', 'LOAN_DISBURSEMENT_CHANNEL_SET'].every((a) => (actionMap[a] ?? 0) > 0),
    });

    // ================================================== H. การแจ้งเตือนอีเมล 2 event ใหม่ (ตรวจจาก outbox)
    await settle(300);
    const bankMails = await outboxRows('CUSTOMER_BANK_ACCOUNT_REGISTERED');
    check(CAT, 'จดบัญชีหนึ่งเกิดอีเมลหลายถึง: ถึงลูกค้าผู้มีอำนาจทุกคน และไม่มี loanId', {
      input: 'outbox rows type=CUSTOMER_BANK_ACCOUNT_REGISTERED',
      expected: 'ทุกแถว loanId NULL, อย่างน้อย 1 แถวจ่าหน้าถึง email ลูกค้าแต่ละคนที่ถูกจด',
      actual: `${bankMails.length} แถว / loanIdNotNull=${bankMails.some((r) => r.loanId !== null)} / customers=${new Set(bankMails.map((r) => r.customerId).filter(Boolean)).size}`,
      pass: bankMails.length >= 3 && bankMails.every((r) => r.loanId === null) && bankMails.some((r) => r.recipientEmail === custA.email),
    });

    const checker1Email = await emailOf('test_checker1');
    const actorAccount = await registerBank(custD.id, { bankName: 'ACTORBANK', accountNumber: accountNo(51), accountHolderName: custD.fullName }, tokens.checker1);
    statusCheck(CAT, 'CHECKER ลงทะเบียนบัญชีได้ (OPERATOR_ROLES): 201', actorAccount, 201);
    await settle(200);
    const actorMails = (await outboxRows('CUSTOMER_BANK_ACCOUNT_REGISTERED')).filter(
      (r) => r.payload.customerNumber === custD.customerNumber,
    );
    const actorExpected = lower([...approverEmails.filter((e) => String(e).toLowerCase() !== checker1Email), custD.email]);
    check(CAT, 'ผู้บันทึกไม่ได้อีเมลถึงตัวเอง (staffAudience ตัด actor ออก) -- ที่เหลือได้ครบ', {
      input: `registrations โดย test_checker1 สำหรับ ${custD.customerNumber}`,
      expected: `ชุดผู้รับ = ${JSON.stringify(actorExpected)}`,
      actual: JSON.stringify(lower([...new Set(actorMails.map((r) => r.recipientEmail))])),
      pass: JSON.stringify(lower([...new Set(actorMails.map((r) => r.recipientEmail))])) === JSON.stringify(actorExpected),
    });

    // แถวเรียงด้วย recipientEmail คอลัมน์เดียว จึงไม่คงที่เมื่อลงทะเบียนหลายบัญชี: ตรวจทุกแถวตามสัญญา แล้วค่อยเลือกแถวของ acc1 เป็นตัวอย่าง
    const maskedShape = /^\*+\d{4}$/;
    // F-EVD-2: maskAccountNumber คืนทั้งเส้นเมื่อเลข <= 4 หลัก เคสนั้นแดงไว้ที่ E2E-028 แล้ว จึงยกเว้นจากรูปแบบนี้ที่นี่
    const SHORT_UNMASKED = new Set(['1234']);
    check(CAT, 'payload ของ event บัญชีถูกต้องตามสัญญา: ทุกแถวเป็น mask เท่านั้น + ไม่มีเลขเต็มในเรื่องหัว/เนื้ออีเมล', {
      input: 'payload + text ของทุกแถว',
      expected: 'ทุกแถวเข้ารูปปิด 4 หลักท้าย (mask) และมีของ acc1 อยู่ด้วย, ไม่มีเลขเต็มในเนื้ออีเมล',
      actual: JSON.stringify({
        rows: bankMails.length,
        masks: [...new Set(bankMails.map((r) => r.payload?.accountNumberMasked))].sort(),
        badShape: bankMails
          .filter((r) => !maskedShape.test(String(r.payload?.accountNumberMasked ?? '')) && !SHORT_UNMASKED.has(String(r.payload?.accountNumberMasked)))
          .map((r) => r.payload?.accountNumberMasked),
        leaksPlaintext: bankMails.filter((r) => String(r.text).includes(acc1)).map((r) => r.payload?.bankName),
      }),
      pass:
        bankMails.length > 0 &&
        bankMails.every(
          (r) => maskedShape.test(String(r.payload?.accountNumberMasked ?? '')) || SHORT_UNMASKED.has(String(r.payload?.accountNumberMasked)),
        ) &&
        bankMails.some((r) => r.payload?.accountNumberMasked === maskOf(acc1)) &&
        bankMails.every((r) => !String(r.text).includes(acc1)),
    });
    const sampleBank = bankMails.find((r) => r.payload?.accountNumberMasked === maskOf(acc1)) ?? bankMails[0];
    const sealedRow = await rows(conn, 'SELECT payload FROM notification_outbox WHERE id = ?', [sampleBank?.id]);
    check(CAT, 'outbox เก็บแบบ sealed ทั้ง subject/body/payload (เลขบัญชีไม่อยู่ในตารางเป็นข้อความดิบ)', {
      input: 'raw payload ของแถวแรก',
      expected: 'ขึ้นต้นด้วย sealed:v1:',
      actual: String(sealedRow[0]?.payload ?? '').slice(0, 16),
      pass: String(sealedRow[0]?.payload ?? '').startsWith('sealed:v1:'),
    });

    const templates = (await api('GET', '/api/notifications/templates')).json?.data?.templates ?? [];
    const bankTpl = templates.find((t) => t.code === 'CUSTOMER_BANK_ACCOUNT_REGISTERED');
    check(CAT, 'มี template locale lo เปิดใช้งานสำหรับ CUSTOMER_BANK_ACCOUNT_REGISTERED', {
      input: 'GET /api/notifications/templates',
      expected: '1 แถว locale lo, isActive 1',
      actual: bankTpl ? `${bankTpl.locale}/${bankTpl.isActive}` : '(ไม่มี code นี้ในฐานข้อมูล)',
      pass: !!bankTpl && bankTpl.locale === 'lo' && bankTpl.isActive === true,
      note: 'seedEmailTemplates เป็น insert-only: ถ้ายังไม่ได้รัน migration + boot ครั้งแรกจะไม่มีแถวนี้ และอีเมลทั้งสอง event จะไม่ถูก render จากแถวจริง',
    });
    const bankUnfed = bankTpl ? placeholdersOf(bankTpl).filter((p) => !(p in (sampleBank?.payload ?? {})) && p !== 'recipientName') : ['(ไม่มี template)'];
    check(CAT, 'ทุก placeholder ใน template บัญชีมีตัวป้อนจาก emitter จริง', {
      input: 'placeholders ของ template vs payload',
      expected: 'ไม่มี placeholder ว่าง',
      actual: bankUnfed.length ? `ขาด: ${bankUnfed.join(', ')}` : `ครบ ${placeholdersOf(bankTpl).length} ตัว`,
      pass: !!sampleBank && bankUnfed.length === 0,
    });

    const slipMails = await outboxRows('LOAN_DISBURSEMENT_EVIDENCE_UPLOADED', { loanId: loanBank.id });
    const slipExpected = lower([...approverEmails, custA.email]);
    check(CAT, 'อัปโหลดสลิปแจ้งผู้มีอำนาจ + ผู้กู้ (collectionAudience) พร้อม loanId และช่องทางที่ถูกต้อง', {
      input: 'outbox rows type=LOAN_DISBURSEMENT_EVIDENCE_UPLOADED ของ LOAN-BANK',
      expected: `ชุดผู้รับ = ${JSON.stringify(slipExpected)}, ทุกแถว loanId = ${loanBank.id}, channel = "${CHANNEL_LABEL.BANK}"`,
      actual: JSON.stringify({
        rows: slipMails.length,
        recipients: lower([...new Set(slipMails.map((r) => r.recipientEmail))]),
        wrongLoan: slipMails.filter((r) => r.loanId !== loanBank.id).length,
        channels: [...new Set(slipMails.map((r) => r.payload.channel))],
      }),
      pass:
        slipMails.length >= 2 &&
        slipMails.every((r) => r.loanId === loanBank.id) &&
        JSON.stringify(lower([...new Set(slipMails.map((r) => r.recipientEmail))])) === JSON.stringify(slipExpected) &&
        slipMails.every((r) => r.payload.channel === CHANNEL_LABEL.BANK),
    });
    // แถวแรกเรียงด้วย recipientEmail เพียงคอลัมน์เดียว จึงไม่คงที่ถ้าอัปหลายไฟล์: เลือกเอาเมลของสลิปจริง
    const sampleSlip = slipMails.find((r) => r.payload?.fileName === 'slip.jpg') ?? slipMails[0];
    const slipFileNames = [...new Set(slipMails.map((r) => r.payload?.fileName))].sort();
    check(CAT, 'payload ของ event สลิป: mask ของบัญชีปลายทาง + ชื่อไฟล์ + ผู้ uploading, ไม่มีเลขเต็มในอีเมล', {
      input: 'payload + text ของทุกแถว',
      expected: `ทุกแถว masked ${maskOf(acc1)}, fileName ต้องเป็นหนึ่งในไฟล์ที่อัปจริง (${[...UPLOADED_SLIPS].join(', ')}), ไม่มี "${acc1}"`,
      actual: JSON.stringify({
        masked: [...new Set(slipMails.map((r) => r.payload?.accountNumberMasked))],
        fileNames: slipFileNames,
        uploaders: [...new Set(slipMails.map((r) => r.payload?.uploadedByName))],
        leaksPlaintext: slipMails.some((r) => String(r.text).includes(acc1)),
      }),
      pass:
        slipMails.length > 0 &&
        slipMails.every(
          (r) =>
            r.payload?.accountNumberMasked === maskOf(acc1) &&
            !!r.payload?.uploadedByName &&
            UPLOADED_SLIPS.has(r.payload?.fileName) &&
            !String(r.text).includes(acc1),
        ),
    });
    const slipTpl = templates.find((t) => t.code === 'LOAN_DISBURSEMENT_EVIDENCE_UPLOADED');
    const slipUnfed = slipTpl ? placeholdersOf(slipTpl).filter((p) => !(p in (sampleSlip?.payload ?? {})) && p !== 'recipientName') : ['(ไม่มี template)'];
    check(CAT, 'ทุก placeholder ใน template สลิปมีตัวป้อนจาก emitter จริง', {
      input: 'placeholders ของ template vs payload',
      expected: 'ไม่มี placeholder ว่าง',
      actual: slipUnfed.length ? `ขาด: ${slipUnfed.join(', ')}` : `ครบ ${placeholdersOf(slipTpl).length} ตัว`,
      pass: slipUnfed.length === 0,
    });

    const cashLoan = await newLoan({ customer: custB, label: 'LOAN-CASH', extra: { disbursementChannel: 'CASH' } });
    await uploadEvidence('loans', cashLoan.id, pngBytes(6), { kind: 'DISBURSEMENT_SLIP', note: 'cash receipt signed at counter' }, { filename: 'receipt.png' });
    const cashMail = await outboxRows('LOAN_DISBURSEMENT_EVIDENCE_UPLOADED', { loanId: cashLoan.id });
    check(CAT, 'กู้เงินสด: อีเมลแสดงช่องทาง "เงินสด" และบัญชี = "ยังไม่ได้บันทึก" (ไม่ใช่ช่องว่าง)', {
      input: 'payload ของ event ฝ่าย CASH',
      expected: `channel "${CHANNEL_LABEL.CASH}", accountNumberMasked "${NOT_RECORDED}"`,
      actual: JSON.stringify(cashMail[0]?.payload ?? null),
      pass: cashMail[0]?.payload?.channel === CHANNEL_LABEL.CASH && cashMail[0]?.payload?.accountNumberMasked === NOT_RECORDED,
      note: 'ช่องว่างในอีเมลทำให้ผู้มีอำนาจอ่านแล้วไม่รู้ว่า "ไม่มีข้อมูล" หรือ "กรอกผิด"',
    });

    // ================================================== I. โควตา/ขนาด/ประเภทไฟล์ตามนโยบายที่เปลี่ยนได้
    const custQuota = await newCustomer('C-QUOTA');
    await verifyKyc(custQuota, 9);
    const quotaAccount = await registerBank(custQuota.id, { bankName: 'QBC', accountNumber: accountNo(31), accountHolderName: custQuota.fullName });

    const tight = await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { ...shippedPolicy, maxFileSizeKb: 1, maxTotalBytesPerOwner: 1024 } });
    statusCheck(CAT, 'ตั้งเพดานภาพ 1 KB + โควตา 1024 bytes: 200', tight, 200);
    statusCheck(CAT, 'ภาพเกินเพดาน 1 KB: 413 (multer ตัดก่อนถึงกฎธุรกิจ)', await uploadEvidence('customers', custQuota.id, pngBytes(0), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: quotaAccount.json.data.id }), 413, {
      input: 'POST evidence 1034 bytes limit 1 KB',
      messageIncludes: 'larger than the configured limit',
    });

    statusCheck(CAT, 'ปรับเป็นภาพ <= 2 KB + โควตา 2048 bytes: 200', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { ...shippedPolicy, maxFileSizeKb: 2, maxTotalBytesPerOwner: 2048 } }), 200);
    statusCheck(CAT, 'ภาพแรก (1034 B) ผ่านโควตา: 201', await uploadEvidence('customers', custQuota.id, pngBytes(0), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: quotaAccount.json.data.id }), 201);
    statusCheck(
      CAT,
      'ภาพที่สองทำให้เกินโควตาเจ้าของ: 422 พร้อมตัวเลขโควตา',
      await uploadEvidence('customers', custQuota.id, webpBytes(0), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: quotaAccount.json.data.id }, { filename: 'second.webp', type: 'image/webp' }),
      422,
      { input: 'POST evidence อีก 1036 B เมื่อใช้ไป 1034/2048', messageIncludes: 'Evidence storage quota reached' },
    );
    const docsAfterQuota = await rows(conn, 'SELECT COUNT(*) n FROM evidence_documents WHERE ownerId = ?', [custQuota.id]);
    const contentsAfterQuota = await rows(conn, 'SELECT COUNT(*) n FROM evidence_document_contents c JOIN evidence_documents d ON d.id = c.documentId WHERE d.ownerId = ?', [custQuota.id]);
    const uploadAudit = await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE customerId = ? AND action = 'EVIDENCE_UPLOADED'", [custQuota.id]);
    check(CAT, 'คำขอที่ตกไป 422 ไม่ทิ้งแถว metadata หรือ blob ไว้ (transaction เดียวกันทั้ง row + bytes + audit)', {
      input: 'COUNT docs / contents / audit ของ custQuota',
      expected: '1 / 1 / 1',
      actual: `${docsAfterQuota[0]?.n} / ${contentsAfterQuota[0]?.n} / ${uploadAudit[0]?.n}`,
      pass: num(docsAfterQuota[0]?.n) === 1 && num(contentsAfterQuota[0]?.n) === 1 && num(uploadAudit[0]?.n) === 1,
    });

    statusCheck(CAT, 'อนุญาตเฉพาะ image/jpeg: 200', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: { ...shippedPolicy, allowedMimeTypes: ['image/jpeg'] } }), 200);
    statusCheck(
      CAT,
      'png ตอนอนุญาตเฉพาะ jpeg: 415 พร้อมรายชื่อที่อนุญาต',
      await uploadEvidence('customers', custQuota.id, pngBytes(2), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: quotaAccount.json.data.id }),
      415,
      { input: 'POST evidence png เมื่อ mime = image/jpeg เท่านั้น', messageIncludes: 'is not allowed' },
    );
    statusCheck(
      CAT,
      'jpeg ยังผ่านอยู่: 201',
      await uploadEvidence('customers', custQuota.id, jpegBytes(2), { kind: 'BANK_ACCOUNT_PROOF', bankAccountId: quotaAccount.json.data.id }, { filename: 'ok.jpg', type: 'image/jpeg' }),
      201,
    );
    statusCheck(CAT, 'คืนนโยบายเป็น shipped defaults: 200', await api('PUT', '/api/config/evidence', { token: tokens.admin, body: shippedPolicy }), 200);
    const policyBack = (await api('GET', '/api/config/evidence')).json?.data?.policy;
    check(CAT, 'นโยบายที่ใช้งานหลังคืนค่าตรงกับ shipped (ไม่ทิ้งเพดานที่เคสทดลองตั้งไว้)', {
      input: 'GET /api/config/evidence',
      expected: JSON.stringify(shippedPolicy),
      actual: JSON.stringify(policyBack),
      pass: JSON.stringify(policyBack) === JSON.stringify(shippedPolicy),
    });

    // ================================================== J. คืนของ + ตรวจความสะอาด
    await pins.restore();
    await settle(400);
    await purge();

    const counts = {};
    for (const t of TABLES) counts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`, []))[0].n);
    const dirty = TABLES.filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: แถวทุกตารางที่ suite นี้แตะกลับเท่าก่อนเริ่ม (ลูกค้า/บัญชี/หลักฐาน/blob/กู้/ledger/outbox/audit)', {
      input: 'row counts ก่อน vs หลัง',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      pass: dirty.length === 0,
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.map((t) => `${t} ${baseline[t]}->${counts[t]}`).join(', ')}` : '',
    });

    // นับเฉพาะสิ่งที่ suite นี้เขียนในการรันนี้ (createdAt >= ตอนเริ่ม) เพราะตารางนี้มีแถวของลูกค้า seed อยู่แล้ว
    const leftovers = {
      customers: await rows(conn, 'SELECT COUNT(*) n FROM customers WHERE fullName LIKE ?', [`${EV}%`]).then((r) => Number(r[0].n)),
      accounts: await rows(conn, 'SELECT COUNT(*) n FROM customer_bank_accounts WHERE createdAt >= ?', [utcSql(STARTED_AT)]).then((r) => Number(r[0].n)),
      documents: await rows(conn, 'SELECT COUNT(*) n FROM evidence_documents WHERE createdAt >= ?', [utcSql(STARTED_AT)]).then((r) => Number(r[0].n)),
      contents: await rows(conn, 'SELECT COUNT(*) n FROM evidence_document_contents c JOIN evidence_documents d ON d.id = c.documentId WHERE d.createdAt >= ?', [utcSql(STARTED_AT)]).then((r) => Number(r[0].n)),
      mails: await rows(conn, 'SELECT COUNT(*) n FROM notification_outbox WHERE type IN (?)', [EVIDENCE_TYPES]).then((r) => Number(r[0].n)),
      loans: await rows(conn, 'SELECT COUNT(*) n FROM loans WHERE customerId IN (SELECT id FROM customers WHERE fullName LIKE ?)', [`${EV}%`]).then((r) => Number(r[0].n)),
    };
    check(CAT, 'ไม่มีแถวของ suite ค้างในตารางใหม่ทั้งสาม และ 2 event ใหม่ออกจากระบบหมด', {
      input: 'leftover counts',
      expected: 'customers 0, accounts 0, documents 0, contents 0, mails 0, loans 0',
      actual: JSON.stringify(leftovers),
      pass: Object.values(leftovers).every((n) => n === 0),
    });

    const policyAfterRun = (await api('GET', '/api/config/evidence')).json?.data?.policy;
    check(CAT, 'คืนนโยบาย evidence เป็นค่าที่พบก่อนเริ่มรัน', {
      input: 'GET /api/config/evidence หลัง restore',
      expected: JSON.stringify(pins.found.evidence),
      actual: JSON.stringify(policyAfterRun),
      pass: JSON.stringify(policyAfterRun) === JSON.stringify(pins.found.evidence),
    });
    const seededActive = Number((await rows(conn, "SELECT COUNT(*) n FROM loans WHERE status = 'ACTIVE'", []))[0].n);
    check(CAT, 'เล่ม seed ยังอยู่ครบ (suite นี้ไม่ได้กินเงินกู้ของข้อมูลจำลอง)', {
      input: 'COUNT loans WHERE status = ACTIVE หลัง purge',
      expected: '> 0 (เงินกู้ seed ยังอยู่ครบทุกฉบับ)',
      actual: `${seededActive} ฉบับ`,
      pass: seededActive > 0,
    });
  } finally {
    await pins.restore().catch(() => {});
    await purge().catch(() => {});
  }
}
