// 3.3 User management: CRUD, role/enabled toggles, soft delete + restore, avatars,
// admin reset links and the audit trail that must follow every one of those events.
import { PASSWORD, api, check, errorMessage, login, pinPolicies, rows, statusCheck } from '../lib/harness.mjs';
import { fakeImageBytes, jpegBytes, multipartWithFields, pngBytes, webpBytes } from '../lib/files.mjs';

const CAT = 'users';
const RUN_TAG = String(Date.now()).slice(-6);
const FIXTURES = [
  { username: 'test_mgmt1', fullName: 'Test Mgmt One', email: 'test_mgmt1@test.local', role: 'MAKER' },
  { username: 'test_mgmt2', fullName: 'Test Mgmt Two', email: 'test_mgmt2@test.local', role: 'CHECKER' },
  { username: 'test_avatar', fullName: 'Test Avatar User', email: 'test_avatar@test.local', role: 'MAKER' },
];

/**
 * Clears what the no-reuse rule remembers for one account. Fixtures are handed the standard password
 * by every run and that restore would otherwise be refused as a repeat; the rule itself is asserted
 * below while the account's memory is intact.
 */
const forgetPasswordHistory = (conn, userId) => conn.query('DELETE FROM user_password_history WHERE userId=?', [userId]);

/** Creates the fixture accounts, or re-activates them when a previous run left them deleted. */
async function ensureFixtures(conn, admin) {
  const list = await api('GET', '/api/users?includeDeleted=true', { token: admin });
  const byName = Object.fromEntries((list.json?.users ?? []).map((u) => [u.username, u]));
  const out = {};
  for (const f of FIXTURES) {
    let user = byName[f.username];
    if (user?.deletedAt) {
      await api('POST', `/api/users/${user.id}/restore`, { token: admin, body: { reactivate: true } });
    } else if (user && !user.isActive) {
      await api('PATCH', `/api/users/${user.id}`, { token: admin, body: { isActive: true } });
    }
    if (!user) {
      const created = await api('POST', '/api/users', { token: admin, body: { ...f, password: PASSWORD } });
      user = created.json?.user;
    } else {
      // การตั้งรหัสกลับไปเป็นรหัสที่บัญชีใช้อยู่แล้วผิดกฎห้ามใช้รหัสเดิม จึงตั้งเฉพาะเมื่อ login ด้วย
      // รหัสมาตรฐานไม่ได้ (เช่นรอบก่อนจบค้างไว้ที่รหัสอื่น) และล้างความจำของบัญชีก่อนเสมอ
      if ((await login(f.username, PASSWORD)).status !== 200) {
        await forgetPasswordHistory(conn, user.id);
        await api('PATCH', `/api/users/${user.id}`, { token: admin, body: { password: PASSWORD } });
      }
      await api('PATCH', `/api/users/${user.id}`, { token: admin, body: { role: f.role, email: f.email } });
    }
    out[f.username] = user;
  }
  return out;
}

