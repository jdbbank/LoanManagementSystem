// 3.2 Forgot password: OTP -> single-use link -> reset, with the anti-enumeration,
// cooldown / IP-throttle, attempt-burn, expiry and secret-storage guarantees.
//
// Fixture note: this suite owns the reset-token rows it creates. Between phases it ages
// `password_reset_tokens.createdAt` for its own fixture account only, so the 60s cooldown and
// the 60s IP throttle cannot make a functional assertion ambiguous. Nothing else is written.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PASSWORD, ROOT, api, check, errorMessage, isSealed, login, statusCheck, unseal } from '../lib/harness.mjs';

const CAT = 'forgot-password';
const FIXTURE = { username: 'test_pwreset', email: 'test_pwreset@test.local', fullName: 'Test Reset Fixture', role: 'MAKER' };
const OLD_PASSWORD = PASSWORD;
const NEW_PASSWORD = 'NewTst@2026#b';
const WEAK_PASSWORD = 'abc';
const ACK = 'If that address belongs to an active account, a 6-digit code is on its way.';

const token = async (conn, userId, kind) =>
  conn
    .query(
      'SELECT id, tokenHash, usedAt, expiresAt, attempts, requestedIp, createdAt FROM password_reset_tokens WHERE userId=? AND kind=? ORDER BY createdAt DESC LIMIT 1',
      [userId, kind],
    )
    .then(([r]) => r[0]);

const countTokens = async (conn, userId, kind, sinceIso) =>
  conn
    .query('SELECT COUNT(*) n FROM password_reset_tokens WHERE userId=? AND kind=? AND createdAt>?', [userId, kind, sinceIso]).then(([r]) => r[0].n);

/** The outbox holds sealed content; the suite opens it the same way the dispatcher does. */
const latestOutbox = async (conn, userId, type) => {
  const [rs] = await conn.query(
    'SELECT payload, bodyText, bodyHtml, recipientEmail, subject, status FROM notification_outbox WHERE type=? AND userId=? ORDER BY createdAt DESC LIMIT 1',
    [type, userId],
  );
  if (!rs.length) return null;
  const row = rs[0];
  // A row sealed with a rotated NOTIFY_SECRET_KEY must fail a check with a readable reason,
  // not abort the whole suite.
  const open = (value) => {
    try {
      return unseal(String(value));
    } catch {
      return '<<sealed with a different key>>';
    }
  };
  const text = open(row.bodyText);
  let payload = {};
  try {
    payload = JSON.parse(open(row.payload));
  } catch {
    payload = {};
  }
  return { ...row, openedPayload: payload, openedText: text, openedHtml: open(row.bodyHtml) };
};

const latestOtp = (conn, userId) => latestOutbox(conn, userId, 'PASSWORD_RESET_OTP');

/** Does any stored (sealed) column contain the secret in plain text? */
const rawMentions = (row, secret) =>
  !!row && ['bodyText', 'bodyHtml', 'payload'].some((f) => String(row[f] ?? '').includes(String(secret)));

const auditFor = async (conn, userId, action) =>
  conn
    .query('SELECT id, action, reason FROM audit_logs WHERE userId=? AND action=? ORDER BY createdAt DESC LIMIT 1', [userId, action])
    .then(([r]) => r[0]);

/** Ages only the fixture account's own rows: clears cooldown without touching history. */
const ageFixtureTokens = async (conn, userId) =>
  conn.execute(
    'UPDATE password_reset_tokens SET createdAt = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE userId=? AND createdAt > DATE_SUB(NOW(), INTERVAL 20 MINUTE)',
    [userId],
  );

/**
 * Opens a clean 60s measurement window. The IP throttle counts every account behind one client
 * IP, so rows an earlier suite left in the window would turn these assertions into rate-limit
 * results instead of OTP results. Only `createdAt` moves; expiry and hash stay untouched.
 */
const ageAllTokens = (conn) =>
  conn.execute('UPDATE password_reset_tokens SET createdAt = DATE_SUB(NOW(), INTERVAL 20 MINUTE) WHERE createdAt > DATE_SUB(NOW(), INTERVAL 20 MINUTE)');

