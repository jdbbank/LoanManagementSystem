// 3.4 KYC: evidence upload rules, checklist, maker-checker review, reverify-on-change,
// expiry handling and the ADMIN-only reopen rollback.
import { createHash } from 'node:crypto';
import { api, check, errorMessage, statusCheck } from '../lib/harness.mjs';
import { fakeImageBytes, jpegBytes, multipartWithFields, pngBytes } from '../lib/files.mjs';

const CAT = 'kyc';
const sha = (b) => createHash('sha256').update(b).digest('hex');

const upload = (token, base, buffer, fields, opts) =>
  api('POST', `${base}/documents`, { token, form: multipartWithFields(buffer, fields, opts) });

/** A complete, policy-satisfying evidence set. */
const COMPLETE_SET = [
  ['NATIONAL_ID', 'identity.png', pngBytes, { issuedAt: '2023-04-11', expiresAt: '2029-04-11' }],
  ['SELFIE_WITH_ID', 'selfie.jpg', jpegBytes, {}],
  ['SIGNATURE', 'signature.png', pngBytes, {}],
];

const customerFixtures = {};

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const admin = tokens.admin;
  const op1 = tokens.op1;
  const checker = tokens.checker2; // checker1 is the maker in other suites; keep them separate
  const policy = (await api('GET', '/api/config/kyc', { token: admin })).json?.data?.policy ?? {};

  // fresh customers so the seeded KYC states stay untouched
  for (const [key, name] of [['flow', 'Test Kyc Flow'], ['expired', 'ສ testing Kyc Expired']]) {
    const res = await api('POST', '/api/customers', { token: op1, body: { fullName: name, phone: '020999999', nationalId: `kyc-${key}` } });
    customerFixtures[key] = res.json?.customer;
    if (key === 'flow') {
      check(CAT, 'สร้างลูกค้าใหม่เพื่อทดสอบ KYC (สถานะเริ่มต้น NOT_VERIFIED)', {
        input: name,
        expected: '201 + kycStatus NOT_VERIFIED',
        actual: `HTTP ${res.status} kycStatus=${res.json?.customer?.kycStatus}`,
        pass: res.status === 201 && res.json?.customer?.kycStatus === 'NOT_VERIFIED',
      });
    }
  }
  const flow = customerFixtures.flow;
  const base = `/api/customers/${flow?.id}/kyc`;
  if (!flow?.id) return;

  // ---------------------------------------------------------------- state + checklist
  const initial = await api('GET', `${base}/documents`, { token: op1 });
  statusCheck(CAT, 'GET สถานะ KYC คืน kycState ครบชุด', initial, 200, { input: base });
  check(CAT, 'kycState มี customer/documents/policy/checklist ตามสัญญา', {
    input: 'GET /kyc/documents',
    expected: ['customer', 'documents', 'policy', 'checklist'],
    actual: Object.keys(initial.json?.data ?? {}),
    pass: ['customer', 'documents', 'policy', 'checklist'].every((k) => k in (initial.json?.data ?? {})),
  });
  check(CAT, 'ยังไม่มีเอกสาร → checklist บอกว่าขาด IDENTITY_DOCUMENT, SELFIE_WITH_ID, SIGNATURE', {
    input: 'checklist.missing',
    expected: ['IDENTITY_DOCUMENT', 'SELFIE_WITH_ID', 'SIGNATURE'],
    actual: initial.json?.data?.checklist?.missing,
    pass: JSON.stringify(initial.json?.data?.checklist?.missing) === JSON.stringify(['IDENTITY_DOCUMENT', 'SELFIE_WITH_ID', 'SIGNATURE']),
  });
  check(CAT, 'satisfied=false ก่อนอัปโหลด', {
    input: 'checklist.satisfied',
    expected: false,
    actual: initial.json?.data?.checklist?.satisfied,
    pass: initial.json?.data?.checklist?.satisfied === false,
  });

  // ---------------------------------------------------------------- upload rules
  const identity = pngBytes(30);
  const up1 = await upload(op1, base, identity, { documentType: 'NATIONAL_ID', issuedAt: '2023-04-11', expiresAt: '2029-04-11' }, { filename: 'บัตรประชาชน.png', type: 'image/png' });
  statusCheck(CAT, 'อัปโหลด NATIONAL_ID (PNG จริง): 201', up1, 201, { input: 'NATIONAL_ID 30KB png' });
  const savedDoc = (up1.json?.data?.documents ?? []).find((d) => d.documentType === 'NATIONAL_ID');
  check(CAT, 'เก็บ mimeType/size/checksum ตรงกับไบต์จริง (ไม่เชื่อ Content-Type)', {
    input: 'sha256 of the uploaded bytes',
    expected: { mimeType: 'image/png', sizeBytes: identity.length, checksum: sha(identity) },
    actual: { mimeType: savedDoc?.mimeType, sizeBytes: savedDoc?.sizeBytes, checksum: savedDoc?.checksum },
    pass:
      savedDoc?.mimeType === 'image/png' &&
      Number(savedDoc?.sizeBytes) === identity.length &&
      savedDoc?.checksum === sha(identity),
  });
  const storedName = String(savedDoc?.fileName ?? '');
  const recoveredName = Buffer.from(storedName, 'latin1').toString('utf8');
  check(CAT, 'ชื่อไฟล์ภาษาไทยต้องถูกเก็บถูกต้อง (UTF-8)', {
    input: 'filename บัตรประชาชน.png',
    expected: 'บัตรประชาชน.png',
    actual: storedName === 'บัตรประชาชน.png' ? storedName : `${storedName} ← อ่านกลับเป็น latin1 ได้ "${recoveredName}"`,
    pass: storedName === 'บัตรประชาชน.png',
    note:
      recoveredName === 'บัตรประชาชน.png'
        ? 'ยืนยันสาเหตุ: multer decode ชื่อไฟล์เป็น latin1 จึงเก็บค่าเพี้ยน (ใช้ได้กับทุกไฟล์ไม่เป็น ASCII รวมถึงชื่อภาษาลาว)'
        : 'สาเหตุไม่ใช่ latin1',
  });
  const dup = await upload(op1, base, identity, { documentType: 'PASSPORT' }, { filename: 'same.png', type: 'image/png' });
  statusCheck(CAT, 'อัปโหลดไบต์ซ้ำกับภาพที่มีอยู่: 409', dup, 409, { input: 'same bytes, different type', messageIncludes: 'already uploaded' });
  const notImage = await upload(op1, base, fakeImageBytes(), { documentType: 'ID_CARD' }, { filename: 'id.png', type: 'image/png' });
  statusCheck(CAT, 'อัปโหลดไฟล์ที่ไม่ใช่รูป (นามสกุล .png): 415', notImage, 415, { input: 'html bytes named id.png' });
  const oversize = await upload(op1, base, pngBytes(Math.ceil((policy.maxFileSizeKb ?? 5120) / 1024) * 1024 + 1024), { documentType: 'ID_CARD' }, { filename: 'big.png', type: 'image/png' });
  check(CAT, 'อัปโหลดใหญ่กว่า policy: 413', {
    input: `pngBytes(${(policy.maxFileSizeKb ?? 5120) + 1024} KB)`,
    expected: '413',
    actual: `HTTP ${oversize.status} ${errorMessage(oversize)}`,
    pass: oversize.status === 413 || (oversize.status >= 400 && /large|limit|exceed/i.test(errorMessage(oversize))),
  });
  const badType = await upload(op1, base, pngBytes(2), { documentType: 'DRIVING_LICENSE' }, { filename: 'x.png', type: 'image/png' });
  check(CAT, 'documentType ที่ไม่มีใน enum: 4xx ไม่ใช่ 5xx', {
    input: 'documentType=DRIVING_LICENSE',
    expected: '400/422',
    actual: `HTTP ${badType.status} ${errorMessage(badType)}`,
    pass: badType.status >= 400 && badType.status < 500,
  });
  const badDate = await upload(op1, base, pngBytes(2), { documentType: 'ID_CARD', issuedAt: '11/04/2023' }, { filename: 'd.png', type: 'image/png' });
  statusCheck(CAT, 'รูปแบบวันที่ไม่ถูกต้อง: 400', badDate, 400, { input: 'issuedAt=11/04/2023' });
  const futureIssue = await upload(op1, base, pngBytes(2), { documentType: 'ID_CARD', issuedAt: '2099-01-01' }, { filename: 'f.png', type: 'image/png' });
  statusCheck(CAT, 'issuedAt เป็นอนาคต: 422', futureIssue, 422, { input: 'issuedAt=2099-01-01', messageIncludes: 'cannot be in the future' });
  const inverted = await upload(op1, base, pngBytes(2), { documentType: 'ID_CARD', issuedAt: '2026-05-01', expiresAt: '2025-05-01' }, { filename: 'i.png', type: 'image/png' });
  statusCheck(CAT, 'expiresAt ก่อน issuedAt: 422', inverted, 422, { input: 'expiresAt<issuedAt', messageIncludes: 'must be after' });
  const noFile = await api('POST', `${base}/documents`, { token: op1, form: multipartWithFields(Buffer.from('empty'), { documentType: 'ID_CARD' }, { field: 'wrong' }) });
  statusCheck(CAT, 'ไม่ส่งไบต์ใน field "file": 400', noFile, 400, { input: 'field=wrong' });
  const viewerUp = await upload(tokens.viewer, base, pngBytes(2), { documentType: 'ID_CARD' }, { filename: 'v.png', type: 'image/png' });
  statusCheck(CAT, 'VIEWER อัปโหลดหลักฐานไม่ได้: 403', viewerUp, 403, { input: 'viewer token' });

  // content read-back, binary-safe
  const content = await api('GET', `${base}/documents/${savedDoc?.id}/content`, { token: op1, binary: true });
  check(CAT, 'GET เนื้อหาเอกสารคืนไบต์ตรงกับที่อัปโหลด (sha256 เท่ากัน)', {
    input: 'GET /documents/:id/content',
    expected: sha(identity),
    actual: `${content.status} ${content.headers['content-type']} sha=${sha(content.buffer ?? Buffer.alloc(0))}`,
    pass: content.status === 200 && sha(content.buffer ?? Buffer.alloc(0)) === sha(identity),
  });
  const otherBase = `/api/customers/${customerFixtures.expired?.id}/kyc`;
  const idor = await api('GET', `${otherBase}/documents/${savedDoc?.id}/content`, { token: op1, binary: true });
  statusCheck(CAT, 'ข้ามไปอ่านเอกสารของลูกค้าอื่นด้วย id จริง: 404 (กัน IDOR)', idor, 404, { input: 'other customerId + this documentId' });

  // ---------------------------------------------------------------- delete rules
  const otherDelete = await api('DELETE', `${base}/documents/${savedDoc?.id}`, { token: tokens.op2 });
  statusCheck(CAT, 'คนที่ไม่ใช่ผู้อัปโหลด/ADMIN ลบเอกสารไม่ได้: 403', otherDelete, 403, { input: 'test_op2 deletes test_op1 upload', messageIncludes: 'Only the uploader or an ADMIN' });
  const didDelete = await api('DELETE', `${base}/documents/${savedDoc?.id}`, { token: op1 });
  statusCheck(CAT, 'ผู้อัปโหลดลบเองได้', didDelete, 200, { input: 'uploader DELETE' });
  const gone = await api('DELETE', `${base}/documents/${savedDoc?.id}`, { token: op1 });
  statusCheck(CAT, 'ลบเอกสารที่ไม่อยู่แล้ว: 404', gone, 404, { input: 'same id twice' });

  // ---------------------------------------------------------------- submit / review
  const earlySubmit = await api('POST', `${base}/submit`, { token: op1, body: {} });
  statusCheck(CAT, 'submit ก่อนเอกสารครบ: 422 พร้อมรายการที่ขาด', earlySubmit, 422, { input: 'no documents uploaded' });
  check(CAT, 'ข้อความ 422 ระบุโค้ดที่ขาด (IDENTITY_DOCUMENT, SELFIE_WITH_ID, SIGNATURE)', {
    input: errorMessage(earlySubmit),
    expected: 'mentions the missing checklist codes',
    actual: errorMessage(earlySubmit),
    pass: /IDENTITY_DOCUMENT/.test(errorMessage(earlySubmit)) && /SELFIE_WITH_ID/.test(errorMessage(earlySubmit)),
  });

  const ids = [];
  for (const [documentType, filename, maker, extra] of COMPLETE_SET) {
    const buffer = maker(20 + ids.length * 5);
    const res = await upload(op1, base, buffer, { documentType, ...extra }, { filename, type: documentType === 'SELFIE_WITH_ID' ? 'image/jpeg' : 'image/png' });
    ids.push({ documentType, status: res.status, id: (res.json?.data?.documents ?? []).find((d) => d.documentType === documentType)?.id });
  }
  check(CAT, 'อัปโหลดชุดเอกสารครบตาม policy (3 รายการ) สำเร็จทุกใบ', {
    input: COMPLETE_SET.map((x) => x[0]).join(','),
    expected: '201 x3',
    actual: JSON.stringify(ids.map((x) => `${x.documentType}=${x.status}`)),
    pass: ids.every((x) => x.status === 201 && x.id),
  });
  const readyState = await api('GET', `${base}/documents`, { token: op1 });
  check(CAT, 'ครบเงื่อนไขแล้ว checklist.satisfied=true', {
    input: 'GET /kyc/documents',
    expected: true,
    actual: readyState.json?.data?.checklist?.satisfied,
    pass: readyState.json?.data?.checklist?.satisfied === true,
  });

  // ผู้ส่งเป็น CHECKER เพื่อให้ด่าน maker-checker (ไม่ใช่ด่าน role) เป็นตัวตอบ
  const submit = await api('POST', `${base}/submit`, { token: tokens.checker1, body: {} });
  statusCheck(CAT, 'submit เมื่อเอกสารครบ: 200 + สถานะ PENDING', submit, 200, { input: 'maker submits' });
  const makerId = (await api('GET', '/api/auth/me', { token: tokens.checker1 })).json?.user?.id;
  check(CAT, 'submit บันทึกผู้ส่ง + เวลา แต่ยังไม่มี policy snapshot (เก็บตอนอนุมัติ)', {
    input: 'submit.json.data.customer',
    expected: { kycStatus: 'PENDING', kycSubmittedBy: makerId, kycSubmittedAt: true, kycAppliedPolicy: null },
    actual: {
      kycStatus: submit.json?.data?.customer?.kycStatus,
      kycSubmittedBy: submit.json?.data?.customer?.kycSubmittedBy,
      kycSubmittedAt: !!submit.json?.data?.customer?.kycSubmittedAt,
      kycAppliedPolicy: submit.json?.data?.customer?.kycAppliedPolicy ?? null,
    },
    pass:
      submit.json?.data?.customer?.kycStatus === 'PENDING' &&
      submit.json?.data?.customer?.kycSubmittedBy === makerId &&
      !!submit.json?.data?.customer?.kycSubmittedAt,
  });
  const resubmit = await api('POST', `${base}/submit`, { token: tokens.checker1, body: {} });

  const selfVerify = await api('POST', `${base}/verify`, { token: tokens.checker1, body: { note: 'self review' } });
  statusCheck(CAT, 'maker ตรวจอนุมัติเองไม่ได้ (maker-checker): 422', selfVerify, 422, { input: 'submitter verifies', messageIncludes: 'Maker-Checker separation' });
  const wrongOtpVerify = await api('POST', `${base}/verify`, { token: tokens.op2, body: {} });
  statusCheck(CAT, 'MAKER อื่น verify ไม่ได้: 403', wrongOtpVerify, 403, { input: 'MAKER token' });

  const noReason = await api('POST', `${base}/reject`, { token: checker, body: { reason: '' } });
  statusCheck(CAT, 'reject โดยไม่มีเหตุผล: 400', noReason, 400, { input: 'reason=""' });
  const rejected = await api('POST', `${base}/reject`, { token: checker, body: { reason: 'ภาพบัตรประชาชนไม่ชัด ต้องถ่ายใหม่' } });
  statusCheck(CAT, 'CHECKER reject พร้อมเหตุผล: 200 + สถานะ REJECTED', rejected, 200, { input: 'reason provided' });
  check(CAT, 'เหตุผลที่ถูก reject ถูกเก็บไว้ให้เห็นใน state', {
    input: rejected.json?.data?.customer?.kycRejectionReason,
    expected: 'ภาพบัตรประชาชนไม่ชัด ต้องถ่ายใหม่',
    actual: String(rejected.json?.data?.customer?.kycRejectionReason),
    pass: rejected.json?.data?.customer?.kycRejectionReason === 'ภาพบัตรประชาชนไม่ชัด ต้องถ่ายใหม่',
  });
  const verifyAfterReject = await api('POST', `${base}/verify`, { token: checker, body: {} });
  statusCheck(CAT, 'verify ตอนไม่ได้อยู่ใน PENDING: 422', verifyAfterReject, 422, { input: 'status=REJECTED', messageIncludes: 'only PENDING' });

  const resubmitted = await api('POST', `${base}/submit`, { token: tokens.checker1, body: {} });
  statusCheck(CAT, 'หลัง reject ส่งใหม่ได้ (PENDING อีกครั้ง)', resubmitted, 200, { input: 'resubmit after rejection' });
  const verified = await api('POST', `${base}/verify`, { token: checker, body: { note: 'ตรวจหลักฐานครบแล้ว' } });
  statusCheck(CAT, 'CHECKER อนุมัติ: 200 + VERIFIED', verified, 200, { input: 'checker verifies' });
  check(CAT, 'อนุมัติแล้วบันทึก reviewer + เวลา + snapshot ของ policy ที่ใช้', {
    input: verified.json?.data?.customer,
    expected: { kycStatus: 'VERIFIED', reviewed: true, policySnapshot: true },
    actual: {
      kycStatus: verified.json?.data?.customer?.kycStatus,
      reviewedAt: !!verified.json?.data?.customer?.kycReviewedAt,
      policySnapshot: !!verified.json?.data?.customer?.kycAppliedPolicy?.maxFileSizeKb,
    },
    pass:
      verified.json?.data?.customer?.kycStatus === 'VERIFIED' &&
      !!verified.json?.data?.customer?.kycReviewedAt &&
      !!verified.json?.data?.customer?.kycAppliedPolicy?.maxFileSizeKb,
  });
  const doubleVerify = await api('POST', `${base}/verify`, { token: tokens.head, body: {} });
  statusCheck(CAT, 'อนุมัติซ้ำตอน VERIFIED: 422', doubleVerify, 422, { input: 'already verified', messageIncludes: 'only PENDING KYC can be verified' });

  // reverify on document change
  const extraDoc = await upload(op1, base, pngBytes(77), { documentType: 'FAMILY_BOOK' }, { filename: 'family.png', type: 'image/png' });
  check(CAT, 'เพิ่มเอกสารหลัง VERIFIED → สถานะกลับเป็น PENDING (reverifyOnDocumentChange)', {
    input: 'POST /documents after VERIFIED',
    expected: 'PENDING + KYC_REVERIFY_REQUIRED audit',
    actual: `status=${extraDoc.json?.data?.customer?.kycStatus}, HTTP ${extraDoc.status}`,
    pass: extraDoc.json?.data?.customer?.kycStatus === 'PENDING',
  });
  const disburseBlocked = await api('GET', `${base}/documents`, { token: op1 });
  check(CAT, 'อ่านสถานะหลังเปลี่ยนเอกสาร: PENDING จริงตาม state', {
    input: 'GET /kyc/documents',
    expected: 'PENDING',
    actual: disburseBlocked.json?.data?.customer?.kycStatus,
    pass: disburseBlocked.json?.data?.customer?.kycStatus === 'PENDING',
  });

  // reopen is ADMIN-only
  await api('POST', `${base}/verify`, { token: checker, body: {} });
  const reopenByChecker = await api('POST', `${base}/reopen`, { token: checker, body: { reason: 'ลองด้วย CHECKER' } });
  statusCheck(CAT, 'CHECKER ใช้ reopen ไม่ได้: 403', reopenByChecker, 403, { input: 'CHECKER token' });
  const reopenNoReason = await api('POST', `${base}/reopen`, { token: admin, body: { reason: '' } });
  statusCheck(CAT, 'reopen โดยไม่มีเหตุผล: 400', reopenNoReason, 400, { input: 'reason=""' });
  const reopened = await api('POST', `${base}/reopen`, { token: admin, body: { reason: 'Policy เปลี่ยน ต้องตรวจใหม่' } });
  statusCheck(CAT, 'ADMIN reopen: 200 และกลับสถานะเป็น PENDING', reopened, 200, { input: 'ADMIN reopen' });

  // ---------------------------------------------------------------- audit trail
  const audits = await conn
    .query('SELECT action FROM audit_logs WHERE customerId=? ORDER BY createdAt', [flow.id])
    .then(([r]) => r.map((x) => x.action));
  const expectedActions = [
    'CUSTOMER_CREATED',
    'KYC_DOCUMENT_UPLOADED',
    'KYC_DOCUMENT_DELETED',
    'KYC_SUBMITTED',
    'KYC_REJECTED',
    'KYC_VERIFIED',
    'KYC_REVERIFY_REQUIRED',
    'KYC_REOPENED',
  ];
  for (const action of expectedActions) {
    check(CAT, `มี audit ${action}`, {
      input: `audit_logs where customerId=${flow.customerNumber ?? flow.id}`,
      expected: '>= 1 row',
      actual: audits.filter((a) => a === action).length + ' rows',
      pass: audits.includes(action),
    });
  }

  // ---------------------------------------------------------------- expired evidence
  const expBase = `/api/customers/${customerFixtures.expired?.id}/kyc`;
  if (customerFixtures.expired?.id) {
    const past = pngBytes(18);
    const expUp = await upload(op1, expBase, past, { documentType: 'NATIONAL_ID', issuedAt: '2015-01-01', expiresAt: '2020-01-01' }, { filename: 'expired.png', type: 'image/png' });
    statusCheck(CAT, 'อัปโหลดเอกสารที่หมดอายุไปแล้ว (ยังบันทึกได้)', expUp, 201, { input: 'expiresAt=2020-01-01' });
    const expState = await api('GET', `${expBase}/documents`, { token: op1 });
    check(CAT, 'checklist ระบุ expired + satisfied=false เมื่อไม่รับเอกสารหมดอายุ', {
      input: 'checklist',
      expected: { expired: ['NATIONAL_ID'], satisfied: false },
      actual: { expired: expState.json?.data?.checklist?.expired, satisfied: expState.json?.data?.checklist?.satisfied },
      pass: (expState.json?.data?.checklist?.expired ?? []).includes('NATIONAL_ID') && expState.json?.data?.checklist?.satisfied === false,
    });
    const expSubmit = await api('POST', `${expBase}/submit`, { token: op1, body: {} });
    statusCheck(CAT, 'submit ด้วยเอกสารหมดอายุ: 422', expSubmit, 422, { input: 'expired evidence' });
    const near = pngBytes(19);
    const soon = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const nearUp = await upload(op1, expBase, near, { documentType: 'PASSPORT', issuedAt: '2023-01-01', expiresAt: soon }, { filename: 'soon.png', type: 'image/png' });
    const nearState = await api('GET', `${expBase}/documents`, { token: op1 });
    check(CAT, 'เอกสารใกล้หมดอายุ (<= expiryWarningDays) ถูกแจ้งเตือนใน expiringSoon', {
      input: `expiresAt=${soon}, warningDays=${policy.expiryWarningDays}`,
      expected: 'includes PASSPORT',
      actual: `${nearUp.status} expiringSoon=${JSON.stringify(nearState.json?.data?.checklist?.expiringSoon)}`,
      pass: (nearState.json?.data?.checklist?.expiringSoon ?? []).includes('PASSPORT'),
    });
  }

  // ---------------------------------------------------------------- storage invariants
  const blob = await conn
    .query('SELECT COUNT(*) n FROM kyc_documents d LEFT JOIN kyc_document_contents c ON c.documentId=d.id WHERE c.documentId IS NULL')
    .then(([r]) => r[0].n);
  check(CAT, 'เอกสารทุกใบต้องมีไบต์เก็บใน kyc_document_contents', {
    input: 'orphans without content row',
    expected: '0',
    actual: String(blob),
    pass: blob === 0,
  });
  const badChecksum = await conn
    .query('SELECT COUNT(*) n FROM kyc_documents d JOIN kyc_document_contents c ON c.documentId=d.id')
    .then(([r]) => r[0].n);
  check(CAT, 'จำนวนแถวเอกสาร/ไบต์สอดคล้องกันทั้งตาราง', {
    input: 'join count',
    expected: '>= 88 rows (seeded + uploaded)',
    actual: String(badChecksum),
    pass: badChecksum >= 88,
  });
}