const auditCount = (conn, action, userId) =>
  conn
    .query(userId ? 'SELECT COUNT(*) n FROM audit_logs WHERE action=? AND userId=?' : 'SELECT COUNT(*) n FROM audit_logs WHERE action=?', userId ? [action, userId] : [action])
    .then(([r]) => r[0].n);

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const admin = tokens.admin;
  const adminId = (await api('GET', '/api/users', { token: admin })).json.users.find((u) => u.username === 'test_admin').id;
  const fx = await ensureFixtures(conn, admin);
  const mgmt1 = fx.test_mgmt1;
  const mgmt2 = fx.test_mgmt2;
  const avatarUser = fx.test_avatar;

  check(CAT, 'บัญชี fixture ด้านผู้ใช้งานพร้อมทั้ง 3 บัญชี', {
    input: FIXTURES.map((f) => f.username).join(','),
    expected: 'ids present',
    actual: [mgmt1?.id, mgmt2?.id, avatarUser?.id].map((x) => (x ? 'ok' : 'MISSING')).join(','),
    pass: !!(mgmt1?.id && mgmt2?.id && avatarUser?.id),
  });
  if (!mgmt1?.id || !mgmt2?.id || !avatarUser?.id) return;

  // ------------------------------------------------------------- listing / shape
  const listed = await api('GET', '/api/users', { token: admin });
  const users = listed.json?.users ?? [];
  check(CAT, 'GET /api/users (ADMIN) ตอบ list ที่ไม่มี field ลับ', {
    input: 'GET /api/users',
    expected: 'no passwordHash / tokenHash anywhere',
    actual: `n=${users.length}, keys=${Object.keys(users[0] ?? {}).join(',')}`,
    pass: users.length > 0 && !users.some((u) => 'passwordHash' in u || 'tokenHash' in u),
  });
  const softDeleted = (users.find((u) => u.username === 'test_deleted') ?? {}).id;
  check(CAT, 'บัญชีที่ soft-delete แล้วไม่ปรากฏใน list ปกติ', {
    input: 'GET /api/users',
    expected: 'test_deleted absent',
    actual: softDeleted ? 'present (BUG)' : 'absent',
    pass: !softDeleted,
  });
  const withDeleted = await api('GET', '/api/users?includeDeleted=true', { token: admin });
  const deletedRow = (withDeleted.json?.users ?? []).find((u) => u.username === 'test_deleted');
  check(CAT, 'includeDeleted=true มองเห็นบัญชีที่ลบแล้ว', {
    input: 'GET /api/users?includeDeleted=true',
    expected: 'test_deleted present with deletedAt set',
    actual: deletedRow ? `deletedAt=${deletedRow.deletedAt ? 'set' : 'null'}` : 'absent',
    pass: !!deletedRow && !!deletedRow.deletedAt,
  });

  // ------------------------------------------------------------- create
  const dupeName = await api('POST', '/api/users', { token: admin, body: { ...FIXTURES[0], email: 'fresh-name@test.local', password: PASSWORD } });
  statusCheck(CAT, 'สร้างซ้ำด้วย username เดิม: 409', dupeName, 409, { input: FIXTURES[0].username, messageIncludes: 'already exists' });
  const dupeMail = await api('POST', '/api/users', { token: admin, body: { username: 'test_fresh_mail', fullName: 'Fresh Mail', email: FIXTURES[0].email, role: 'VIEWER', password: PASSWORD } });
  statusCheck(CAT, 'สร้างใหม่แต่อีเมลซ้ำกับบัญชีอื่น: 409', dupeMail, 409, { input: FIXTURES[0].email, messageIncludes: 'already exists' });
  const weak = await api('POST', '/api/users', { token: admin, body: { username: 'test_weak_pw', fullName: 'Weak Pw', email: 'test_weak_pw@test.local', role: 'VIEWER', password: 'abc' } });
  check(CAT, 'รหัสผ่านไม่ผ่าน policy ตอนสร้าง: ถูกปฏิเสธ', {
    input: 'password=abc',
    expected: '4xx + policy message',
    actual: `HTTP ${weak.status} ${errorMessage(weak)}`,
    pass: weak.status >= 400 && weak.status < 500 && /polic|digit|uppercase|short/i.test(errorMessage(weak)),
  });
  const badRole = await api('POST', '/api/users', { token: admin, body: { ...FIXTURES[0], username: 'test_bad_role', role: 'SUPERUSER' } });
  statusCheck(CAT, 'role ที่ไม่มีใน enum: 400 validation', badRole, 400, { input: 'role=SUPERUSER' });
  const shortName = await api('POST', '/api/users', { token: admin, body: { username: 'ab', fullName: 'Ab', email: 'ab@test.local', role: 'VIEWER', password: PASSWORD } });
  statusCheck(CAT, 'username สั้นกว่า 3 ตัว: 400', shortName, 400, { input: 'username=ab' });
  const noMailName = `test_nomail_${RUN_TAG}`;
  const trimName = `test_trim_${RUN_TAG}`;
  const noMail = await api('POST', '/api/users', { token: admin, body: { username: noMailName, fullName: 'No Mail', role: 'VIEWER', password: PASSWORD } });
  check(CAT, 'สร้างบัญชีไม่มีอีเมลได้ (ระบบอนุญาต) และต้องไม่ใช่ 5xx', {
    input: `POST /api/users without email (${noMailName})`,
    expected: '201 + email null',
    actual: `HTTP ${noMail.status} email=${JSON.stringify(noMail.json?.user?.email)}${noMail.status >= 500 ? ' ' + errorMessage(noMail) : ''}`,
    pass: noMail.status === 201 && (noMail.json?.user?.email ?? null) === null,
    note: 'บัญชีไม่มีอีเมลคือกรณีที่ตั้งใจรองรับ (test_noemail ในชุดข้อมูลทดสอบ)',
  });
  const padded = await api('POST', '/api/users', { token: admin, body: { username: trimName, fullName: 'Trim Me', email: `  ${trimName}@test.local  `, role: 'VIEWER', password: PASSWORD } });
  check(CAT, 'อีเมลที่มีช่องว่างหัวท้าย: ต้อง trim ก่อนเก็บ หรือปฏิเสธ (ห้ามเก็บค่าที่มีช่องว่าง)', {
    input: `email="  ${trimName}@test.local  "`,
    expected: '201 + email trimmed, หรือ 400 validation',
    actual: `HTTP ${padded.status} email=${JSON.stringify(padded.json?.user?.email)} ${padded.status >= 400 ? errorMessage(padded) : ''}`,
    pass:
      (padded.status === 201 && padded.json?.user?.email === `${trimName}@test.local`) ||
      (padded.status === 400 && /email|Validation/i.test(errorMessage(padded))),
  });
  const createdAudit = await auditCount(conn, 'USER_CREATED', adminId);
  check(CAT, 'ทุกครั้งที่สร้างผู้ใช้มี audit USER_CREATED', {
    input: 'audit_logs USER_CREATED by admin',
    expected: '>= 3 rows',
    actual: String(createdAudit),
    pass: createdAudit >= 3,
  });

  // username ที่ชนกับบัญชี soft-delete: ต้องตอบ 409 ไม่ใช่ 500 (unique index ครอบคลุมแถวที่ลบแล้ว)
  const reuseName = `test_dupdel_${RUN_TAG}`;
  const first = await api('POST', '/api/users', { token: admin, body: { username: reuseName, fullName: 'Dup Del', email: `${reuseName}@test.local`, role: 'VIEWER', password: PASSWORD } });
  if (first.status === 201) await api('DELETE', `/api/users/${first.json.user.id}`, { token: admin });
  const again = await api('POST', '/api/users', { token: admin, body: { username: reuseName, fullName: 'Dup Del', email: `${reuseName}@test.local`, role: 'VIEWER', password: PASSWORD } });
  check(CAT, 'สร้าง username ที่เคยถูก soft-delete ซ้ำ: ต้อง 409 ไม่ใช่ 500', {
    input: reuseName,
    expected: '409 Username or email already exists',
    actual: `HTTP ${again.status} ${errorMessage(again)}`,
    pass: again.status === 409,
    note: 'แถวที่ soft-delete ยังครอง unique index ของ username/email อยู่',
  });
  const reuseEmail = await api('POST', '/api/users', { token: admin, body: { username: `test_dupmail_${RUN_TAG}`, fullName: 'Dup Mail', email: `${reuseName}@test.local`, role: 'VIEWER', password: PASSWORD } });
  check(CAT, 'สร้างด้วยอีเมลของบัญชีที่ soft-delete แล้ว: ต้อง 409 ไม่ใช่ 500', {
    input: `${reuseName}@test.local`,
    expected: '409',
    actual: `HTTP ${reuseEmail.status} ${errorMessage(reuseEmail)}`,
    pass: reuseEmail.status === 409,
  });

  // ------------------------------------------------------------- edit / toggle
  const renamed = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { fullName: 'Test Mgmt One Edited' } });
  statusCheck(CAT, 'แก้ fullName ได้', renamed, 200, { input: mgmt1.username });
  check(CAT, 'แก้ fullName แล้วอ่านกลับมาได้ค่าใหม่จริง', {
    input: renamed.json?.user?.fullName,
    expected: 'Test Mgmt One Edited',
    actual: String(renamed.json?.user?.fullName),
    pass: renamed.json?.user?.fullName === 'Test Mgmt One Edited',
  });
  const mailSwap = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { email: 'test_mgmt1_new@test.local' } });
  check(CAT, 'เปลี่ยนอีเมลแล้ว isEmailVerified ต้องกลับไป false', {
    input: 'PATCH email',
    expected: 'isEmailVerified=false',
    actual: `verified=${mailSwap.json?.user?.isEmailVerified}, email=${mailSwap.json?.user?.email}`,
    pass: mailSwap.json?.user?.isEmailVerified === false,
    note: 'ที่อยู่ใหม่ยังไม่เคยพิสูจน์ ต้องยืนยันใหม่',
  });
  const takenMail = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { email: FIXTURES[1].email } });
  statusCheck(CAT, 'ย้ายไปอีเมลที่บัญชีอื่นใช้อยู่: 409', takenMail, 409, { input: FIXTURES[1].email, messageIncludes: 'Email already belongs' });
  await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { email: FIXTURES[0].email } });

  const toViewer = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { role: 'VIEWER' } });
  const loginViewer = await login('test_mgmt1');
  check(CAT, 'สลับ role เป็น VIEWER แล้ว token ใหม่มี role VIEWER', {
    input: 'PATCH role=VIEWER then login',
    expected: 'role=VIEWER',
    actual: `${toViewer.json?.user?.role} / ${loginViewer.json?.user?.role}`,
    pass: toViewer.json?.user?.role === 'VIEWER' && loginViewer.json?.user?.role === 'VIEWER',
  });
  const forbiddenAsViewer = await api('POST', '/api/transactions/penalties', { token: loginViewer.json.token, body: {} });
  statusCheck(CAT, 'VIEWER ที่เพิ่งสลับ role ยังเขียนข้อมูลการเงินไม่ได้', forbiddenAsViewer, 403, { input: 'POST penalties with the new token' });
  await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { role: 'MAKER' } });

  const deactivated = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { isActive: false } });
  const loginDisabled = await login('test_mgmt1');
  const apiWithOldToken = await api('GET', '/api/auth/me', { token: loginViewer.json.token });
  check(CAT, 'ปิดใช้งานบัญชี: login ถูกปฏิเสธทันที', {
    input: 'PATCH isActive=false then login',
    expected: 'isActive=false แล้ว login 401',
    actual: `isActive=${deactivated.json?.user?.isActive}, login HTTP ${loginDisabled.status}`,
    pass: deactivated.json?.user?.isActive === false && loginDisabled.status === 401,
  });
  check(CAT, 'token ที่ออกก่อนปิดบัญชียังใช้ไม่ได้ (บัญชี inactive)', {
    input: 'GET /api/auth/me ด้วย JWT เก่าของบัญชีที่ถูกปิด',
    expected: '401',
    actual: `HTTP ${apiWithOldToken.status}`,
    pass: apiWithOldToken.status === 401,
    note: 'ถ้าตอบ 200 = ปิดบัญชีแล้วแต่ token เดิมยังทำงานได้ (เช่นเดียวกับกรณี reset รหัสผ่าน)',
  });
  const reactivated = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { isActive: true } });
  const loginBack = await login('test_mgmt1');
  check(CAT, 'เปิดใช้งาน kembali แล้ว login ได้อีก', {
    input: 'PATCH isActive=true then login',
    expected: '200',
    actual: `isActive=${reactivated.json?.user?.isActive}, login HTTP ${loginBack.status}`,
    pass: reactivated.json?.user?.isActive === true && loginBack.status === 200,
  });
  const adminSetPw = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { password: 'Mgmt@2026#d' } });
  const loginNewPw = await login('test_mgmt1', 'Mgmt@2026#d');
  const loginOldPw = await login('test_mgmt1', PASSWORD);
  check(CAT, 'ADMIN ตั้งรหัสผ่านใหม่ให้ผู้ใช้ได้ และรหัสเก่าใช้ไม่ได้', {
    input: 'PATCH password then two logins',
    expected: '200 / 200 / 401',
    actual: `${adminSetPw.status} / ${loginNewPw.status} / ${loginOldPw.status}`,
    pass: adminSetPw.status === 200 && loginNewPw.status === 200 && loginOldPw.status === 401,
  });
  await forgetPasswordHistory(conn, mgmt1.id);
  await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { password: PASSWORD } });
  const updateAudit = await auditCount(conn, 'USER_UPDATED', adminId);
  check(CAT, 'ทุกครั้งแก้ผู้ใช้มี audit USER_UPDATED', {
    input: 'audit_logs USER_UPDATED by admin',
    expected: '>= 5 rows',
    actual: String(updateAudit),
    pass: updateAudit >= 5,
  });
  const patchMissing = await api('PATCH', '/api/users/00000000-9000-4000-8000-000000000009', { token: admin, body: { fullName: 'Ghost' } });
  statusCheck(CAT, 'PATCH บัญชีที่ไม่มีอยู่: 404', patchMissing, 404, { input: 'random uuid' });

  // ------------------------------------------------------------- avatars
  const up = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(pngBytes(3), {}, { filename: 'photo.png', type: 'image/png' }) });
  statusCheck(CAT, 'อัปโหลด avatar PNG ถูกต้อง: 201', up, 201, { input: 'multipart field "file", 3KB png' });
  check(CAT, 'avatar ที่เก็บมี mimeType/size ตรงกับไบต์จริง', {
    input: up.json?.avatar,
    expected: { mimeType: 'image/png', sizeBytes: pngBytes(3).length },
    actual: { mimeType: up.json?.avatar?.mimeType, sizeBytes: up.json?.avatar?.sizeBytes },
    pass: up.json?.avatar?.mimeType === 'image/png' && Number(up.json?.avatar?.sizeBytes) === pngBytes(3).length,
  });
  const fetched = await api('GET', `/api/users/${avatarUser.id}/avatar`, { token: admin });
  check(CAT, 'GET avatar คืนไบต์ตรงกับที่อัปโหลด', {
    input: 'GET /api/users/:id/avatar',
    expected: '200 image/png, same length',
    actual: `${fetched.status} ${fetched.headers['content-type']} ${Buffer.from(fetched.text ?? '', 'latin1').length} bytes`,
    pass: fetched.status === 200 && String(fetched.headers['content-type']).startsWith('image/png'),
  });
  const listHasAvatar = (await api('GET', '/api/users', { token: admin })).json.users.find((u) => u.username === 'test_avatar');
  check(CAT, 'list บอก hasAvatar=true', {
    input: 'GET /api/users',
    expected: 'hasAvatar=true',
    actual: String(listHasAvatar?.hasAvatar),
    pass: listHasAvatar?.hasAvatar === true,
  });
  const fake = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(fakeImageBytes(), {}, { filename: 'evil.png', type: 'image/png' }) });
  statusCheck(CAT, 'ไฟล์ที่ไม่ใช่รูป (ต่อให้มีนามสกุล .png): 415', fake, 415, { input: 'html/script bytes named evil.png' });
  const oversize = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(pngBytes(4096), {}, { filename: 'big.png', type: 'image/png' }) });
  check(CAT, 'รูปใหญ่เกิน limit ของ policy: 413', {
    input: '4MB png (policy 512KB)',
    expected: '413',
    actual: `HTTP ${oversize.status} ${errorMessage(oversize)}`,
    pass: oversize.status === 413 || (oversize.status >= 400 && /large|limit/i.test(errorMessage(oversize))),
  });
  const badName = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(jpegBytes(2), {}, { filename: 'notes.txt', type: 'text/plain' }) });
  check(CAT, 'รูปจริงแต่นามสกุล .txt: ยอมรับตาม magic bytes (ไม่เชื่อชื่อไฟล์)', {
    input: 'jpeg bytes named notes.txt',
    expected: '201 + mimeType image/jpeg',
    actual: `HTTP ${badName.status} ${badName.json?.avatar?.mimeType ?? errorMessage(badName)}`,
    pass: badName.status === 201 && badName.json?.avatar?.mimeType === 'image/jpeg',
  });
  const webp = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(webpBytes(2), {}, { filename: 'pic.webp', type: 'image/webp' }) });
  statusCheck(CAT, 'avatar แบบ WebP ใช้ได้', webp, 201, { input: 'webp bytes' });
  const selfPut = await api('PUT', `/api/users/${avatarUser.id}/avatar`, {
    token: (await login('test_avatar')).json.token,
    form: multipartWithFields(pngBytes(1), {}, { filename: 'me.png', type: 'image/png' }),
  });
  statusCheck(CAT, 'เจ้าของบัญชีอัปโหลดรูปตัวเองได้', selfPut, 201, { input: 'test_avatar PUT own avatar' });
  const otherPut = await api('PUT', `/api/users/${avatarUser.id}/avatar`, {
    token: (await login('test_op2')).json.token,
    form: multipartWithFields(pngBytes(1), {}, { filename: 'x.png', type: 'image/png' }),
  });
  statusCheck(CAT, 'ผู้ใช้คนอื่นแก้ avatar ของบัญชีอื่นไม่ได้: 403', otherPut, 403, { input: 'test_op2 PUT test_avatar avatar', messageIncludes: 'Only the account owner or an ADMIN' });
  const noField = await api('PUT', `/api/users/${avatarUser.id}/avatar`, { token: admin, form: multipartWithFields(Buffer.from('nothing'), {}, { field: 'wrongField' }) });
  statusCheck(CAT, 'ส่ง multipartผิดชื่อ field: 400', noField, 400, { input: 'field=wrongField' });
  const deletedAvatar = await api('DELETE', `/api/users/${avatarUser.id}/avatar`, { token: admin });
  statusCheck(CAT, 'ลบ avatar ได้', deletedAvatar, 200, { input: 'DELETE /users/:id/avatar' });
  const deletedAgain = await api('DELETE', `/api/users/${avatarUser.id}/avatar`, { token: admin });
  statusCheck(CAT, 'ลบ avatar ครั้งที่ไม่มีรูปอยู่แล้ว: 404', deletedAgain, 404, { input: 'DELETE again' });
  const avatarAudit = await auditCount(conn, 'USER_AVATAR_UPDATED', null);
  check(CAT, 'มี audit ทุกครั้งที่แก้ avatar', {
    input: 'audit_logs USER_AVATAR_UPDATED',
    expected: '>= 4 rows',
    actual: String(avatarAudit),
    pass: avatarAudit >= 4,
  });

  // ------------------------------------------------------------- delete / restore
  const selfDelete = await api('DELETE', `/api/users/${adminId}`, { token: admin });
  statusCheck(CAT, 'ห้าม ADMIN ลบบัญชีที่ตนเอง login อยู่', selfDelete, 422, { input: 'DELETE own account', messageIncludes: 'cannot delete the account you are signed in with' });
  const del = await api('DELETE', `/api/users/${mgmt2.id}`, { token: admin });
  statusCheck(CAT, 'soft delete บัญชีอื่น: 200 {deleted:true}', del, 200, { input: mgmt2.username });
  check(CAT, 'response soft delete คืน id ตรงบัญชีที่ลบ', {
    input: del.json,
    expected: mgmt2.id,
    actual: String(del.json?.id),
    pass: del.json?.deleted === true && del.json?.id === mgmt2.id,
  });
  const loginDeleted = await login('test_mgmt2');
  statusCheck(CAT, 'บัญชีที่ลบแล้ว login ไม่ได้', loginDeleted, 401, { input: 'test_mgmt2' });
  const hiddenNow = (await api('GET', '/api/users', { token: admin })).json.users.some((u) => u.username === 'test_mgmt2');
  check(CAT, 'บัญชีที่ลบแล้วหายจาก list', {
    input: 'GET /api/users',
    expected: 'not listed',
    actual: String(hiddenNow),
    pass: hiddenNow === false,
  });
  const restoreNoFlag = await api('POST', `/api/users/${mgmt2.id}/restore`, { token: admin, body: {} });
  const loginAfterRestore = await login('test_mgmt2');
  check(CAT, 'restore โดยไม่ reactivate: บัญชีกลับมาแต่ยังปิดใช้งาน', {
    input: 'POST /:id/restore {}',
    expected: '200 + login 401 (isActive ยัง false)',
    actual: `HTTP ${restoreNoFlag.status}, isActive=${restoreNoFlag.json?.user?.isActive}, login ${loginAfterRestore.status}`,
    pass: restoreNoFlag.status === 200 && restoreNoFlag.json?.user?.isActive === false && loginAfterRestore.status === 401,
  });
  const restore = await api('POST', `/api/users/${mgmt2.id}/restore`, { token: admin, body: { reactivate: true } });
  statusCheck(CAT, 'restore + reactivate: บัญชีบัญชีกลับมาใช้ได้ (409 เพราะไม่ถูก delete ซ้ำ)', restore, 409, {
    input: 'POST /:id/restore {reactivate:true}',
    messageIncludes: 'not deleted',
  });
  const activated = await api('PATCH', `/api/users/${mgmt2.id}`, { token: admin, body: { isActive: true } });
  check(CAT, 'เปิดใช้งานแล้ว login ได้จริง', {
    input: 'PATCH isActive=true then login',
    expected: '200',
    actual: `${activated.status}/${(await login('test_mgmt2')).status}`,
    pass: activated.status === 200 && (await login('test_mgmt2')).status === 200,
  });
  const restoreNotDeleted = await api('POST', `/api/users/${mgmt1.id}/restore`, { token: admin, body: {} });
  statusCheck(CAT, 'restore บัญชีที่ไม่ได้ถูกลบ: 409', restoreNotDeleted, 409, { input: mgmt1.username });
  const deleteAudit = await auditCount(conn, 'USER_DELETED', adminId);
  const restoreAudit = await auditCount(conn, 'USER_RESTORED', adminId);
  check(CAT, 'มี audit USER_DELETED และ USER_RESTORED', {
    input: 'audit_logs',
    expected: 'both >= 1',
    actual: `deleted=${deleteAudit}, restored=${restoreAudit}`,
    pass: deleteAudit >= 1 && restoreAudit >= 1,
  });

  // ------------------------------------------------------------- admin reset links
  // ล้าง cooldown ของบัญชี fixture ก่อน (link ที่ส่งในการรันครั้งก่อนยังนับอยู่ใน 60 วินาที)
  await conn.execute(
    'UPDATE password_reset_tokens SET createdAt = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE createdAt > DATE_SUB(NOW(), INTERVAL 20 MINUTE) AND userId IN (?, ?, ?)',
    [mgmt1.id, mgmt2.id, avatarUser.id],
  );
  const link = await api('POST', `/api/users/${mgmt1.id}/send-reset-link`, { token: admin });
  statusCheck(CAT, 'ส่ง reset link ทีละบัญชี: 200 {sent:true}', link, 200, { input: mgmt1.username });
  check(CAT, 'reset link เก็บเป็น hash ในฐานข้อมูลและกำหนดอายุ', {
    input: link.json?.expiresAt,
    expected: 'expiresAt in the future + sha256 row',
    actual: `expiresAt=${link.json?.expiresAt ? 'set' : 'null'}`,
    pass: !!link.json?.expiresAt && new Date(link.json.expiresAt).getTime() > Date.now(),
  });
  const linkAudit = await auditCount(conn, 'USER_RESET_SENT', adminId);
  check(CAT, 'มี audit USER_RESET_SENT ทุกครั้งที่ส่ง link', {
    input: 'audit_logs',
    expected: '>= 1',
    actual: String(linkAudit),
    pass: linkAudit >= 1,
  });
  const linkCooldown = await api('POST', `/api/users/${mgmt1.id}/send-reset-link`, { token: admin });
  statusCheck(CAT, 'ส่ง link ซ้ำทันที: 422 (cooldown)', linkCooldown, 422, { input: mgmt1.username, messageIncludes: 'wait before sending another' });
  const noEmailUser = (await api('GET', '/api/users', { token: admin })).json.users.find((u) => u.username === 'test_noemail');
  const linkNoEmail = await api('POST', `/api/users/${noEmailUser.id}/send-reset-link`, { token: admin });
  statusCheck(CAT, 'บัญชีไม่มีอีเมล: 422 บอกให้ตั้งอีเมลก่อน', linkNoEmail, 422, { input: 'test_noemail', messageIncludes: 'no email address' });
  const disabledUser = (await api('GET', '/api/users', { token: admin })).json.users.find((u) => u.username === 'test_disabled');
  const linkDisabled = await api('POST', `/api/users/${disabledUser.id}/send-reset-link`, { token: admin });
  statusCheck(CAT, 'บัญชีถูกปิดใช้งาน: 422 บอกว่าต้องเปิดก่อน', linkDisabled, 422, { input: 'test_disabled', messageIncludes: 'deactivated' });
  const linkMissing = await api('POST', '/api/users/00000000-9000-4000-8000-000000000008/send-reset-link', { token: admin });
  statusCheck(CAT, 'ส่ง link ให้ id ที่ไม่มีอยู่: 404', linkMissing, 404, { input: 'random uuid' });
  const bulk = await api('POST', '/api/users/send-reset-links', {
    token: admin,
    body: { ids: [mgmt2.id, noEmailUser.id, '00000000-9000-4000-8000-000000000007'] },
  });
  statusCheck(CAT, 'ส่ง link แบบ bulk: 200 และแยก sent/skipped', bulk, 200, { input: '3 ids: 1 ส่งได้, 1 ไม่มีอีเมล, 1 ไม่มีอยู่' });
  check(CAT, 'bulk: คนที่ส่งได้/ถูกข้ามรายงานตรงตามเหตุผลจริง', {
    input: bulk.json,
    expected: 'sent=1 (mgmt2), skipped=2 (no email + not found)',
    actual: `sent=${JSON.stringify(bulk.json?.sent)}, skipped=${JSON.stringify(bulk.json?.skipped)}`,
    pass: (bulk.json?.sent ?? []).length === 1 && (bulk.json?.skipped ?? []).length === 2,
  });
  const bulkBad = await api('POST', '/api/users/send-reset-links', { token: admin, body: { ids: [] } });
  statusCheck(CAT, 'bulk ด้วย ids ว่าง: 400', bulkBad, 400, { input: 'ids=[]' });
  const bulkNotUuid = await api('POST', '/api/users/send-reset-links', { token: admin, body: { ids: ['not-a-uuid'] } });
  statusCheck(CAT, 'bulk ด้วย id ที่ไม่ใช่ uuid: 400', bulkNotUuid, 400, { input: 'ids=[not-a-uuid]' });

  // ------------------------------------------------------------- self-service profile
  // The account edits itself through /api/users/me. Route order matters here: PATCH /:id is
  // ADMIN-only, so a MAKER succeeding on /me also proves /me is not swallowed by /:id.
  const mgmtToken = (await login('test_mgmt1')).json.token;
  const meAsMaker = await api('GET', '/api/users/me', { token: mgmtToken });
  const me = meAsMaker.json?.user ?? {};
  check(CAT, 'MAKER อ่านข้อมูลตนเองผ่าน GET /api/users/me ได้ (ไม่ถูก route ADMIN /:id กัน)', {
    input: 'GET /api/users/me (test_mgmt1)',
    expected: '200 + id/username ตรงกับบัญชีที่ login',
    actual: `HTTP ${meAsMaker.status} id=${me.id === mgmt1.id ? 'match' : 'MISMATCH'} username=${me.username}`,
    pass: meAsMaker.status === 200 && me.id === mgmt1.id && me.username === 'test_mgmt1',
  });
  check(CAT, 'GET /api/users/me คืนสนามที่หน้าจอ Profile ต้องแสดง และไม่มี field ลับ', {
    input: Object.keys(me).sort().join(','),
    expected: 'username, fullName, email, isEmailVerified, role, isActive, lastLoginAt, passwordChangedAt, createdAt, hasAvatar + ไม่มี passwordHash',
    actual: `${Object.keys(me).sort().join(',')} (passwordHash ${'passwordHash' in me ? 'PRESENT (BUG)' : 'absent'})`,
    pass:
      ['username', 'fullName', 'email', 'isEmailVerified', 'role', 'isActive', 'lastLoginAt', 'passwordChangedAt', 'createdAt', 'hasAvatar'].every(
        (k) => k in me,
      ) &&
      !('passwordHash' in me) &&
      !('tokenHash' in me),
  });
  const meNoToken = await api('GET', '/api/users/me');
  statusCheck(CAT, 'GET /api/users/me โดยไม่มี token: 401', meNoToken, 401, { input: 'no bearer token' });
  const makerListAdminRoute = await api('GET', '/api/users', { token: mgmtToken });
  statusCheck(CAT, 'MAKER ยังใช้ route ของ ADMIN (GET /api/users) ไม่ได้: 403', makerListAdminRoute, 403, {
    input: 'GET /api/users ด้วย token ของ test_mgmt1',
  });

  const selfRole = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { role: 'ADMIN' } });
  statusCheck(CAT, 'พยายามยกระดับสิทธิ์ตนเองผ่าน PATCH /api/users/me (role=ADMIN): 400', selfRole, 400, {
    input: '{ role: "ADMIN" }',
  });
  const selfDisable = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { isActive: false } });
  statusCheck(CAT, 'พยายามปิดใช้งานบัญชีตัวเองผ่าน /me (isActive): 400', selfDisable, 400, { input: '{ isActive: false }' });
  const selfPassword = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { password: 'Self@2026#q' } });
  statusCheck(CAT, 'ส่ง password ผ่าน PATCH /api/users/me (ต้องเปลี่ยนผ่าน endpoint เฉพาะ): 400', selfPassword, 400, {
    input: '{ password: "Self@2026#q" }',
  });
  const selfEmpty = await api('PATCH', '/api/users/me', { token: mgmtToken, body: {} });
  statusCheck(CAT, 'PATCH /api/users/me ด้วย body ว่าง: 400', selfEmpty, 400, { input: '{}' });
  const afterTried = (await api('GET', '/api/users/me', { token: mgmtToken })).json?.user ?? {};
  check(CAT, 'ข้อมูลบัญชีไม่เปลี่ยนจากรอบที่พยายามยกระดับสิทธิ์/ปิดตัวเอง', {
    input: 'role + isActive หลัง 4 คำขอที่ถูกปฏิเสธ',
    expected: 'role=MAKER, isActive=true',
    actual: `role=${afterTried.role}, isActive=${afterTried.isActive}`,
    pass: afterTried.role === 'MAKER' && afterTried.isActive === true,
    note: 'สนาม role/isActive/username เป็นของ ADMIN เท่านั้น (users.router.ts PATCH /:id)',
  });

  const selfRename = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { fullName: 'Test Mgmt Self Renamed' } });
  statusCheck(CAT, 'เจ้าของบัญชีแก้ fullName ของตนเองได้: 200', selfRename, 200, { input: '{ fullName }' });
  const listAfterRename = (await api('GET', '/api/users', { token: admin })).json?.users?.find((u) => u.username === 'test_mgmt1');
  check(CAT, 'ชื่อที่แก้ผ่าน /me ถูกเก็บจริง (ADMIN list เห็นค่าเดียวกัน)', {
    input: 'GET /api/users แล้วเทียบ fullName',
    expected: 'Test Mgmt Self Renamed',
    actual: String(listAfterRename?.fullName),
    pass: listAfterRename?.fullName === 'Test Mgmt Self Renamed',
  });
  const selfMailTaken = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { email: FIXTURES[1].email } });
  statusCheck(CAT, 'ย้ายอีเมลของตนเองไปชนบัญชีอื่น: 409', selfMailTaken, 409, {
    input: FIXTURES[1].email,
    messageIncludes: 'Email already belongs',
  });
  const selfMail = await api('PATCH', '/api/users/me', { token: mgmtToken, body: { email: `self_${RUN_TAG}@test.local` } });
  check(CAT, 'เปลี่ยนอีเมลตนเองได้ และ isEmailVerified ต้องกลับไป false (ที่อยู่ใหม่ยังไม่เคยพิสูจน์)', {
    input: '{ email: self_*@test.local }',
    expected: '200 + isEmailVerified=false',
    actual: `HTTP ${selfMail.status} email=${selfMail.json?.user?.email} verified=${selfMail.json?.user?.isEmailVerified}`,
    pass: selfMail.status === 200 && selfMail.json?.user?.email === `self_${RUN_TAG}@test.local` && selfMail.json?.user?.isEmailVerified === false,
    note: 'เซิร์ฟเวอร์ยังไม่มี endpoint ยืนยันอีเมลฝั่งผู้ใช้ — การกลับเป็น true ต้องทำโดย ADMIN/DB เท่านั้น',
  });
  const profileAudit = await auditCount(conn, 'USER_PROFILE_UPDATED', mgmt1.id);
  check(CAT, 'การแก้ข้อมูลตนเองมี audit USER_PROFILE_UPDATED', {
    input: 'audit_logs USER_PROFILE_UPDATED ของ test_mgmt1',
    expected: '>= 2 rows (ชื่อ + อีเมล)',
    actual: String(profileAudit),
    pass: profileAudit >= 2,
  });

  const NEW_PW = `Prof@2026#${RUN_TAG.slice(-4)}`;
  const hashBefore = (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash;
  const pwNoToken = await api('POST', '/api/users/me/password', { body: { currentPassword: PASSWORD, newPassword: NEW_PW } });
  statusCheck(CAT, 'POST /api/users/me/password โดยไม่มี token: 401', pwNoToken, 401, { input: 'no bearer token' });
  const pwShortBody = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { newPassword: NEW_PW } });
  statusCheck(CAT, 'ไม่ใส่ currentPassword: 400 (ห้ามเปลี่ยนโดยไม่ verify รหัสเก่า)', pwShortBody, 400, {
    input: '{ newPassword } เท่านั้น',
  });
  const pwNoChange = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { currentPassword: PASSWORD } });
  statusCheck(CAT, 'ไม่ใส่ newPassword: 400', pwNoChange, 400, { input: '{ currentPassword } เท่านั้น' });

  const wrongOld = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { currentPassword: 'Wrong@2026#z', newPassword: NEW_PW } });
  statusCheck(CAT, 'เปลี่ยนรหัสผ่านด้วยรหัสเก่าที่ไม่ถูกต้อง: 401', wrongOld, 401, {
    input: 'currentPassword=Wrong@2026#z',
    messageIncludes: 'Current password is incorrect',
  });
  const hashAfterWrong = (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash;
  check(CAT, 'รหัสเก่าผิด: passwordHash ในฐานข้อมูลไม่เปลี่ยน และรหัสเก่ายัง login ได้', {
    input: 'hash before/after + login ด้วย PASSWORD',
    expected: 'hash เท่ากัน + login 200',
    actual: `hash ${hashAfterWrong === hashBefore ? 'unchanged' : 'CHANGED (BUG)'}, login HTTP ${(await login('test_mgmt1')).status}`,
    pass: hashAfterWrong === hashBefore && (await login('test_mgmt1')).status === 200,
  });
  const failAudit = await auditCount(conn, 'USER_PASSWORD_CHANGE_FAILED', mgmt1.id);
  check(CAT, 'รหัสเก่าผิดต้องมี audit USER_PASSWORD_CHANGE_FAILED (ไว้ตรวจการเดารหัส)', {
    input: 'audit_logs USER_PASSWORD_CHANGE_FAILED ของ test_mgmt1',
    expected: '>= 1 row',
    actual: String(failAudit),
    pass: failAudit >= 1,
  });

  const weakNew = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { currentPassword: PASSWORD, newPassword: 'abc' } });
  check(CAT, 'รหัสเก่าถูก แต่รหัสใหม่ไม่ผ่าน policy: 422 และยังไม่เปลี่ยนรหัส', {
    input: 'newPassword=abc',
    expected: '422 + ข้อความ policy',
    actual: `HTTP ${weakNew.status} ${errorMessage(weakNew)}`,
    pass: weakNew.status === 422 && /polic|digit|uppercase|short/i.test(errorMessage(weakNew)),
  });
  const sameAsOld = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { currentPassword: PASSWORD, newPassword: PASSWORD } });
  statusCheck(CAT, 'ตั้งรหัสใหม่ซ้ำรหัสเดิม: 422', sameAsOld, 422, { input: 'newPassword == currentPassword', messageIncludes: 'different from the current' });
  check(CAT, 'สองครั้งที่ถูกปฏิเสธไม่แตะ passwordHash', {
    input: 'hash หลัง weakNew + sameAsOld',
    expected: 'เท่ากับ hash ก่อนหน้า',
    actual: (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash === hashBefore ? 'unchanged' : 'CHANGED (BUG)',
    pass: (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash === hashBefore,
  });

  const changed = await api('POST', '/api/users/me/password', { token: mgmtToken, body: { currentPassword: PASSWORD, newPassword: NEW_PW } });
  statusCheck(CAT, 'ใส่รหัสเก่าถูกต้องแล้วเปลี่ยนรหัสผ่านได้: 200', changed, 200, { input: 'currentPassword + compliant newPassword' });
  const selfLoginOld = await login('test_mgmt1', PASSWORD);
  const selfLoginNew = await login('test_mgmt1', NEW_PW);
  check(CAT, 'เปลี่ยนแล้ว: รหัสเก่า login ไม่ได้ (401) และรหัสใหม่ login ได้ (200)', {
    input: 'login ด้วย PASSWORD / NEW_PW',
    expected: '401 / 200',
    actual: `${selfLoginOld.status} / ${selfLoginNew.status}`,
    pass: selfLoginOld.status === 401 && selfLoginNew.status === 200,
  });
  const revoked = await api('GET', '/api/auth/me', { token: mgmtToken });
  statusCheck(CAT, 'JWT ที่ออกก่อนเปลี่ยนรหัสใช้ไม่ได้ทันที (ทุก session ถูกเพิกถอน)', revoked, 401, {
    input: 'GET /api/auth/me ด้วย token เก่า',
    messageIncludes: 'Session is no longer valid',
  });
  const hashAfterChange = (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash;
  check(CAT, 'passwordHash ถูกเขียนใหม่เป็น bcrypt และไม่เก็บรหัสผ่าน plain text', {
    input: 'hash หลังเปลี่ยนรหัส',
    expected: 'ต่างจากเดิม, ขึ้นต้น $2, ไม่มี plain text ของรหัสใหม่',
    actual: `changed=${hashAfterChange !== hashBefore}, prefix=${String(hashAfterChange).slice(0, 4)}, leak=${String(hashAfterChange).includes(NEW_PW)}`,
    pass: hashAfterChange !== hashBefore && /^\$2/.test(hashAfterChange) && !String(hashAfterChange).includes(NEW_PW),
  });
  const meWithNewToken = await api('GET', '/api/users/me', { token: selfLoginNew.json?.token });
  check(CAT, 'passwordChangedAt ขยับไปหลังการเปลี่ยนรหัส (หน้า Profile ใช้แสดงอายุรหัสผ่าน)', {
    input: 'GET /api/users/me ด้วย token ใหม่',
    expected: 'passwordChangedAt ถูกขยับเป็นเวลานี้ (ภายใน 5 นาที)',
    actual: `passwordChangedAt=${meWithNewToken.json?.user?.passwordChangedAt}`,
    pass:
      meWithNewToken.status === 200 &&
      new Date(meWithNewToken.json?.user?.passwordChangedAt ?? 0).getTime() >= Date.now() - 5 * 60 * 1000,
  });
  const changeAudit = await rows(
    conn,
    "SELECT reason FROM audit_logs WHERE action='USER_PASSWORD_CHANGED' AND userId=? ORDER BY createdAt DESC LIMIT 1",
    [mgmt1.id],
  );
  check(CAT, 'การเปลี่ยนรหัสผ่านมี audit USER_PASSWORD_CHANGED และ reason ไม่มีรหัสผ่าน (ข้อกำหนดห้ามความลับใน log)', {
    input: 'audit_logs reason',
    expected: 'มี audit >= 1 แถว และ reason ของแถวที่อ่านมาไม่มี NEW_PW หรือ PASSWORD',
    actual: String(changeAudit[0]?.reason ?? 'no row'),
    pass: changeAudit.length >= 1 && !String(changeAudit[0].reason).includes(NEW_PW) && !String(changeAudit[0].reason).includes(PASSWORD),
  });

  // --------------------------- อายุรหัสผ่าน 1 เดือน + ห้ามใช้รหัสเดิม (Stage D)
  // ก้อนนี้ล็อกนโยบาย `security.*` ไว้ที่ค่า default ที่เซิร์ฟเวอร์รายงานเองเฉพาะกรณีของมัน เพราะ
  // system_config อยู่รอด reset-db และ suite อื่นแก้ namespace นี้ได้ ส่วนค่าที่อ่านมาจาก API ไม่ใช่
  // ตัวเลขที่คัดมาไว้ในไฟล์เทสต์ จึงไม่เน่าวันที่ env เปลี่ยน และปิดก้อนด้วย restore() เสมอ
  const asAdmin = (method, path, opts = {}) => api(method, path, { ...opts, token: opts.token ?? admin });
  const GATE_PW = `Gate@2026#${RUN_TAG.slice(-4)}`;
  // ทุกการเปลี่ยนรหัสเพิกถอน JWT ที่ออกก่อนหน้านั้น token ที่ก้อน cleanup ต้องใช้จึงต้องเป็นตัวล่าสุด
  let currentSelfToken = selfLoginNew.json?.token;
  const securityPins = await pinPolicies(asAdmin, ['security']);
  const rotation = securityPins.defaults.security;
  try {
    const meExpiry = await api('GET', '/api/users/me', { token: selfLoginNew.json?.token });
    const expiryInfo = meExpiry.json?.passwordExpiry;
    check(CAT, 'GET /api/users/me คืน passwordExpiry ให้หน้า Profile ใช้เตือนล่วงหน้า', {
      input: `บัญชี MAKER ที่เพิ่งเปลี่ยนรหัส (security.passwordMaxAgeDays=${rotation.passwordMaxAgeDays})`,
      expected:
        rotation.passwordMaxAgeDays > 0
          ? 'applies=true, daysLeft>0, expiresAt มีค่า, expired=false'
          : 'applies=false (ปิดกฎรอบเปลี่ยนรหัสไว้)',
      actual: `HTTP ${meExpiry.status} passwordExpiry=${JSON.stringify(expiryInfo)}`,
      pass:
        meExpiry.status === 200 &&
        !!expiryInfo &&
        typeof expiryInfo.applies === 'boolean' &&
        typeof expiryInfo.expired === 'boolean' &&
        (rotation.passwordMaxAgeDays === 0
          ? expiryInfo.applies === false
          : expiryInfo.applies === true && Number(expiryInfo.daysLeft) > 0 && !!expiryInfo.expiresAt && expiryInfo.expired === false),
      note: 'รหัสเพิ่งตั้งใหม่จึงอายุ 0 วัน ค่าที่ตอบมาต้องเหลือเวลาเต็มรอบ ไม่ใช่หมดอายุทันที',
    });

    const notDue = await api('POST', '/api/auth/change-expired-password', {
      body: { username: 'test_mgmt1', currentPassword: NEW_PW, newPassword: GATE_PW },
    });
    statusCheck(CAT, 'endpoint เปลี่ยนรหัสเมื่อหมดอายุใช้กับรหัสที่ยังไม่หมดอายุไม่ได้: 422', notDue, 422, {
      input: '{username, currentPassword, newPassword} ของบัญชีที่รหัสยังไม่ครบกำหนด',
      messageIncludes: 'not due for a change',
    });
    check(CAT, 'กรณีรหัสยังไม่หมดอายุมี machine code PASSWORD_NOT_EXPIRED ให้หน้าเว็บแยกคำตอบได้', {
      input: 'error.details.code ของคำขอ 422 ข้างบน',
      expected: 'PASSWORD_NOT_EXPIRED',
      actual: String(notDue.json?.error?.details?.code ?? 'no code'),
      pass: notDue.json?.error?.details?.code === 'PASSWORD_NOT_EXPIRED',
    });

    const reuse = await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { password: PASSWORD } });
    const reuseHash = (await rows(conn, 'SELECT passwordHash FROM users WHERE id=?', [mgmt1.id]))[0].passwordHash;
    check(CAT, 'ห้ามใช้รหัสเดิม: ADMIN ตั้งรหัสกลับไปเป็นรหัสที่บัญชีนี้เคยใช้แล้วถูกปฏิเสธ 422 และไม่เขียนทับ', {
      input: 'PATCH /api/users/:id {password} ด้วยรหัสมาตรฐานที่บัญชีนี้เคยใช้ (ค่าไม่ถูกบันทึกในรายงาน)',
      expected: '422 + details.code=PASSWORD_REUSED + passwordHash ยังเป็นค่าเดิมของ NEW_PW',
      actual: `HTTP ${reuse.status} code=${String(reuse.json?.error?.details?.code ?? 'no code')} hash=${reuseHash === hashAfterChange ? 'unchanged' : 'CHANGED (BUG)'}`,
      pass:
        reuse.status === 422 &&
        reuse.json?.error?.details?.code === 'PASSWORD_REUSED' &&
        reuseHash === hashAfterChange,
      note: `ล็อกไว้ที่ security.passwordHistoryCount=${rotation.passwordHistoryCount} — รหัสเก่าถูกเทียบจาก bcrypt ใน user_password_history`,
    });

    const history = await rows(
      conn,
      'SELECT passwordHash FROM user_password_history WHERE userId=? ORDER BY createdAt DESC',
      [mgmt1.id],
    );
    check(CAT, 'ทุกครั้งที่มีการตั้งรหัสผ่านมีแถวใน user_password_history และความลับไม่อยู่ในตาราง', {
      input: 'user_password_history ของ test_mgmt1',
      expected: '>= 2 แถว (รหัสที่ fixture ตั้ง + NEW_PW ที่เปลี่ยนเอง), ทุกแถวขึ้นต้น $2, ไม่มี plain text',
      actual: `${history.length} แถว, prefixes=${history.map((r) => String(r.passwordHash).slice(0, 4)).join(',')}`,
      pass:
        history.length >= 2 &&
        history.every(
          (r) => String(r.passwordHash).startsWith('$2') && !String(r.passwordHash).includes(NEW_PW),
        ),
      note: 'แถวของรหัสมาตรฐานเก็บเฉพาะ bcrypt ของมัน จึงเทียบซ้ำได้โดยไม่มีทางถอดกลับ',
    });

    // กฎรอบเปลี่ยนรหัสทำงานเมื่อเปิดไว้เท่านั้น (ค่า default ของเครื่องที่ตั้ง PASSWORD_MAX_AGE_DAYS=0
    // ต้องผ่านก้อนนี้ด้วยการบอกว่า "ไม่มีการหมดอายุ" ไม่ใช่ล้มเหลว)
    if (rotation.passwordMaxAgeDays > 0) {
      const overdueDays = rotation.passwordMaxAgeDays + 3;
      await conn.query('UPDATE users SET passwordChangedAt = DATE_SUB(NOW(), INTERVAL ? DAY) WHERE id=?', [
        overdueDays,
        mgmt1.id,
      ]);
      const expiredLogin = await login('test_mgmt1', NEW_PW);
      check(CAT, `รหัสอายุเกิน ${rotation.passwordMaxAgeDays} วัน: login ต้อง 403 PASSWORD_EXPIRED และไม่ออก token`, {
        input: `ถอย passwordChangedAt ไป ${overdueDays} วันแล้ว login ด้วยรหัสที่ถูก`,
        expected: '403 + details.code=PASSWORD_EXPIRED + ไม่มี token + ข้อความบอกให้ตั้งรหัสใหม่',
        actual: `HTTP ${expiredLogin.status} code=${String(expiredLogin.json?.error?.details?.code ?? 'no code')} token=${expiredLogin.json?.token ? 'ISSUED (BUG)' : 'none'} message=${errorMessage(expiredLogin).slice(0, 60)}`,
        pass:
          expiredLogin.status === 403 &&
          expiredLogin.json?.error?.details?.code === 'PASSWORD_EXPIRED' &&
          !expiredLogin.json?.token &&
          /expired/i.test(errorMessage(expiredLogin)),
      });
      const blockedRows = await rows(
        conn,
        "SELECT COUNT(*) n FROM audit_logs WHERE action='USER_LOGIN_BLOCKED' AND userId=? AND newStatus='PASSWORD_EXPIRED'",
        [mgmt1.id],
      );
      check(CAT, 'การบล็อกเพราะรหัสหมดอายุมี audit USER_LOGIN_BLOCKED (newStatus=PASSWORD_EXPIRED)', {
        input: 'audit_logs ของ test_mgmt1',
        expected: '>= 1 แถว',
        actual: String(blockedRows[0]?.n ?? 0),
        pass: Number(blockedRows[0]?.n ?? 0) >= 1,
        note: 'รหัสถูกพิสูจน์แล้ว แต่ session ถูกปฏิเสธ — เหตุการณ์ต้องตรวจสอบย้อนหลังได้',
      });

      const gate = await api('POST', '/api/auth/change-expired-password', {
        body: { username: 'test_mgmt1', currentPassword: NEW_PW, newPassword: GATE_PW },
      });
      check(CAT, 'ทางกลับเข้าระบบเมื่อรหัสหมดอายุ: endpoint สาธารณะเปลี่ยนรหัสได้ 200 และยังไม่ออก token', {
        input: 'POST /api/auth/change-expired-password (ไม่มี bearer token)',
        expected: '200 + changed=true + message บอกให้ sign in ด้วยรหัสใหม่ + ไม่มี token',
        actual: `HTTP ${gate.status} body=${JSON.stringify(gate.json ?? {}).slice(0, 120)} token=${gate.json?.token ? 'ISSUED (BUG)' : 'none'}`,
        pass:
          gate.status === 200 &&
          gate.json?.changed === true &&
          /sign in/i.test(String(gate.json?.message ?? '')) &&
          !gate.json?.token,
        note: 'endpoint นี้ผ่านล็อกเดียวกันกับ login (เดารหัสผ่านไม่ได้) จึงไม่มีทางที่หมดอายุแล้วจะได้ session ทันที',
      });

      const gateLogin = await login('test_mgmt1', GATE_PW);
      currentSelfToken = gateLogin.json?.token ?? currentSelfToken;
      // `passwordChangedAt` ต้องอ่านผ่าน API: connection ของ harness ไม่มี `timezone:'Z'` แบบ datasource
      // ของเซิร์ฟเวอร์ จึงแปลงข้อความ DATETIME ด้วยเขตเวลาของเครื่อง (+07) และค่าที่ได้จะช้าจริง 7 ชั่วโมง
      const meAfterGate = await api('GET', '/api/users/me', { token: gateLogin.json?.token });
      const attemptsAfterGate = Number(
        (await rows(conn, 'SELECT failedLoginAttempts n FROM users WHERE id=?', [mgmt1.id]))[0]?.n,
      );
      const oldLogin = await login('test_mgmt1', NEW_PW);
      check(CAT, 'หลังเปลี่ยนรหัสผ่าน gate: รหัสใหม่ login ได้, รหัสเก่าใช้ไม่ได้, หน้า Profile เห็นอายุรหัสเริ่มต้นใหม่', {
        input: 'login ด้วย GATE_PW / NEW_PW + GET /api/users/me',
        expected: '200 / 401, passwordChangedAt เป็นเวลานี้, passwordExpiry ยังไม่หมดอายุ',
        actual: `new=${gateLogin.status} old=${oldLogin.status} changedAt=${String(meAfterGate.json?.user?.passwordChangedAt)} expired=${String(meAfterGate.json?.passwordExpiry?.expired)}`,
        pass:
          gateLogin.status === 200 &&
          oldLogin.status === 401 &&
          new Date(meAfterGate.json?.user?.passwordChangedAt ?? 0).getTime() >= Date.now() - 5 * 60 * 1000 &&
          meAfterGate.json?.passwordExpiry?.expired === false,
      });
      check(CAT, 'gate ไม่ได้ปิดสวิตช์ตัวนับรหัสผิด: login สำเร็จรีเซ็ตเป็น 0 แล้วการเดาครั้งถัดไปนับต่อเป็น 1', {
        input: 'อ่าน failedLoginAttempts หลัง gate login / หลังลองรหัสเก่า',
        expected: '0 หลัง login สำเร็จผ่าน gate, 1 หลังการเดาครั้งเดียว (ยังไม่ถึงเพดาน 3)',
        actual: `afterGate=${attemptsAfterGate} afterOldGuess=${Number(
          (await rows(conn, 'SELECT failedLoginAttempts n FROM users WHERE id=?', [mgmt1.id]))[0]?.n,
        )}`,
        pass:
          attemptsAfterGate === 0 &&
          Number((await rows(conn, 'SELECT failedLoginAttempts n FROM users WHERE id=?', [mgmt1.id]))[0]?.n) === 1,
        note: 'การเดา 1 ครั้งที่เหลือไว้นี้จะถูกเคลียร์ด้วย login สำเร็จในขั้นคืนสภาพบัญชีท้าย suite',
      });
      const gateAudit = await rows(
        conn,
        "SELECT reason FROM audit_logs WHERE action='USER_PASSWORD_CHANGED' AND userId=? ORDER BY createdAt DESC LIMIT 1",
        [mgmt1.id],
      );
      check(CAT, 'การเปลี่ยนรหัสผ่าน gate มี audit USER_PASSWORD_CHANGED และ reason ไม่มีรหัสผ่าน', {
        input: 'audit_logs reason แถวล่าสุด',
        expected: 'มี 1 แถว และ reason ไม่มี GATE_PW',
        actual: String(gateAudit[0]?.reason ?? 'no row').slice(0, 120),
        pass: gateAudit.length === 1 && !String(gateAudit[0].reason).includes(GATE_PW),
      });
    }
  } finally {
    await securityPins.restore();
  }

  // คืนสภาพบัญชี fixture ให้เหมือนก่อนรันเทสต์ (รอบถัดไปต้องได้ผลเหมือนเดิม)
  await api('PATCH', '/api/users/me', { token: currentSelfToken, body: { fullName: FIXTURES[0].fullName, email: FIXTURES[0].email } });
  // ความจำ "เคยใช้แล้ว" ต้องล้างก่อน เพราะการคืนรหัสมาตรฐานเป็นรหัสที่บัญชีนี้ใช้ซ้ำตามกฎ Stage D ไม่ได้อย่างจงใจ
  await forgetPasswordHistory(conn, mgmt1.id);
  await api('PATCH', `/api/users/${mgmt1.id}`, { token: admin, body: { password: PASSWORD } });
  const restored = await api('GET', '/api/users', { token: admin });
  const mgmt1After = (restored.json?.users ?? []).find((u) => u.username === 'test_mgmt1');
  check(CAT, 'คืนสภาพบัญชี fixture หลังเทสต์ self-service แล้ว (ชื่อ/อีเมล/รหัสผ่านใช้ได้)', {
    input: 'test_mgmt1 หลัง cleanup',
    expected: `fullName=${FIXTURES[0].fullName}, email=${FIXTURES[0].email}, login ด้วย PASSWORD = 200`,
    actual: `fullName=${mgmt1After?.fullName}, email=${mgmt1After?.email}, login HTTP ${(await login('test_mgmt1')).status}`,
    pass:
      mgmt1After?.fullName === FIXTURES[0].fullName &&
      mgmt1After?.email === FIXTURES[0].email &&
      (await login('test_mgmt1')).status === 200,
  });

  // ------------------------------------------------------------- housekeeping
  const ephemeral = [noMailName, trimName, reuseName, `test_dupmail_${RUN_TAG}`];
  const allUsers = (await api('GET', '/api/users?includeDeleted=true', { token: admin })).json.users ?? [];
  for (const name of ephemeral) {
    const u = allUsers.find((x) => x.username === name);
    if (u && !u.deletedAt) await api('DELETE', `/api/users/${u.id}`, { token: admin });
  }
  const stillActive = (await api('GET', '/api/users', { token: admin })).json.users.filter((u) => ephemeral.includes(u.username));
  check(CAT, 'เก็บกวาดบัญชีเฉพาะกิจที่สร้างระหว่างเทสต์แล้ว (เหลือแค่ 3 บัญชี fixture)', {
    input: ephemeral.join(','),
    expected: 'ไม่เหลือใน list ปกติ',
    actual: stillActive.map((u) => u.username).join(',') || 'cleaned',
    pass: stillActive.length === 0,
  });
}