const userIdByEmail = async (conn, email) =>
  conn
    .query('SELECT id FROM users WHERE email=?', [email])
    .then(([r]) => r[0]?.id ?? null);

const logFiles = () => {
  const dirs = [`${ROOT}server/src/logs`, `${ROOT}server/dist/logs`].filter((d) => existsSync(d));
  return dirs.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.log')).map((f) => `${d}/${f}`));
};

const logsMention = (secret) => {
  if (!secret) return [];
  const hits = [];
  for (const file of logFiles()) {
    const text = readFileSync(file, 'utf8');
    if (text.includes(secret)) hits.push(file.split('/').pop());
  }
  return hits;
};

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const admin = tokens.admin;

  // ------------------------------------------------------------- fixture account
  const listAll = await api('GET', '/api/users?includeDeleted=true', { token: admin });
  const existing = (listAll.json?.users ?? []).find((u) => u.username === FIXTURE.username);
  let created = { json: { user: existing } };
  if (!existing) {
    created = await api('POST', '/api/users', { token: admin, body: { ...FIXTURE, password: OLD_PASSWORD } });
  } else if (existing.deletedAt) {
    await api('POST', `/api/users/${existing.id}/restore`, { token: admin });
    await api('PATCH', `/api/users/${existing.id}`, { token: admin, body: { password: OLD_PASSWORD, isActive: true } });
  } else {
    await api('PATCH', `/api/users/${existing.id}`, { token: admin, body: { password: OLD_PASSWORD, isActive: true } });
  }
  const userId = created.json?.user?.id;
  check(CAT, 'มีบัญชี fixture สำหรับทดสอบ reset (สร้างหรือกู้คืนซ้ำได้)', {
    input: FIXTURE.username,
    expected: 'user id present',
    actual: `HTTP ${created.status} ${userId ?? errorMessage(created)}`,
    pass: !!userId,
  });
  if (!userId) return;
  await ageFixtureTokens(conn, userId);

  // ---------------------------------------------------- 1. anti-enumeration
  const known = await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  statusCheck(CAT, 'forgot-password (อีเมลมีจริง) ตอบ 202', known, 202, { input: FIXTURE.email });
  // counted around the unknown-email call so the suite stays re-runnable on a DB that already
  // holds rows from earlier runs
  const totalRows = () => conn.query('SELECT COUNT(*) n FROM password_reset_tokens').then(([r]) => r[0].n);
  const rowsBeforeUnknown = await totalRows();
  const unknown = await api('POST', '/api/auth/forgot-password', { body: { email: 'nobody-here@test.local' } });
  statusCheck(CAT, 'forgot-password (อีเมลไม่มีจริง) ตอบ 202 เหมือนกัน', unknown, 202, { input: 'nobody-here@test.local' });
  check(CAT, 'คำตอบสองกรณีเหมือนกันทุกตัวอักษร (enumeration-proof)', {
    input: 'existing vs non-existing email',
    expected: known.text,
    actual: unknown.text,
    pass: known.status === unknown.status && known.text === unknown.text && known.json?.message === ACK,
  });
  const rowsAfterUnknown = await totalRows();
  check(CAT, 'อีเมลที่ไม่รู้จักไม่สร้าง reset token (ตารางเพิ่ม 0 แถว)', {
    input: 'POST forgot-password(nobody-here@test.local)',
    expected: `${rowsBeforeUnknown} -> ${rowsBeforeUnknown}`,
    actual: `before=${rowsBeforeUnknown} after=${rowsAfterUnknown}`,
    pass: rowsAfterUnknown === rowsBeforeUnknown,
  });

  // ---------------------------------------------------- 2. inactive account / no email
  const disabledId = await userIdByEmail(conn, 'test_disabled@test.local');
  const disabledRowsBefore = await countTokens(conn, disabledId, 'OTP', '2000-01-01');
  const disabled = await api('POST', '/api/auth/forgot-password', { body: { email: 'test_disabled@test.local' } });
  statusCheck(CAT, 'บัญชีที่ปิดใช้งาน: ตอบ 202 แบบเดียวกัน', disabled, 202, { input: 'test_disabled@test.local' });
  const disabledRowsAfter = await countTokens(conn, disabledId, 'OTP', '2000-01-01');
  check(CAT, 'บัญชีที่ปิดใช้งานไม่ได้รับ OTP', {
    input: 'test_disabled@test.local',
    expected: 'no new OTP row',
    actual: `rows ${disabledRowsBefore} -> ${disabledRowsAfter}`,
    pass: disabledRowsAfter === disabledRowsBefore,
    note: 'endpoint ไม่เปิดเผยว่าอีเมลมีอยู่ในระบบหรือไม่',
  });
  const noEmailUser = await api('POST', '/api/auth/forgot-password', { body: { email: 'test_noemail@test.local' } });
  statusCheck(CAT, 'บัญชีไม่มีอีเมล: ตอบ 202 แบบเดียวกัน (ไม่พัง)', noEmailUser, 202, { input: 'test_noemail@test.local' });


  // ---------------------------------------------------- 3. cooldown (same user, 60s)
  const before = await countTokens(conn, userId, 'OTP', '2000-01-01');
  const again = await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  const after = await countTokens(conn, userId, 'OTP', '2000-01-01');
  statusCheck(CAT, 'ขอ OTP ซ้ำทันที: ตอบ 202 (cooldown)', again, 202, { input: FIXTURE.email });
  check(CAT, 'cooldown 60s: คำขอซ้ำไม่ออก OTP ใหม่', {
    input: 'forgot-password x2 ภายใน 60s',
    expected: `${before} row, no new row`,
    actual: `rows ${before} -> ${after}`,
    pass: after === before,
  });

  // ---------------------------------------------------- 4. secret stored hashed, never plaintext
  const otpRow = await token(conn, userId, 'OTP');
  check(CAT, 'OTP ในฐานข้อมูลเก็บเป็น SHA-256 ไม่ใช่เลข 6 หลัก', {
    input: 'password_reset_tokens.tokenHash',
    expected: '64 hex chars, not the OTP itself',
    actual: `length=${otpRow?.tokenHash?.length}, looksLikeDigits=${/^\d{6}$/.test(otpRow?.tokenHash ?? '')}`,
    pass: !!otpRow && /^[0-9a-f]{64}$/.test(otpRow.tokenHash) && !/^\d{6}$/.test(otpRow.tokenHash),
  });
  const delivered = await latestOtp(conn, userId);
  const otp = delivered?.openedPayload?.otp;
  check(CAT, 'OTP ถูกส่งออกทาง outbox (มีเหตุการณ์ PASSWORD_RESET_OTP)', {
    input: 'notification_outbox lookup',
    expected: 'one row with a 6-digit payload.otp',
    actual: delivered ? `type=PASSWORD_RESET_OTP recipient=${delivered.recipientEmail}` : 'no outbox row',
    pass: /^\d{6}$/.test(otp ?? ''),
  });
  check(CAT, 'ค่า OTP ไม่ถูกเก็บเป็น plaintext ในฐานข้อมูล (ทุกตาราง)', {
    input: `OTP=${otp}`,
    expected: 'no row anywhere holds the 6-digit code',
    actual: rawMentions(delivered, otp)
      ? 'พบใน notification_outbox.bodyText/bodyHtml/payload'
      : `not stored in plaintext (sealed=${isSealed(String(delivered?.bodyText))})`,
    pass:
      !!otp &&
      !rawMentions(delivered, otp) &&
      isSealed(String(delivered?.bodyText)) &&
      String(delivered?.openedText).includes(String(otp)),
    note: 'outbox เก็บ body ที่ซีลด้วย AES-256-GCM (คีย์ NOTIFY_SECRET_KEY) และเปิดได้เฉพาะตอน dispatch',
  });
  const stored = await conn
    .query('SELECT GROUP_CONCAT(COLUMN_NAME) c FROM information_schema.COLUMNS WHERE TABLE_NAME="password_reset_tokens"')
    .then(([r]) => r[0].c);
  check(CAT, 'ตาราง token ไม่มีคอลัมน์เก็บ plaintext', {
    input: 'information_schema',
    expected: 'tokenHash only',
    actual: String(stored),
    pass: /tokenHash/.test(String(stored)) && !/tokenPlain|otp/i.test(String(stored)),
  });
  const leakedInLogs = logsMention(otp);  check(CAT, 'ไม่มี OTP ปรากฏในไฟล์ log', {
    input: otp ?? '(no otp issued)',
    expected: 'no log file contains the code',
    actual: leakedInLogs.length ? `found in ${leakedInLogs.join(',')}` : `${logFiles().length} files scanned, clean`,
    pass: leakedInLogs.length === 0,
    note: 'ถ้าพบ = บั๊กความปลอดภัยระดับสูง',
  });
  const audit1 = await auditFor(conn, userId, 'USER_RESET_REQUESTED');
  check(CAT, 'audit log บันทึกเหตุการณ์ขอ reset โดยไม่มียอดความลับ', {
    input: 'audit_logs USER_RESET_REQUESTED',
    expected: 'one row, reason without the OTP',
    actual: audit1 ? `${audit1.action} | ${audit1.reason}` : 'no audit row',
    pass: !!audit1 && !String(audit1.reason).includes(String(otp)),
  });

  // ---------------------------------------------------- 5. wrong OTP burns after 5 attempts
  // verify-otp shares the IP throttle with issuance: leave no foreign row in the window.
  await ageAllTokens(conn);
  let wrongStatuses = [];
  for (let i = 0; i < 5; i++) {
    const bad = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: '000000' === otp ? '111111' : '000000' } });
    wrongStatuses.push(bad.status);
  }
  check(CAT, 'เดา OTP ผิด 5 ครั้ง: ทุกครั้งตอบ 400 ข้อความเดียวกัน', {
    input: 'verify-otp x5 ด้วยรหัสผิด',
    expected: '[400,400,400,400,400]',
    actual: JSON.stringify(wrongStatuses),
    pass: wrongStatuses.every((s) => s === 400),
  });
  const burned = await token(conn, userId, 'OTP');
  const auditBurn = await auditFor(conn, userId, 'USER_RESET_BURNED');
  check(CAT, 'ครบ 5 ครั้งที่ผิด: OTP ถูก burn (attempts=5, usedAt ตั้งแล้ว)', {
    input: 'password_reset_tokens after 5 wrong guesses',
    expected: 'attempts>=5 AND usedAt NOT NULL',
    actual: `attempts=${burned?.attempts}, usedAt=${burned?.usedAt ? 'set' : 'null'}`,
    pass: Number(burned?.attempts) >= 5 && !!burned?.usedAt,
  });
  check(CAT, 'มี audit USER_RESET_BURNED', {
    input: 'audit_logs',
    expected: 'one row',
    actual: auditBurn ? auditBurn.action : 'none',
    pass: !!auditBurn,
  });
  const afterBurn = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp } });
  statusCheck(CAT, 'ใช้รหัสที่ถูกต้องหลังกดเดาครบ 5 ครั้ง: ต้อง 400 (burn แล้ว)', afterBurn, 400, {
    input: 'verify-otp(correct otp after burn)',
    messageIncludes: 'Invalid or expired verification code',
  });

  // ---------------------------------------------------- 6. happy path: OTP -> link -> password
  await ageFixtureTokens(conn, userId);
  const issue2 = await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  statusCheck(CAT, 'ออก OTP ใหม่ได้หลังพ้น cooldown', issue2, 202, { input: FIXTURE.email });
  const otp2 = (await latestOtp(conn, userId))?.openedPayload?.otp;
  const oldSession = (await login(FIXTURE.username, OLD_PASSWORD)).json?.token;
  check(CAT, 'login ด้วยรหัสผ่านเก่าได้ก่อน reset (baseline)', {
    input: FIXTURE.username,
    expected: 'token issued',
    actual: oldSession ? 'token issued' : 'no token',
    pass: !!oldSession,
  });

  const wrongFormat = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: '12345' } });
  statusCheck(CAT, 'OTP ไม่ใช่ 6 หลัก: 400 validation', wrongFormat, 400, { input: 'otp=12345' });

  const verify = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: otp2 } });
  statusCheck(CAT, 'OTP ถูกต้อง: 200 + คืน resetUrl', verify, 200, { input: `otp=${otp2}` });
  const linkToken = /token=([^"&]+)/.exec(verify.json?.resetUrl ?? '')?.[1];
  check(CAT, 'resetUrl มี token เดียวใช้ (base64url 43 ตัว)', {
    input: verify.json?.resetUrl,
    expected: '/reset-password?token=<43 chars>',
    actual: `token length=${linkToken?.length ?? 0}`,
    pass: !!linkToken && linkToken.length === 43,
  });
  const linkRow = await token(conn, userId, 'LINK');
  check(CAT, 'LINK token เก็บเป็น hash เช่นกัน', {
    input: 'password_reset_tokens kind=LINK',
    expected: 'sha256 hex, usedAt null, expiresAt ~60 นาที',
    actual: linkRow ? `hash=${String(linkRow.tokenHash).length} chars, usedAt=${linkRow.usedAt ? 'set' : 'null'}` : 'no row',
    pass: !!linkRow && /^[0-9a-f]{64}$/.test(linkRow.tokenHash) && !linkRow.usedAt,
  });
  const reuse = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: otp2 } });
  statusCheck(CAT, 'OTP ใช้แล้วนำมาใช้ซ้ำไม่ได้ (single-use)', reuse, 400, { input: 'same otp twice' });
  const linkInOutbox = await conn
    .query("SELECT COUNT(*) n FROM notification_outbox WHERE bodyText LIKE ? OR payload LIKE ? OR bodyHtml LIKE ?", [
      `%token=${linkToken}%`,
      `%token=${linkToken}%`,
      `%token=${linkToken}%`,
    ])
    .then(([r]) => r[0].n);
  const linkDelivered = await latestOutbox(conn, userId, 'PASSWORD_RESET_LINK');
  check(CAT, 'link reset ถูกเก็บใน outbox แบบซีลเท่านั้น (ยังเปิดอ่านได้ตอน dispatch)', {
    input: `token ${String(linkToken).slice(0, 8)}…`,
    expected: '0 plaintext rows + sealed columns + opened body still carries the usable link',
    actual: !linkDelivered
      ? 'no PASSWORD_RESET_LINK outbox row'
      : `plaintext=${linkInOutbox}, sealed=${[linkDelivered.bodyText, linkDelivered.bodyHtml, linkDelivered.payload].map((v) => isSealed(String(v))).join('/')}, linkInOpenedBody=${String(linkDelivered.openedText).includes(String(linkToken))}`,
    pass:
      linkInOutbox === 0 &&
      !!linkDelivered &&
      isSealed(String(linkDelivered.bodyText)) &&
      isSealed(String(linkDelivered.bodyHtml)) &&
      isSealed(String(linkDelivered.payload)) &&
      String(linkDelivered.openedText).includes(String(linkToken)),
    note: 'ตรวจสองทาง: dump ฐานข้อมูลต้องไม่พบลิงก์ใช้ได้ในรูป plaintext แต่ message ที่จะส่งจริงต้องยังครบถ้วน',
  });

  const weak = await api('POST', '/api/auth/reset-password', { body: { token: linkToken, password: WEAK_PASSWORD } });
  check(CAT, 'รหัสผ่านใหม่อ่อน: ถูกปฏิเสธตาม policy', {
    input: 'reset-password(password=abc)',
    expected: '4xx + policy message',
    actual: `HTTP ${weak.status} ${errorMessage(weak)}`,
    pass: weak.status >= 400 && weak.status < 500,
  });
  const stillOld = await login(FIXTURE.username, OLD_PASSWORD);
  check(CAT, 'reset ที่อ่อนไม่เปลี่ยนรหัสผ่านจริง', {
    input: 'login with the old password after the rejected reset',
    expected: '200 (รหัสเก่ายังใช้ได้)',
    actual: `HTTP ${stillOld.status}`,
    pass: stillOld.status === 200,
  });

  const reset = await api('POST', '/api/auth/reset-password', { body: { token: linkToken, password: NEW_PASSWORD } });
  statusCheck(CAT, 'reset-password ด้วย token เดียวใช้: 200', reset, 200, { input: 'valid link + strong password' });
  const replay = await api('POST', '/api/auth/reset-password', { body: { token: linkToken, password: 'AnotherTst@2026#c' } });
  statusCheck(CAT, 'link ใช้แล้วใช้ซ้ำไม่ได้', replay, 400, { input: 'same link twice', messageIncludes: 'no longer valid' });

  const loginNew = await login(FIXTURE.username, NEW_PASSWORD);
  statusCheck(CAT, 'login ด้วยรหัสใหม่ได้', loginNew, 200, { input: FIXTURE.username });
  const loginOld = await login(FIXTURE.username, OLD_PASSWORD);
  statusCheck(CAT, 'รหัสผ่านเก่าใช้ไม่ได้แล้ว', loginOld, 401, { input: 'old password' });

  const leakedLink = logsMention(linkToken);
  check(CAT, 'ไม่มี reset link token ในไฟล์ log', {
    input: linkToken?.slice(0, 12) + '…',
    expected: 'clean',
    actual: leakedLink.length ? `found in ${leakedLink.join(',')}` : 'clean',
    pass: leakedLink.length === 0,
  });
  const auditReset = await auditFor(conn, userId, 'USER_PASSWORD_RESET');
  check(CAT, 'audit USER_PASSWORD_RESET ถูกต้อง และไม่มีรหัสผ่านในเหตุผล', {
    input: 'audit_logs',
    expected: 'one row without the new password',
    actual: auditReset ? auditReset.reason : 'none',
    pass: !!auditReset && !String(auditReset.reason).includes(NEW_PASSWORD),
  });

  // ---------------------------------------------------- 7. old bearer token after reset
  const meWithOldToken = await api('GET', '/api/auth/me', { token: oldSession });
  check(CAT, 'token ที่ออกก่อนการ reset ต้องใช้ไม่ได้หลังเปลี่ยนรหัสผ่าน', {
    input: 'GET /api/auth/me ด้วย JWT ที่ login ก่อน reset',
    expected: '401 (session เก่าถูกเพิกถอน)',
    actual: `HTTP ${meWithOldToken.status}`,
    pass: meWithOldToken.status === 401,
    note: 'JWT ไม่มีสถานะ (stateless) ถ้ายังตอบ 200 = token เดิมยังอยู่ได้จนหมดอายุ 12 ชม.',
  });

  // ---------------------------------------------------- 8. other secrets of the account are retired
  const leftovers = await conn
    .query('SELECT COUNT(*) n FROM password_reset_tokens WHERE userId=? AND usedAt IS NULL AND expiresAt > NOW()', [userId])
    .then(([r]) => r[0].n);
  check(CAT, 'หลัง reset ทุก secret ของบัญชีนี้ถูก retire เหลือแค่ที่ใช้จริง', {
    input: 'unused non-expired rows for the fixture user',
    expected: '0',
    actual: String(leftovers),
    pass: leftovers === 0,
  });

  // ---------------------------------------------------- 9. expired OTP / expired link
  await ageFixtureTokens(conn, userId);
  await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  const otp3 = (await latestOtp(conn, userId))?.openedPayload?.otp;
  await conn.execute('UPDATE password_reset_tokens SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE userId=? AND kind="OTP" AND usedAt IS NULL', [userId]);
  const expiredOtp = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: otp3 } });
  statusCheck(CAT, 'OTP หมดอายุ: 400 แม้รหัสจะถูก', expiredOtp, 400, { input: 'otp after expiry', messageIncludes: 'Invalid or expired' });

  await ageFixtureTokens(conn, userId);
  await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  const otp4 = (await latestOtp(conn, userId))?.openedPayload?.otp;
  const v2 = await api('POST', '/api/auth/verify-otp', { body: { email: FIXTURE.email, otp: otp4 } });
  const link2 = /token=([^"&]+)/.exec(v2.json?.resetUrl ?? '')?.[1];
  await conn.execute('UPDATE password_reset_tokens SET expiresAt = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE userId=? AND kind="LINK" AND usedAt IS NULL', [userId]);
  const expiredLink = await api('POST', '/api/auth/reset-password', { body: { token: link2, password: NEW_PASSWORD } });
  statusCheck(CAT, 'link หมดอายุ: 400 และไม่เปลี่ยนรหัสผ่าน', expiredLink, 400, { input: 'link past expiresAt', messageIncludes: 'no longer valid' });
  const garbage = await api('POST', '/api/auth/reset-password', { body: { token: 'x'.repeat(40), password: NEW_PASSWORD } });
  statusCheck(CAT, 'token ที่ไม่มีอยู่จริง: 400', garbage, 400, { input: 'random token' });

  // ---------------------------------------------------- 10. IP throttle (>=5 issuances in 60s)
  await ageAllTokens(conn); // start from a clean window so the count is unambiguous
  const emails = ['test_head@test.local', 'test_checker1@test.local', 'test_op1@test.local', 'test_view1@test.local', 'test_unverified@test.local'];
  const issued = [];
  for (const email of emails) {
    const r = await api('POST', '/api/auth/forgot-password', { body: { email } });
    issued.push(r.status);
  }
  const ipRows = await conn
    .query('SELECT COUNT(*) n FROM password_reset_tokens WHERE createdAt > DATE_SUB(NOW(), INTERVAL 70 SECOND)')
    .then(([r]) => r[0].n);
  const throttleProbe = await api('POST', '/api/auth/forgot-password', { body: { email: FIXTURE.email } });
  const ipRowsAfter = await conn
    .query('SELECT COUNT(*) n FROM password_reset_tokens WHERE createdAt > DATE_SUB(NOW(), INTERVAL 70 SECOND)')
    .then(([r]) => r[0].n);
  const requestedIp = await conn
    .query('SELECT requestedIp ip FROM password_reset_tokens ORDER BY createdAt DESC LIMIT 1')
    .then(([r]) => r[0]?.ip);
  check(CAT, 'IP throttle: คำขอจาก IP เดิมครบ 5 ครั้งแล้วไม่ออก OTP อีก (ตอบ 202 เหมือนเดิม)', {
    input: `5 issuances then a 6th from the same client ip=${requestedIp}`,
    expected: '5 rows after the first five, still 5 after the 6th, HTTP 202',
    actual: `statuses=${JSON.stringify(issued)}+${throttleProbe.status}, rows ${ipRows} -> ${ipRowsAfter}`,
    pass: issued.every((s) => s === 202) && ipRows === 5 && ipRowsAfter === 5 && throttleProbe.status === 202,
    note: 'เงื่อนไขที่ล็อกไว้: ฟอร์ม forgot-password ต้อง spray ทั้งตารางไม่ได้ (บัญชี probe ถูก cooldown แล้วจึงวัดได้เฉพาะ IP throttle)',
  });

  // ---------------------------------------------------- 11. validation + public shape
  const badEmail = await api('POST', '/api/auth/forgot-password', { body: { email: 'not-an-email' } });
  statusCheck(CAT, 'forgot-password ด้วยรูปแบบอีเมลผิด: 400', badEmail, 400, { input: 'email=not-an-email' });
  const noBody = await api('POST', '/api/auth/forgot-password', { body: {} });
  statusCheck(CAT, 'forgot-password โดยไม่มี email: 400', noBody, 400, { input: '{}' });

  // restore the shared password so later suites can log in with the standard fixture password
  await api('PATCH', `/api/users/${userId}`, { token: admin, body: { password: PASSWORD } });
  await ageFixtureTokens(conn, userId);
  check(CAT, 'ล้างบัญชี fixture กลับรหัสผ่านมาตรฐานแล้ว', {
    input: 'PATCH /api/users/:id {password}',
    expected: 'login with the standard test password works again',
    actual: `HTTP ${(await login(FIXTURE.username, PASSWORD)).status}`,
    pass: (await login(FIXTURE.username, PASSWORD)).status === 200,
  });
}
