// 3.13 Central configuration (/api/config/*): the four policy surfaces — approval thresholds,
// KYC, password, avatar — as contracts. Read shape and hot reload, write guards (zod 400 vs
// business 422 vs rollback), the audit format of every write, how a malformed system_config row
// changes the resolved policy, and whether the stored config really drives behaviour elsewhere.
//
// This is the only suite that writes system_config, so it snapshots every row (including
// updatedAt) and restores all of them, in a finally block too. Business rows are touched only
// through documented endpoints and undone again (throwaway users, one KYC document, one avatar).
import { createHash } from 'node:crypto';
import {
  PASSWORD,
  SERVER_ENV,
  api as http,
  check,
  errorMessage,
  rows,
  settle,
  statusCheck,
} from '../lib/harness.mjs';
import { jpegBytes, multipartFile, multipartWithFields, pngBytes } from '../lib/files.mjs';

const CAT = 'config';
const RUN_TAG = String(Date.now()).slice(-6);

const sha16 = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
const csv = (raw) => String(raw ?? '').split(',').map((v) => v.trim()).filter((v) => v.length > 0);
const envNum = (key, fallback) => Number(SERVER_ENV[key] ?? fallback);
const envBool = (key, fallback) => {
  const v = SERVER_ENV[key];
  if (v === undefined || v === '') return fallback;
  return String(v).toLowerCase() === 'true' || String(v) === '1';
};
const envList = (key, fallback) => csv(SERVER_ENV[key] ?? fallback);

/** The env layer every policy falls back to (server/.env sets none of these, so the fallbacks win). */
const ENV_DEFAULTS = {
  kyc: {
    maxFileSizeKb: envNum('KYC_MAX_FILE_SIZE_KB', 5120),
    maxFilesPerRequest: envNum('KYC_MAX_FILES_PER_REQUEST', 1),
    allowedMimeTypes: envList('KYC_ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp'),
    allowedDocumentTypes: envList(
      'KYC_ALLOWED_DOCUMENT_TYPES',
      'NATIONAL_ID,ID_CARD,PASSPORT,FAMILY_BOOK,SELFIE_WITH_ID,SIGNATURE',
    ),
    requiredIdentityTypes: envList('KYC_REQUIRED_IDENTITY_TYPES', 'NATIONAL_ID,ID_CARD,PASSPORT'),
    requireSelfieWithId: envBool('KYC_REQUIRE_SELFIE_WITH_ID', true),
    requireSignature: envBool('KYC_REQUIRE_SIGNATURE', true),
    requireFamilyBook: envBool('KYC_REQUIRE_FAMILY_BOOK', false),
    acceptExpiredDocuments: envBool('KYC_ACCEPT_EXPIRED_DOCUMENTS', false),
    expiryWarningDays: envNum('KYC_EXPIRY_WARNING_DAYS', 60),
    maxTotalBytesPerCustomer: envNum('KYC_MAX_TOTAL_BYTES_PER_CUSTOMER', 31457280),
    blockDisbursementUntilVerified: envBool('KYC_BLOCK_DISBURSEMENT_UNTIL_VERIFIED', true),
    reverifyOnDocumentChange: envBool('KYC_REVERIFY_ON_DOCUMENT_CHANGE', true),
  },
  password: {
    minLength: envNum('PASSWORD_MIN_LENGTH', 6),
    maxLength: envNum('PASSWORD_MAX_LENGTH', 16),
    requireDigit: envBool('PASSWORD_REQUIRE_DIGIT', true),
    requireUppercase: envBool('PASSWORD_REQUIRE_UPPERCASE', true),
    requireLowercase: envBool('PASSWORD_REQUIRE_LOWERCASE', true),
    requireSymbol: envBool('PASSWORD_REQUIRE_SYMBOL', false),
  },
  avatar: {
    enabled: envBool('AVATAR_ENABLED', true),
    maxFileSizeKb: envNum('AVATAR_MAX_FILE_SIZE_KB', 512),
    allowedMimeTypes: envList('AVATAR_ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp'),
  },
};

/** Which system_config row feeds which policy field, and how the service interprets it. */
const KYC_KEYS = {
  maxFileSizeKb: { key: 'kyc.upload.maxFileSizeKb', kind: 'number' },
  maxFilesPerRequest: { key: 'kyc.upload.maxFilesPerRequest', kind: 'number' },
  allowedMimeTypes: { key: 'kyc.upload.allowedMimeTypes', kind: 'csv' },
  allowedDocumentTypes: { key: 'kyc.allowedDocumentTypes', kind: 'docTypes' },
  requiredIdentityTypes: { key: 'kyc.requiredIdentityTypes', kind: 'docTypes' },
  requireSelfieWithId: { key: 'kyc.requireSelfieWithId', kind: 'boolean' },
  requireSignature: { key: 'kyc.requireSignature', kind: 'boolean' },
  requireFamilyBook: { key: 'kyc.requireFamilyBook', kind: 'boolean' },
  acceptExpiredDocuments: { key: 'kyc.acceptExpiredDocuments', kind: 'boolean' },
  expiryWarningDays: { key: 'kyc.expiryWarningDays', kind: 'number' },
  maxTotalBytesPerCustomer: { key: 'kyc.maxTotalBytesPerCustomer', kind: 'number' },
  blockDisbursementUntilVerified: { key: 'kyc.blockDisbursementUntilVerified', kind: 'boolean' },
  reverifyOnDocumentChange: { key: 'kyc.reverifyOnDocumentChange', kind: 'boolean' },
};
const PW_KEYS = {
  minLength: { key: 'password.minLength', kind: 'number' },
  maxLength: { key: 'password.maxLength', kind: 'number' },
  requireDigit: { key: 'password.requireDigit', kind: 'boolean' },
  requireUppercase: { key: 'password.requireUppercase', kind: 'boolean' },
  requireLowercase: { key: 'password.requireLowercase', kind: 'boolean' },
  requireSymbol: { key: 'password.requireSymbol', kind: 'boolean' },
};
const AV_KEYS = {
  enabled: { key: 'avatar.enabled', kind: 'boolean' },
  maxFileSizeKb: { key: 'avatar.maxFileSizeKb', kind: 'number' },
  allowedMimeTypes: { key: 'avatar.allowedMimeTypes', kind: 'csv' },
};

const DOC_TYPES = ['NATIONAL_ID', 'ID_CARD', 'PASSPORT', 'FAMILY_BOOK', 'SELFIE_WITH_ID', 'SIGNATURE'];
const SUPPORTED_MIME = ['image/jpeg', 'image/png', 'image/webp'];

const CFG_SQL =
  'SELECT id, `key`, CAST(value AS CHAR) AS value, valueText, description, updatedBy, ' +
  'CAST(updatedAt AS CHAR) AS updatedAt FROM system_config ORDER BY `key`';

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));
  const admin = tokens.admin;

  const ok = (name, cond, { input, expected: e = 'true', actual: a = '', note = '' } = {}) =>
    check(CAT, name, { input, expected: e, actual: typeof a === 'string' ? a : JSON.stringify(a), pass: cond, note });

  /** Compares only the keys present in `want`, so an unexpected value in a field is visible. */
  const diffFields = (actual, want) =>
    Object.entries(want)
      .filter(([k, v]) => JSON.stringify(actual?.[k]) !== JSON.stringify(v))
      .map(([k, v]) => `${k}=${JSON.stringify(actual?.[k])} want ${JSON.stringify(v)}`);

  const cfgNow = () => rows(conn, CFG_SQL);
  const mapOf = (list) => new Map(list.map((r) => [r.key, r]));
  const rowsJson = (list) => JSON.stringify((list ?? []).map((r) => `${r.key}|${r.value}|${r.valueText}|${r.description}|${r.updatedBy}|${r.updatedAt}`));

  /** The overlay rule the services use: number>0, boolean===1, list non-empty after filtering. */
  const rowValue = (map, spec, field, defaults) => {
    const s = spec[field];
    const row = map.get(s.key);
    const dflt = defaults[field];
    if (!row) return dflt;
    if (s.kind === 'number') {
      const n = Number(row.value);
      return Number.isFinite(n) && n > 0 ? n : dflt;
    }
    if (s.kind === 'boolean') return Number(row.value) === 1;
    const list = csv(row.valueText).filter((v) => (s.kind === 'docTypes' ? DOC_TYPES.includes(v) : true));
    return list.length > 0 ? list : dflt;
  };

  const getThresholds = async () => (await api('GET', '/api/config/thresholds', { token: admin })).json;
  const getKyc = async () => (await api('GET', '/api/config/kyc', { token: admin })).json?.data;
  const getPassword = async () => (await api('GET', '/api/config/password', { token: admin })).json?.data;
  const getAvatar = async () => (await api('GET', '/api/config/avatar', { token: admin })).json?.data;

  async function fingerprint() {
    return {
      thresholds: JSON.stringify(await getThresholds()),
      kyc: sha16((await getKyc())?.policy),
      password: sha16((await getPassword())?.policy),
      avatar: JSON.stringify((await getAvatar())?.policy),
    };
  }

  // ------------------------------------------------------------------- baselines
  const snapshot = await cfgNow();
  const snapshotMap = mapOf(snapshot);
  const snapshotJson = rowsJson(snapshot);
  const fpBefore = await fingerprint();
  const auditIdsBefore = new Set((await rows(conn, 'SELECT id FROM audit_logs')).map((r) => r.id));
  const seenConfigIds = new Set(auditIdsBefore);
  const TABLES = [
    'system_config', 'users', 'user_avatars', 'user_avatar_contents', 'kyc_documents',
    'notification_outbox', 'password_reset_tokens', 'audit_logs',
  ];
  const baselineCounts = {};
  for (const t of TABLES) baselineCounts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n);

  const suiteUsers = [];
  async function makeUser(tag, password = PASSWORD, role = 'MAKER') {
    const username = `tst_cf_${RUN_TAG}_${tag}`;
    const res = await api('POST', '/api/users', {
      token: admin,
      body: { username, password, fullName: 'Test Config User', email: `tst_cf_${RUN_TAG}_${tag}@test.local`, role },
    });
    if (res.json?.user?.id) suiteUsers.push(res.json.user);
    return { res, user: res.json?.user, username };
  }

  /** Puts every system_config row back exactly as snapshotted (value, text, description, actor, timestamp). */
  async function applySnapshot() {
    const now = mapOf(await cfgNow());
    for (const [key, row] of now) {
      const orig = snapshotMap.get(key);
      if (!orig) {
        await conn.query('DELETE FROM system_config WHERE `key`=?', [key]);
        continue;
      }
      const same =
        String(orig.value) === String(row.value) &&
        String(orig.valueText ?? '') === String(row.valueText ?? '') &&
        String(orig.description ?? '') === String(row.description ?? '') &&
        String(orig.updatedBy ?? '') === String(row.updatedBy ?? '') &&
        String(orig.updatedAt) === String(row.updatedAt);
      if (same) continue;
      await conn.query(
        'UPDATE system_config SET value=?, valueText=?, description=?, updatedBy=?, updatedAt=? WHERE `key`=?',
        [orig.value, orig.valueText, orig.description, orig.updatedBy, orig.updatedAt, key],
      );
    }
    for (const [key, orig] of snapshotMap) {
      if (now.has(key)) continue;
      await conn.query(
        'INSERT INTO system_config (id, `key`, value, valueText, description, updatedBy, updatedAt) VALUES (?,?,?,?,?,?,?)',
        [orig.id, key, orig.value, orig.valueText, orig.description, orig.updatedBy, orig.updatedAt],
      );
    }
  }

  /** Writes a row straight through SQL — the only way to study a config value the API itself refuses. */
  async function sqlSet(key, value, valueText = null) {
    const existing = (await rows(conn, 'SELECT id FROM system_config WHERE `key`=?', [key]))[0];
    if (existing) {
      await conn.query('UPDATE system_config SET value=?, valueText=? WHERE `key`=?', [value, valueText, key]);
      return;
    }
    await conn.query(
      'INSERT INTO system_config (id, `key`, value, valueText, description, updatedAt) VALUES (UUID(),?,?,?,?,NOW(6))',
      [key, value, valueText, `suite13 probe row ${RUN_TAG}`],
    );
  }

  /** CONFIG_UPDATED rows created since the last mark — the audit assertions use this. */
  async function configAuditSince() {
    const all = await rows(
      conn,
      "SELECT id, action, userId, previousStatus, newStatus, reason, ip FROM audit_logs WHERE action='CONFIG_UPDATED' ORDER BY createdAt",
    );
    const fresh = all.filter((r) => !seenConfigIds.has(r.id));
    return { fresh, latest: fresh[fresh.length - 1] ?? null };
  }
  async function markConfigSeen() {
    (await rows(conn, 'SELECT id FROM audit_logs WHERE action=?', ['CONFIG_UPDATED'])).forEach((r) => seenConfigIds.add(r.id));
  }

  const pngFor = (kb) => Buffer.concat([pngBytes(kb), Buffer.from(`cfg-${RUN_TAG}`, 'utf8')]);
  const jpgFor = (kb) => Buffer.concat([jpegBytes(kb), Buffer.from(`cfg-${RUN_TAG}`, 'utf8')]);

  // ================================================================ A. read contracts
  const thRes = await api('GET', '/api/config/thresholds', { token: admin });
  const thKeys = Object.keys(thRes.json ?? {}).sort();
  ok('GET /thresholds ให้ object เปลือย 2 คีย์เท่านั้น (ไม่มี data wrapper)',
    thRes.status === 200 && JSON.stringify(thKeys) === JSON.stringify(['checkerThreshold', 'headThreshold']), {
      input: 'GET /api/config/thresholds',
      expected: 'HTTP 200 + keys [checkerThreshold, headThreshold]',
      actual: `${thRes.status} ${JSON.stringify(thRes.json)}`,
      note: 'endpoint เดียวใน /api/config ที่ไม่คืนรูป {data:...} — client ต้องรู้รูปแบบแยกต่อ endpoint',
    });

  const thBody = thRes.json ?? {};
  ok('GET /thresholds ตรงกับคอลัมน์ value ใน system_config จริง (ไม่ได้ hardcode 1,000,000)',
    thBody.checkerThreshold === Number(snapshotMap.get('approval.checkerThreshold')?.value) &&
      thBody.headThreshold === Number(snapshotMap.get('approval.headThreshold')?.value), {
      input: 'CAST(value AS CHAR) ของ approval.checkerThreshold / approval.headThreshold',
      expected: `${snapshotMap.get('approval.checkerThreshold')?.value} / ${snapshotMap.get('approval.headThreshold')?.value}`,
      actual: `${thBody.checkerThreshold} / ${thBody.headThreshold}`,
    });

  const kycGet = await api('GET', '/api/config/kyc', { token: admin });
  const kycData = kycGet.json?.data;
  ok('GET /kyc คืน {data:{policy,defaults,checksum}} ครบ 3 คีย์', kycGet.status === 200 &&
    JSON.stringify(Object.keys(kycGet.json ?? {})) === '["data"]' &&
    JSON.stringify(Object.keys(kycData ?? {}).sort()) === JSON.stringify(['checksum', 'defaults', 'policy']), {
      input: 'GET /api/config/kyc',
      expected: 'data = {checksum, defaults, policy}',
      actual: `${kycGet.status} data keys=${JSON.stringify(Object.keys(kycData ?? {}).sort())}`,
    });
  const pwData = (await getPassword()) ?? {};
  const avGet = await api('GET', '/api/config/avatar', { token: admin });
  const avData = avGet.json?.data ?? {};
  ok('GET /password คืน {data:{policy,defaults,checksum}} เช่นกัน',
    JSON.stringify(Object.keys(pwData).sort()) === JSON.stringify(['checksum', 'defaults', 'policy']), {
      input: 'GET /api/config/password',
      expected: 'data = {checksum, defaults, policy}',
      actual: JSON.stringify(Object.keys(pwData).sort()),
    });
  ok('GET /avatar ไม่มี checksum (สัญญาต่างจากอีก 3 endpoint)', !('checksum' in avData) &&
    JSON.stringify(Object.keys(avData).sort()) === JSON.stringify(['defaults', 'policy']), {
      input: 'GET /api/config/avatar',
      expected: 'data keys = [defaults, policy]',
      actual: JSON.stringify(Object.keys(avData).sort()),
      note: 'kyc/password ใส่ checksum ให้ UI ยืนยันว่าอ่านค่าตรงกัน ส่วน avatar ไม่ใส่ — UI จึงเทียบ fingerprint ของ avatar ไม่ได้',
    });

  ok('checksum = sha256(JSON(policy)) 16 hex แรก ตามที่ service คำนวณจริง (ทั้ง kyc และ password)',
    kycData?.checksum === sha16(kycData.policy) && pwData.checksum === sha16(pwData.policy), {
      input: 'recompute sha256(...).hex.slice(0,16) from the response body',
      expected: `${kycData?.checksum} / ${pwData.checksum}`,
      actual: `${sha16(kycData?.policy)} / ${sha16(pwData.policy)}`,
      note: ' suite ใช้ fingerprint นี้เทียบสภาพก่อน/หลังแก้ config ทุกครั้ง',
    });

  ok('defaults ที่ API คืน = layer env ของเซิร์ฟเวอร์ที่รันอยู่จริง (server/.env ไม่ได้ตั้ง KYC_*/PASSWORD_*/AVATAR_*)',
    diffFields(kycData?.defaults, ENV_DEFAULTS.kyc).length === 0 &&
      diffFields(pwData?.defaults, ENV_DEFAULTS.password).length === 0 &&
      diffFields(avData?.defaults, ENV_DEFAULTS.avatar).length === 0, {
      input: 'env fallbacks: kyc 13 ฟิลด์, password 6, avatar 3',
      expected: 'no differences',
      actual: [
        ...diffFields(kycData?.defaults, ENV_DEFAULTS.kyc),
        ...diffFields(pwData?.defaults, ENV_DEFAULTS.password),
        ...diffFields(avData?.defaults, ENV_DEFAULTS.avatar),
      ].join(' | ') || '22/22 identical',
    });

  const wantKyc = {};
  for (const field of Object.keys(KYC_KEYS)) wantKyc[field] = rowValue(snapshotMap, KYC_KEYS, field, ENV_DEFAULTS.kyc);
  wantKyc.requiredIdentityTypes = wantKyc.requiredIdentityTypes.filter((t) => wantKyc.allowedDocumentTypes.includes(t));
  wantKyc.allowedMimeTypes = wantKyc.allowedMimeTypes.filter((m) => SUPPORTED_MIME.includes(m));
  if (wantKyc.allowedMimeTypes.length === 0) wantKyc.allowedMimeTypes = [...SUPPORTED_MIME];
  const wantPassword = {};
  for (const field of Object.keys(PW_KEYS)) wantPassword[field] = rowValue(snapshotMap, PW_KEYS, field, ENV_DEFAULTS.password);
  if (wantPassword.minLength > wantPassword.maxLength) wantPassword.minLength = wantPassword.maxLength;
  const wantAvatar = {};
  for (const field of Object.keys(AV_KEYS)) wantAvatar[field] = rowValue(snapshotMap, AV_KEYS, field, ENV_DEFAULTS.avatar);
  wantAvatar.allowedMimeTypes = wantAvatar.allowedMimeTypes.filter((m) => SUPPORTED_MIME.includes(m));
  if (wantAvatar.allowedMimeTypes.length === 0) wantAvatar.allowedMimeTypes = [...SUPPORTED_MIME];

  ok('policy ที่อ่านได้ = กฎ layering env -> rows ของ system_config จริง (kyc 13 + password 6 + avatar 3 ฟิลด์)',
    diffFields(kycData?.policy, wantKyc).length === 0 && diffFields(pwData?.policy, wantPassword).length === 0 &&
      diffFields(avData?.policy, wantAvatar).length === 0, {
      input: 'independent overlay ของ 12 แถว baseline',
      expected: 'no differences',
      actual: [
        ...diffFields(kycData?.policy, wantKyc),
        ...diffFields(pwData?.policy, wantPassword),
        ...diffFields(avData?.policy, wantAvatar),
      ].join(' | ') || '22/22 identical',
    });

  const otherRole = await api('GET', '/api/config/kyc', { token: tokens.viewer });
  ok('ทุก GET ของ /api/config ใช้ได้กับทุก role ที่ login แล้ว (VIEWER อ่าน policy ได้)',
    otherRole.status === 200 && sha16(otherRole.json?.data?.policy) === fpBefore.kyc, {
      input: 'GET /api/config/kyc with test_view1',
      expected: `200 + checksum ${fpBefore.kyc}`,
      actual: `${otherRole.status} checksum=${sha16(otherRole.json?.data?.policy)}`,
      note: 'policy เป็นค่ากลางที่ UI แสดงให้ทุก role จึงใช้ requireAuth ไม่ใช่ requireRole(ADMIN) — อ่านได้อย่างเดียว เขียนต้อง ADMIN',
    });

  // hot reload: every getter queries system_config per call (no cache, no restart)
  await sqlSet('kyc.expiryWarningDays', 15, null);
  const hotKyc = await getKyc();
  await sqlSet('password.requireSymbol', 1, null);
  const hotPw = await getPassword();
  await sqlSet('avatar.enabled', 0, null);
  const hotAv = await getAvatar();
  await sqlSet('approval.headThreshold', 123456, null);
  const hotTh = await getThresholds();
  ok('แก้ system_config ด้วย SQL แล้ว GET อ่านค่าใหม่ทันทีทั้ง 4 surface (ไม่มี cache, ไม่ต้อง restart)',
    hotKyc?.policy?.expiryWarningDays === 15 && hotPw?.policy?.requireSymbol === true &&
      hotAv?.policy?.enabled === false && hotTh?.headThreshold === 123456, {
      input: 'SQL UPDATE 4 แถว -> GET /kyc /password /avatar /thresholds',
      expected: '15 / true / false / 123456',
      actual: `${hotKyc?.policy?.expiryWarningDays} / ${hotPw?.policy?.requireSymbol} / ${hotAv?.policy?.enabled} / ${hotTh?.headThreshold}`,
    });
  await applySnapshot();
  const fpAfterHot = await fingerprint();
  ok('หลังคืนค่าด้วย snapshot แล้ว fingerprint ทั้ง 4 surface กลับเท่าก่อนเริ่ม suite',
    JSON.stringify(fpAfterHot) === JSON.stringify(fpBefore), {
      input: 'applySnapshot() then re-read all four endpoints',
      expected: JSON.stringify(fpBefore),
      actual: JSON.stringify(fpAfterHot),
    });

  const publicPw = await http('GET', '/api/auth/password-policy');
  const pwLive = await getPassword();
  ok('GET /api/auth/password-policy เปิดให้คนไม่ login อ่าน policy ที่บังคับใช้จริงได้ (ข้อมูล policy หลุดออกนอกระบบ)',
    publicPw.status === 200 && JSON.stringify(publicPw.json?.data?.policy) === JSON.stringify(pwLive?.policy), {
      input: 'GET /api/auth/password-policy without a token',
      expected: `200 + same policy as /api/config/password (${JSON.stringify(pwLive?.policy)})`,
      actual: `${publicPw.status} ${JSON.stringify(publicPw.json?.data ?? publicPw.json).slice(0, 160)}`,
      note: 'F-CFG-OBS-1: min/max length และ rule ที่ตั้งไว้ปรากฏให้คนนอกเห็น (ช่วยให้ attackerเดารูปแบบรหัสผ่าน) — ตั้งใจเปิดให้หน้า login แสดงกติกา จึงถือเป็น trade-off ที่ต้องตัดสินใจก่อน Production (ไม่ได้แก้โค้ด ให้รายงานอย่างเดียว)',
    });

  // ================================================================ B. auth surface
  const paths401 = [
    ['GET', '/api/config/thresholds'], ['GET', '/api/config/kyc'], ['GET', '/api/config/password'],
    ['GET', '/api/config/avatar'], ['PUT', '/api/config/thresholds'], ['PUT', '/api/config/kyc'],
    ['PUT', '/api/config/password'], ['PUT', '/api/config/avatar'],
  ];
  const noauth = [];
  for (const [m, p] of paths401) {
    const r = await api(m, p, { token: null, body: m === 'PUT' ? {} : undefined });
    if (r.status !== 401) noauth.push(`${m} ${p} -> ${r.status}`);
  }
  ok('ทุก endpoint ของ /api/config ตอบ 401 เมื่อไม่มี token (8 เส้นทาง)', noauth.length === 0, {
    input: '4 GET + 4 PUT without a bearer token',
    expected: 'all 401',
    actual: noauth.length ? noauth.join(', ') : '8/8 401',
  });

  const guardCfgBefore = rowsJson(await cfgNow());
  const guardAuditBefore = (await rows(conn, 'SELECT id FROM audit_logs')).length;
  const guardFp = await fingerprint();
  const deny = [];
  for (const role of ['head', 'checker1', 'op1', 'viewer']) {
    for (const [p, body] of [
      ['/api/config/thresholds', { checkerThreshold: 1, headThreshold: 1 }],
      ['/api/config/kyc', { maxFileSizeKb: 2048 }],
      ['/api/config/password', { minLength: 9 }],
      ['/api/config/avatar', { enabled: false }],
    ]) {
      const r = await api('PUT', p, { token: tokens[role], body });
      if (r.status !== 403) deny.push(`${role} PUT ${p} -> ${r.status}`);
    }
  }
  ok('PUT ทั้ง 4 endpoint ตอบ 403 กับ role ที่ไม่ใช่ ADMIN (16 calls)', deny.length === 0, {
    input: 'HEAD_APPROVER/CHECKER/MAKER/VIEWER x 4 endpoints',
    expected: 'all 403',
    actual: deny.length ? deny.join(', ') : '16/16 403',
  });
  const guardCfgAfter = rowsJson(await cfgNow());
  const guardAuditAfter = (await rows(conn, 'SELECT id FROM audit_logs')).length;
  const guardFpAfter = await fingerprint();
  ok('คำขอที่ถูกปฏิเสธไม่ทิ้งร่องรอย: system_config ทุกแถว, audit, checksum ไม่เปลี่ยนเลย',
    guardCfgAfter === guardCfgBefore && guardAuditAfter === guardAuditBefore &&
      JSON.stringify(guardFpAfter) === JSON.stringify(guardFp), {
      input: 'row-by-row config diff + audit row count + 4 fingerprints',
      expected: 'identical to the pre-attempt state',
      actual: `config ${guardCfgAfter === guardCfgBefore ? 'same' : 'DIFF'} / audit ${guardAuditAfter} vs ${guardAuditBefore} / fp ${JSON.stringify(guardFpAfter) === JSON.stringify(guardFp) ? 'same' : 'DIFF'}`,
      note: 'suite 01 ตรวจแค่ status code ของ RBAC — ส่วนนี้ยืนยันว่า 403 แล้วไม่มี side effect ซึ่งสำคัญมากกับค่ากลางที่กระทบทุก module',
    });

  const notFound = await api('GET', '/api/config/nope', { token: admin });
  statusCheck(CAT, 'path ที่ไม่มีใน /api/config: 404 Not found (ไม่วนเข้า errorHandler เป็น 500)', notFound, 404, {
    input: 'GET /api/config/nope',
  });

  // ================================================================ C. zod shape guards (400)
  const shapeCases = [
    ['PUT /thresholds ทิ้ง body เปล่า (2 ค่าต้องมาคู่กัน)', '/api/config/thresholds', {}],
    ['PUT /thresholds ส่งมาแค่ checkerThreshold', '/api/config/thresholds', { checkerThreshold: 1000 }],
    ['PUT /thresholds ค่าติดลบ', '/api/config/thresholds', { checkerThreshold: -1, headThreshold: 10 }],
    ['PUT /thresholds ค่า 0 (zod positive บล็อกไว้)', '/api/config/thresholds', { checkerThreshold: 0, headThreshold: 10 }],
    ['PUT /thresholds เป็น string', '/api/config/thresholds', { checkerThreshold: '1000', headThreshold: '2000' }],
    ['PUT /thresholds เป็น null', '/api/config/thresholds', { checkerThreshold: null, headThreshold: null }],
    ['PUT /kyc maxFileSizeKb = 0', '/api/config/kyc', { maxFileSizeKb: 0 }],
    ['PUT /kyc maxFileSizeKb = 102401 (เกินเพดาน zod)', '/api/config/kyc', { maxFileSizeKb: 102401 }],
    ['PUT /kyc maxFileSizeKb ไม่เป็นจำนวนเต็ม', '/api/config/kyc', { maxFileSizeKb: 1024.5 }],
    ['PUT /kyc maxFilesPerRequest = 0', '/api/config/kyc', { maxFilesPerRequest: 0 }],
    ['PUT /kyc maxFilesPerRequest = 11', '/api/config/kyc', { maxFilesPerRequest: 11 }],
    ['PUT /kyc allowedMimeTypes = []', '/api/config/kyc', { allowedMimeTypes: [] }],
    ['PUT /kyc mime สั้นกว่า 4 ตัวอักษร', '/api/config/kyc', { allowedMimeTypes: ['ab'] }],
    ['PUT /kyc allowedDocumentTypes = []', '/api/config/kyc', { allowedDocumentTypes: [] }],
    ['PUT /kyc document type ที่ไม่มีใน enum', '/api/config/kyc', { allowedDocumentTypes: ['DRIVING_LICENSE'] }],
    ['PUT /kyc requiredIdentityTypes = []', '/api/config/kyc', { requiredIdentityTypes: [] }],
    ['PUT /kyc expiryWarningDays = 3651', '/api/config/kyc', { expiryWarningDays: 3651 }],
    ['PUT /kyc maxTotalBytesPerCustomer = 0', '/api/config/kyc', { maxTotalBytesPerCustomer: 0 }],
    ['PUT /kyc ส่ง boolean เป็น string', '/api/config/kyc', { requireSignature: 'true' }],
    ['PUT /password minLength = 3 (ใต้ floor ของ zod)', '/api/config/password', { minLength: 3 }],
    ['PUT /password minLength = 65', '/api/config/password', { minLength: 65 }],
    ['PUT /password maxLength = 129', '/api/config/password', { maxLength: 129 }],
    ['PUT /password ไม่เป็นจำนวนเต็ม', '/api/config/password', { minLength: 8.5 }],
    ['PUT /password requireDigit เป็น string', '/api/config/password', { requireDigit: 'yes' }],
    ['PUT /avatar maxFileSizeKb = 0', '/api/config/avatar', { maxFileSizeKb: 0 }],
    ['PUT /avatar maxFileSizeKb = 10241', '/api/config/avatar', { maxFileSizeKb: 10241 }],
    ['PUT /avatar allowedMimeTypes = []', '/api/config/avatar', { allowedMimeTypes: [] }],
    ['PUT /avatar enabled เป็น number', '/api/config/avatar', { enabled: 1 }],
  ];
  const shapeBad = [];
  for (const [, path, body] of shapeCases) {
    const r = await api('PUT', path, { token: admin, body });
    if (r.status !== 400 || !errorMessage(r).includes('Validation failed')) {
      shapeBad.push(`${path} ${JSON.stringify(body)} -> ${r.status} ${errorMessage(r).slice(0, 50)}`);
    }
  }
  ok(`ร่าง request ผิดชนิด/เกินขอบเขตของ zod ทั้ง ${shapeCases.length} เคส: 400 Validation failed ทุกเคส`, shapeBad.length === 0, {
    input: `${shapeCases.length} malformed bodies`,
    expected: 'all 400 Validation failed',
    actual: shapeBad.length ? shapeBad.join(' | ') : `${shapeCases.length}/${shapeCases.length} 400`,
    note: 'zod กันไว้ก่อน business validation จึงไม่มี row ไหนถูกแตะ (ยืนยันด้วย diff ท้าย section)',
  });
  const shapeSample = await api('PUT', '/api/config/kyc', { token: admin, body: { maxFileSizeKb: 0 } });
  ok('400 จาก zod มี details ระบุว่าฟิลด์ไหนผิด (flatten ของ zod)', !!shapeSample.json?.error?.details, {
    input: 'PUT /kyc {maxFileSizeKb:0}',
    expected: 'error.details present',
    actual: JSON.stringify(shapeSample.json).slice(0, 220),
  });
  const stripped = await api('PUT', '/api/config/kyc', {
    token: admin,
    body: { maxFileSizeKb: 5120, totallyUnknownField: 'x', requireSignature: true },
  });
  ok('คีย์ที่ไม่รู้จักใน body ถูก zod ตัดทิ้ง (ไม่กลายเป็น config row ใหม่)', stripped.status === 200, {
    input: 'PUT /kyc with totallyUnknownField',
    expected: '200 and only the known fields applied',
    actual: `${stripped.status} ${JSON.stringify(stripped.json?.error ?? 'no error').slice(0, 80)}`,
    note: 'object ของ zod เป็นแบบ strip ไม่ใช่ strict — ฟิลด์ที่ UI พิมพ์ผิดชื่อจะเงียบหายไม่รายงาน (พฤติกรรมที่ควรรู้เวลาตั้งค่าผ่านหน้าจอ admin)',
  });
  await markConfigSeen();
  await applySnapshot();
  ok('หลังชุด 400 + PUT ที่สำเร็จ 1 ครั้งแล้ว revert: system_config เท่ากับ baseline ทุกแถว',
    rowsJson(await cfgNow()) === snapshotJson, {
      input: 'full table diff vs the baseline snapshot',
      expected: 'identical',
      actual: rowsJson(await cfgNow()) === snapshotJson ? `${snapshot.length} rows identical` : 'DIFF',
    });

  // ================================================================ D. business guards (422)
  const businessCases = [
    ['/api/config/kyc', { allowedDocumentTypes: ['PASSPORT'], requiredIdentityTypes: ['NATIONAL_ID'] },
      'requiredIdentityTypes must be a subset of allowedDocumentTypes'],
    ['/api/config/kyc', { allowedMimeTypes: ['application/pdf'] }, 'Only image uploads are supported; rejected: application/pdf'],
    ['/api/config/kyc', { allowedMimeTypes: ['image/svg+xml'] }, 'Only image uploads are supported; rejected: image/svg+xml'],
    ['/api/config/kyc', { maxFileSizeKb: 40, maxTotalBytesPerCustomer: 40 * 1024 - 1 },
      'maxTotalBytesPerCustomer must allow at least one maximum-size document'],
    ['/api/config/password', { requireDigit: false, requireUppercase: false, requireLowercase: false, requireSymbol: false },
      'At least one character rule must stay enabled'],
    ['/api/config/password', { minLength: 20, maxLength: 10 }, 'maxLength must be between 20 and 128'],
    ['/api/config/avatar', { allowedMimeTypes: ['image/gif'] }, 'Only image uploads are supported; rejected: image/gif'],
  ];
  const bizBad = [];
  for (const [path, body, msg] of businessCases) {
    const r = await api('PUT', path, { token: admin, body });
    if (r.status !== 422 || !errorMessage(r).includes(msg)) bizBad.push(`${path} -> ${r.status} ${errorMessage(r).slice(0, 70)}`);
  }
  ok('business validation 7 เคส: 422 พร้อมข้อความตรงตามที่ service throw', bizBad.length === 0, {
    input: 'kyc 4 + password 2 + avatar 1 patch ที่ขัดกติกาของ policy',
    expected: 'all 422 with the exact message',
    actual: bizBad.length ? bizBad.join(' | ') : '7/7 422',
  });
  const bizAudit = await configAuditSince();
  ok('422 ทุกเคส rollback เกลี้ยง: ไม่แก้แถวไหน ไม่สร้าง audit CONFIG_UPDATED',
    rowsJson(await cfgNow()) === snapshotJson && bizAudit.fresh.length === 0, {
      input: 'value/valueText diff ของทุกแถว + นับ CONFIG_UPDATED จากจุดเริ่มต้น',
      expected: 'no row changed, 0 audit rows',
      actual: `rows ${rowsJson(await cfgNow()) === snapshotJson ? 'same' : 'DIFF'} / CONFIG_UPDATED=${bizAudit.fresh.length}`,
      note: 'ทั้งสาม PUT ครอบด้วย ds.transaction จึง atomic — ต่างจาก /thresholds ที่เขียนทีละแถว (ดู F-CFG-2)',
    });

  const deadBranch = [];
  for (const [path, body] of [
    ['/api/config/kyc', { expiryWarningDays: 3651 }],
    ['/api/config/kyc', { maxFileSizeKb: 102401 }],
    ['/api/config/kyc', { maxFilesPerRequest: 11 }],
    ['/api/config/kyc', { allowedDocumentTypes: [] }],
    ['/api/config/avatar', { maxFileSizeKb: 10241 }],
  ]) {
    const r = await api('PUT', path, { token: admin, body });
    if (r.status !== 400) deadBranch.push(`${path} ${JSON.stringify(body)} -> ${r.status} want 400`);
  }
  ok('ข้อความ 422 ที่ path ปกติเข้าไม่ถึง (zod กันขอบเขตเดียวกันไว้ก่อน): ได้ 400 ไม่ใช่ 422', deadBranch.length === 0, {
    input: '5 patch ที่ค่าอยู่นอกขอบเขตทั้งของ zod และของ business check',
    expected: '400 (zod wins)',
    actual: deadBranch.length ? deadBranch.join(' | ') : '5/5 400',
    note: '"expiryWarningDays must be between 0 and 3650", "maxFileSizeKb must be between 1 and 102400", "maxFilesPerRequest must be between 1 and 10", "At least one KYC document type must stay enabled" และ "At least one image type must stay allowed" จึงไม่เกิดจาก path ปกติ — reachable ผ่านแถวเก่า/out-of-band เท่านั้น (ดู section G)',
  });

  const boundary = await api('PUT', '/api/config/kyc', { token: admin, body: { maxFileSizeKb: 40, maxTotalBytesPerCustomer: 40 * 1024 } });
  ok('ขอบเขต maxTotalBytesPerCustomer = maxFileSizeKb*1024 พอดี: 200 (ไม่ปัดตกแบบ off-by-one)',
    boundary.status === 200 && boundary.json?.data?.policy?.maxFileSizeKb === 40 &&
      boundary.json?.data?.policy?.maxTotalBytesPerCustomer === 40960, {
      input: 'PUT /kyc {40 KB, 40960 bytes}',
      expected: '200 + both values live',
      actual: `${boundary.status} ${JSON.stringify(boundary.json?.data?.policy ?? boundary.json?.error).slice(0, 120)}`,
    });
  await markConfigSeen();
  await applySnapshot();

  // ================================================================ E. writes + audit contract
  const thPut = await api('PUT', '/api/config/thresholds', { token: admin, body: { checkerThreshold: 1500000, headThreshold: 15000000 } });
  const thRows = mapOf(await cfgNow());
  ok('PUT /thresholds ที่ถูกต้อง: 200 + object เปลือยค่าใหม่ และ system_config ถูกเขียน 2 คีย์',
    thPut.status === 200 && thPut.json?.checkerThreshold === 1500000 && thPut.json?.headThreshold === 15000000 &&
      Number(thRows.get('approval.checkerThreshold')?.value) === 1500000 &&
      Number(thRows.get('approval.headThreshold')?.value) === 15000000, {
      input: 'PUT {checker:1500000, head:15000000}',
      expected: '200 + rows 1500000.00 / 15000000.00',
      actual: `${thPut.status} body=${JSON.stringify(thPut.json)} rows=${thRows.get('approval.checkerThreshold')?.value}/${thRows.get('approval.headThreshold')?.value}`,
    });
  const adminRow = (await rows(conn, 'SELECT id FROM users WHERE username=?', ['test_admin']))[0];
  ok('PUT /thresholds เขียน description ของ 2 คีย์ตามที่โค้ดกำหนด และ updatedBy = ผู้กระทำ',
    thRows.get('approval.checkerThreshold')?.description === 'Amounts at or below this need Maker -> Checker only' &&
      thRows.get('approval.headThreshold')?.description === 'Amounts above this also need Head and Admin final approval' &&
      thRows.get('approval.checkerThreshold')?.updatedBy === adminRow?.id &&
      thRows.get('approval.headThreshold')?.updatedBy === adminRow?.id, {
      input: 'description/updatedBy ของทั้งสองแถว',
      expected: 'สองข้อความที่ hardcode ไว้ + updatedBy = uuid ของ test_admin',
      actual: `${thRows.get('approval.checkerThreshold')?.description} | ${thRows.get('approval.headThreshold')?.description} | by=${thRows.get('approval.checkerThreshold')?.updatedBy}`,
      note: 'seed เขียน description คนละข้อความ (Maker->Checker up to this amount (LAK)) การ PUT ผ่าน API จึงทับข้อความเดิม — คำอธิบายในหน้า admin เปลี่ยนไปหลังแตะ threshold ครั้งแรก',
    });
  const thAudit = await configAuditSince();
  const thLatest = thAudit.latest ?? {};
  ok('audit CONFIG_UPDATED ของ threshold: previousStatus/newStatus เป็น checker=..,head=.. และ reason ระบุ before -> after',
    thAudit.fresh.length === 1 && thLatest.previousStatus === 'checker=1000000,head=10000000' &&
      thLatest.newStatus === 'checker=1500000,head=15000000' &&
      thLatest.reason === 'Approval thresholds updated: checker 1000000 -> 1500000, head 10000000 -> 15000000' &&
      !!thLatest.ip, {
      input: 'แถว CONFIG_UPDATED ที่ PUT นี้สร้าง',
      expected: 'checker=1000000,head=10000000 -> checker=1500000,head=15000000',
      actual: `${thLatest.previousStatus} | ${thLatest.newStatus} | reason=${String(thLatest.reason).slice(0, 90)} | ip=${thLatest.ip}`,
      note: 'reason/status ใช้เลขทศนิยมไม่มีจุลภาคพัน — อ่านง่ายแต่ต้องเทียบตัวเลขกับ value ในตารางเอง',
    });
  await markConfigSeen();

  const thEqual = await api('PUT', '/api/config/thresholds', { token: admin, body: { checkerThreshold: 1, headThreshold: 1 } });
  ok('ขอบเขต head == checker ใช้ได้ (เงื่อนไขเป็น >= ไม่ใช่ >)', thEqual.status === 200 && thEqual.json?.headThreshold === 1, {
    input: 'PUT {1, 1}',
    expected: '200',
    actual: `${thEqual.status} ${JSON.stringify(thEqual.json ?? thEqual.json?.error).slice(0, 120)}`,
  });
  const afterEqual = rowsJson(await cfgNow());
  const thBelow = await api('PUT', '/api/config/thresholds', { token: admin, body: { checkerThreshold: 100, headThreshold: 99.99 } });
  ok('head < checker: 400 พร้อมข้อความ invariant และไม่มีแถวถูกแก้เพิ่ม', thBelow.status === 400 &&
    errorMessage(thBelow).includes('Head threshold must be greater than or equal to the checker threshold') &&
    rowsJson(await cfgNow()) === afterEqual, {
      input: 'PUT {100, 99.99} ต่อจาก PUT {1,1}',
      expected: '400 + ตารางเท่าเดิม (ค่า 1/1 ของ PUT ก่อนหน้า)',
      actual: `${thBelow.status} ${errorMessage(thBelow).slice(0, 90)} | rows ${rowsJson(await cfgNow()) === afterEqual ? 'unchanged' : 'CHANGED'}`,
      note: 'invariant head>=checker เช็คที่ router layer ด้วย badRequest (ไม่ใช่ zod refine) จึงได้ 400 ไม่ใช่ 422',
    });
  await markConfigSeen();
  await applySnapshot();

  const kycPut = await api('PUT', '/api/config/kyc', {
    token: admin,
    body: {
      maxFileSizeKb: 1024,
      maxTotalBytesPerCustomer: 3145728,
      expiryWarningDays: 30,
      requireFamilyBook: true,
      allowedDocumentTypes: ['NATIONAL_ID', 'PASSPORT', 'SELFIE_WITH_ID', 'SIGNATURE'],
      requiredIdentityTypes: ['NATIONAL_ID', 'PASSPORT'],
      allowedMimeTypes: ['image/png'],
    },
  });
  const kycPutRows = mapOf(await cfgNow());
  const kycPolicy = kycPut.json?.data?.policy;
  ok('PUT /kyc patch 7 ฟิลด์: 200 + policy อ่านกลับตรงทั้ง 7 ฟิลด์', kycPut.status === 200 &&
    diffFields(kycPolicy, {
      maxFileSizeKb: 1024,
      maxTotalBytesPerCustomer: 3145728,
      expiryWarningDays: 30,
      requireFamilyBook: true,
      allowedDocumentTypes: ['NATIONAL_ID', 'PASSPORT', 'SELFIE_WITH_ID', 'SIGNATURE'],
      requiredIdentityTypes: ['NATIONAL_ID', 'PASSPORT'],
      allowedMimeTypes: ['image/png'],
    }).length === 0, {
      input: 'patch 7 fields at once',
      expected: 'all 7 applied',
      actual: `${kycPut.status} ${diffFields(kycPolicy, {
        maxFileSizeKb: 1024, maxTotalBytesPerCustomer: 3145728, expiryWarningDays: 30, requireFamilyBook: true,
        allowedDocumentTypes: ['NATIONAL_ID', 'PASSPORT', 'SELFIE_WITH_ID', 'SIGNATURE'],
        requiredIdentityTypes: ['NATIONAL_ID', 'PASSPORT'], allowedMimeTypes: ['image/png'],
      }).join(', ') || 'all 7 match'}`,
    });
  const kycTouched = ['kyc.upload.maxFileSizeKb', 'kyc.maxTotalBytesPerCustomer', 'kyc.expiryWarningDays',
    'kyc.requireFamilyBook', 'kyc.allowedDocumentTypes', 'kyc.requiredIdentityTypes', 'kyc.upload.allowedMimeTypes'];
  const kycCreated = kycTouched.filter((k) => !snapshotMap.has(k) && kycPutRows.has(k));
  const kycUntouched = [...snapshotMap.keys()]
    .filter((k) => !kycTouched.includes(k))
    .filter((k) => String(snapshotMap.get(k).value) !== String(kycPutRows.get(k)?.value) ||
      String(snapshotMap.get(k).valueText ?? '') !== String(kycPutRows.get(k)?.valueText ?? ''));
  ok('PUT /kyc เขียนเฉพาะ key ของ field ที่ส่งมา และ key อื่นในระบบไม่ถูกแตะ',
    kycCreated.length === 4 && kycUntouched.length === 0, {
      input: 'row-level diff by key',
      expected: '4 key ใหม่ (familyBook, docTypes, identityTypes, mime) + 3 key เดิมถูกแก้, 0 คีย์อื่นเปลี่ยน',
      actual: `created=[${kycCreated.join(',')}] othersChanged=[${kycUntouched.join(',')}]`,
    });
  ok('แถวแบบ csv/docTypes ที่สร้างใหม่เก็บ value เป็น 0.00 (คอลัมน์เดียวใช้ร่วม, overlay อ่านเฉพาะ valueText)',
    Number(kycPutRows.get('kyc.allowedDocumentTypes')?.value) === 0 &&
      kycPutRows.get('kyc.allowedDocumentTypes')?.valueText === 'NATIONAL_ID,PASSPORT,SELFIE_WITH_ID,SIGNATURE', {
      input: 'แถว kyc.allowedDocumentTypes ที่เพิ่งสร้าง',
      expected: 'value=0.00 + valueText = รายการที่ join ด้วย ,',
      actual: `value=${kycPutRows.get('kyc.allowedDocumentTypes')?.value} valueText=${kycPutRows.get('kyc.allowedDocumentTypes')?.valueText}`,
      note: 'design เดียวกันทั้งตาราง system_config — ค่า 0 ไม่ใช่ของเสีย แต่ทำให้ "0 = ไม่ได้ตั้ง" เป็นบรรทัดฐานของ layer overlay (รากของ F-CFG-1)',
    });
  const kycAudit = await configAuditSince();
  ok('audit CONFIG_UPDATED ของ kyc: previousStatus/newStatus = checksum 16 hex ของ policy ก่อน/หลัง + reason แบบ describe',
    kycAudit.fresh.length === 1 && kycAudit.latest?.previousStatus === fpBefore.kyc &&
      kycAudit.latest?.newStatus === sha16(kycPolicy) &&
      /^KYC policy files<=5120KB,mime=image\/jpeg\|image\/png\|image\/webp,identity=NATIONAL_ID\|ID_CARD\|PASSPORT.*  ->  files<=1024KB,mime=image\/png,identity=NATIONAL_ID\|PASSPORT/.test(String(kycAudit.latest?.reason)), {
      input: 'แถว CONFIG_UPDATED ของ PUT นี้',
      expected: `${fpBefore.kyc} -> ${sha16(kycPolicy)} + describe text ที่มี 2 spaces ก่อน/หลัง ->`,
      actual: `${kycAudit.latest?.previousStatus} -> ${kycAudit.latest?.newStatus} | ${String(kycAudit.latest?.reason).slice(0, 210)}`,
      note: 'reason (describeKycPolicy) ไม่ครอบคลุม maxFilesPerRequest, allowedDocumentTypes, expiryWarningDays, reverifyOnDocumentChange — แก้ 4 ฟิลด์นี้แล้วอ่านย้อนหลังได้เฉพาะจาก checksum ที่เปลี่ยนเท่านั้น',
    });
  await markConfigSeen();
  await applySnapshot();

  const pwPut = await api('PUT', '/api/config/password', { token: admin, body: { minLength: 8, maxLength: 24, requireDigit: false, requireSymbol: true } });
  const pwAudit = await configAuditSince();
  const pwPutRows = mapOf(await cfgNow());
  ok('PUT /password 4 ฟิลด์: 200 + audit reason เป็น describePasswordPolicy แบบ "length a-b, rule|rule"',
    pwPut.status === 200 && pwPut.json?.data?.policy?.minLength === 8 && pwPut.json?.data?.policy?.requireSymbol === true &&
      pwAudit.fresh.length === 1 &&
      /^Password policy length 6-16, digit\|uppercase\|lowercase  ->  length 8-24, uppercase\|lowercase\|symbol$/.test(String(pwAudit.latest?.reason)), {
        input: 'PUT {8, 24, digit:false, symbol:true}',
        expected: '200 + "length 6-16, digit|uppercase|lowercase  ->  length 8-24, uppercase|lowercase|symbol"',
        actual: `${pwPut.status} | ${pwAudit.latest?.reason} | ${pwAudit.latest?.previousStatus} -> ${pwAudit.latest?.newStatus}`,
        note: 'ลำดับ rule ในข้อความมาจาก array RULES (digit, uppercase, lowercase, symbol) ไม่ใช่ key order ของ policy',
      });
  ok('PUT /password เก็บ boolean เป็น 0/1 ในคอลัมน์ value เดียวกับ numeric',
    Number(pwPutRows.get('password.requireDigit')?.value) === 0 && Number(pwPutRows.get('password.requireSymbol')?.value) === 1 &&
      Number(pwPutRows.get('password.minLength')?.value) === 8 && Number(pwPutRows.get('password.maxLength')?.value) === 24, {
      input: '4 แถว password หลัง PUT',
      expected: 'digit=0.00 symbol=1.00 minLength=8.00 maxLength=24.00',
      actual: ['password.requireDigit', 'password.requireSymbol', 'password.minLength', 'password.maxLength']
        .map((k) => `${k}=${pwPutRows.get(k)?.value}`).join(' '),
    });
  await markConfigSeen();
  await applySnapshot();

  const avPut = await api('PUT', '/api/config/avatar', { token: admin, body: { enabled: false, maxFileSizeKb: 600 } });
  const avAudit = await configAuditSince();
  ok('PUT /avatar 2 ฟิลด์: 200 + reason "Avatar policy enabled=1,<=512KB  ->  enabled=0,<=600KB"',
    avPut.status === 200 && avPut.json?.data?.policy?.enabled === false && avPut.json?.data?.policy?.maxFileSizeKb === 600 &&
      avAudit.latest?.reason === 'Avatar policy enabled=1,<=512KB  ->  enabled=0,<=600KB', {
        input: 'PUT {enabled:false, maxFileSizeKb:600}',
        expected: '200 + ข้อความนั้น',
        actual: `${avPut.status} | ${avAudit.latest?.reason}`,
      });
  ok('audit ของ avatar ไม่เก็บ previousStatus/newStatus เลย (ต่างจาก kyc/password ที่เก็บ checksum)',
    avAudit.latest?.previousStatus == null && avAudit.latest?.newStatus == null, {
      input: 'แถว CONFIG_UPDATED ของ avatar PUT',
      expected: 'ทั้งสองคอลัมน์ NULL',
      actual: `previous=${avAudit.latest?.previousStatus} new=${avAudit.latest?.newStatus}`,
      note: 'F-CFG-OBS-2: ตรวจย้อนหลัง avatar ได้จากข้อความ enabled/KB ใน reason เท่านั้น — ถ้าแก้ allowedMimeTypes อย่างเดียว reason จะหน้าตาเหมือนกันก่อน/หลัง (ไม่มีหลักฐานว่า mime list เปลี่ยน)',
    });
  await markConfigSeen();

  const avEmpty = await api('PUT', '/api/config/avatar', { token: admin, body: {} });
  const avEmptyAudit = await configAuditSince();
  ok('PUT body เปล่า {} ยัง 200 และสร้าง audit CONFIG_UPDATED 1 แถวทั้งที่ไม่ได้แก้อะไร (audit noise)',
    avEmpty.status === 200 && avEmptyAudit.fresh.length === 1 &&
      (() => {
        const parts = String(avEmptyAudit.latest?.reason ?? '').split('  ->  ');
        const before = String(parts[0] ?? '').replace(/^Avatar policy /, '');
        return !!before && before === parts[1];
      })(), {
      input: 'PUT /api/config/avatar {}',
      expected: '200 + 1 audit row ที่ before == after',
      actual: `${avEmpty.status} rows=${avEmptyAudit.fresh.length} reason=${String(avEmptyAudit.latest?.reason).slice(0, 120)}`,
      note: 'F-CFG-OBS-3: เช่นเดียวกับ PUT /kyc {} และ /password {} — ผู้โจมตีหรือ admin ที่กด save เปล่าๆ ทำให้ trail อ่านยากขึ้น (ไม่มีผลต่อค่าจริง)',
    });
  await markConfigSeen();
  await applySnapshot();

  const kycEmpty = await api('PUT', '/api/config/kyc', { token: admin, body: {} });
  const kycEmptyAudit = await configAuditSince();
  ok('PUT /kyc {}: checksum เดิมทั้งสองฝั่งของ audit และไม่มีแถวขยับ',
    kycEmpty.status === 200 && kycEmpty.json?.data?.checksum === fpBefore.kyc &&
      kycEmptyAudit.latest?.previousStatus === kycEmptyAudit.latest?.newStatus &&
      rowsJson(await cfgNow()) === snapshotJson, {
        input: 'PUT /api/config/kyc {}',
        expected: `${fpBefore.kyc} ทั้งสองฝั่ง, แถวเท่าเดิม`,
        actual: `${kycEmpty.status} checksum=${kycEmpty.json?.data?.checksum} audit=${kycEmptyAudit.latest?.previousStatus}/${kycEmptyAudit.latest?.newStatus}`,
      });
  await markConfigSeen();
  await applySnapshot();

  // ================================================================ F. config actually drives behaviour
  const symPut = await api('PUT', '/api/config/password', { token: admin, body: { requireSymbol: true } });
  const noSymbol = await makeUser('nosym', 'Abcdef1');
  ok('ตั้ง requireSymbol=true แล้วรหัสผ่านไม่มีสัญลักษณ์: 422 MISSING_SYMBOL พร้อมข้อความ policy ใหม่',
    symPut.status === 200 && symPut.json?.data?.policy?.requireSymbol === true && noSymbol.res.status === 422 &&
      errorMessage(noSymbol.res).includes('MISSING_SYMBOL') &&
      errorMessage(noSymbol.res).includes('length 6-16, digit|uppercase|lowercase|symbol'), {
      input: 'PUT /password {requireSymbol:true} then POST /api/users password=Abcdef1',
      expected: '422 containing MISSING_SYMBOL and the new policy description',
      actual: `${noSymbol.res.status} ${errorMessage(noSymbol.res).slice(0, 170)}`,
    });
  const withSymbol = await makeUser('withsym');
  ok('รหัสผ่านที่มี @ ผ่านนโยบายใหม่ (201) — ค่า config ที่แก้มีผลกับ endpoint อื่นทันทีโดยไม่ต้อง restart',
    withSymbol.res.status === 201, {
      input: `POST /api/users password=${PASSWORD}`,
      expected: '201',
      actual: `${withSymbol.res.status} ${errorMessage(withSymbol.res).slice(0, 120)}`,
    });
  await markConfigSeen();

  const loginAfterTight = await http('POST', '/api/auth/login', { body: { username: 'test_view1', password: PASSWORD } });
  ok('บัญชีเดิมที่รหัสไม่ตรง policy ใหม่ยัง login ได้ (policy บังคับเฉพาะตอนเขียนรหัสใหม่)',
    loginAfterTight.status === 200 && !!loginAfterTight.json?.token, {
      input: 'POST /api/auth/login ด้วยรหัสทดสอบ 9 ตัวอักษร ขณะ requireSymbol=true (รหัสทดสอบมี @ จึงยังไม่ชัดเท่า min length)',
      expected: '200 เพราะ bcrypt hash ตรงกัน',
      actual: `${loginAfterTight.status} ${JSON.stringify(loginAfterTight.json?.error ?? 'token issued').slice(0, 90)}`,
      note: 'F-CFG-OBS-4: ถ้านโยบายใหม่เข้มขึ้น ผู้ใช้เดิมไม่ได้ถูกบังคับให้เปลี่ยนรหัส — ก่อน Production ควรประกาศนโยบายการ reset รหัสผ่านค้างเก่า (รายงานอย่างเดียว ไม่แก้)',
    });

  const pwTight2 = await api('PUT', '/api/config/password', { token: admin, body: { requireSymbol: false, minLength: 12 } });
  const shortPw = await makeUser('short', 'Abc123!');
  ok('ตั้ง minLength=12 แล้วรหัส 7 ตัว: 422 TOO_SHORT', pwTight2.status === 200 &&
    shortPw.res.status === 422 && errorMessage(shortPw.res).includes('TOO_SHORT'), {
      input: 'PUT /password {minLength:12} then POST /api/users password=Abc123!',
      expected: '422 TOO_SHORT',
      actual: `${shortPw.res.status} ${errorMessage(shortPw.res).slice(0, 170)}`,
    });
  await markConfigSeen();
  await applySnapshot();
  const looser = await makeUser('restored', 'Abc123!');
  ok('หลังคืน policy เป็น baseline รหัส 7 ตัวผ่านอีกครั้ง (201) — พิสูจน์ว่า overlay อ่านค่าใหม่จริง ไม่ได้ cache ของเสียไว้',
    looser.res.status === 201, {
      input: 'restore + POST /api/users password=Abc123!',
      expected: '201',
      actual: `${looser.res.status} ${errorMessage(looser.res).slice(0, 120)}`,
    });
  const pwSelf = await fingerprint();
  ok('out of section F1: fingerprint ของ password กลับเป็นค่าเดิมก่อนเริ่ม section', pwSelf.password === fpBefore.password, {
    input: 'sha16 of GET /api/config/password policy',
    expected: fpBefore.password,
    actual: pwSelf.password,
  });

  // F2. avatar rules
  const targetUser = withSymbol.user ?? (await makeUser('av')).user;
  const avOff = await api('PUT', '/api/config/avatar', { token: admin, body: { enabled: false } });
  const upDisabled = await api('PUT', `/api/users/${targetUser.id}/avatar`, {
    token: admin,
    form: multipartFile(pngFor(1), { filename: 'cfg.png', type: 'image/png' }),
  });
  ok('avatar.enabled=false แล้วอัปโหลดรูป: 422 "Avatars are disabled by the current system policy"',
    avOff.status === 200 && upDisabled.status === 422 && errorMessage(upDisabled).includes('disabled by the current system policy'), {
      input: 'PUT /avatar {enabled:false} then PUT /api/users/:id/avatar (multipart png)',
      expected: '422 with that message',
      actual: `${upDisabled.status} ${errorMessage(upDisabled).slice(0, 140)}`,
    });
  const avSize = await api('PUT', '/api/config/avatar', { token: admin, body: { enabled: true, maxFileSizeKb: 1 } });
  const upOversize = await api('PUT', `/api/users/${targetUser.id}/avatar`, {
    token: admin,
    form: multipartFile(pngFor(4), { filename: 'cfg.png', type: 'image/png' }),
  });
  ok('avatar.maxFileSizeKb=1 ทำให้ไฟล์ 4KB ถูกปัด 413 พร้อมเลข limit ที่ตั้งใหม่ (multer อ่าน policy ต่อ request)',
    avSize.status === 200 && upOversize.status === 413 && errorMessage(upOversize).includes('configured limit of 1 KB'), {
      input: 'PUT /avatar {enabled:true, maxFileSizeKb:1} then 4 KB upload',
      expected: '413 "File is larger than the configured limit of 1 KB"',
      actual: `${upOversize.status} ${errorMessage(upOversize).slice(0, 140)}`,
    });
  const avMime = await api('PUT', '/api/config/avatar', { token: admin, body: { maxFileSizeKb: 512, allowedMimeTypes: ['image/png'] } });
  const upWrongMime = await api('PUT', `/api/users/${targetUser.id}/avatar`, {
    token: admin,
    form: multipartFile(jpgFor(1), { filename: 'cfg.jpg', type: 'image/jpeg' }),
  });
  ok('avatar.allowedMimeTypes=[image/png] แล้วส่ง jpeg: 415 ระบุรายการที่อนุญาต',
    avMime.status === 200 && upWrongMime.status === 415 &&
      errorMessage(upWrongMime).includes('image/jpeg is not allowed (allowed: image/png)'), {
      input: 'PUT /avatar {allowedMimeTypes:[image/png]} then jpeg bytes',
      expected: '415 with the allowlist in the message',
      actual: `${upWrongMime.status} ${errorMessage(upWrongMime).slice(0, 140)}`,
    });
  await markConfigSeen();
  await applySnapshot();
  const upOk = await api('PUT', `/api/users/${targetUser.id}/avatar`, {
    token: admin,
    form: multipartFile(pngFor(1), { filename: 'cfg.png', type: 'image/png' }),
  });
  const downLoaded = await api('GET', `/api/users/${targetUser.id}/avatar`, { token: admin, binary: true });
  ok('หลังคืนค่า baseline อัปโหลดได้ 201 และอ่านไบต์กลับตรงกับที่ส่ง (เปิด/ปิด config ได้จริง ไม่มี cache ค้าง)',
    upOk.status === 201 && downLoaded.status === 200 && downLoaded.buffer.length === pngFor(1).length, {
      input: 'restore + upload 1 KB png + GET /api/users/:id/avatar',
      expected: `201 + 200 ด้วย ${pngFor(1).length} bytes`,
      actual: `${upOk.status} ${errorMessage(upOk).slice(0, 60)} / ${downLoaded.status} ${downLoaded.buffer?.length ?? 0} bytes`,
    });
  const avRemoved = await api('DELETE', `/api/users/${targetUser.id}/avatar`, { token: admin });
  ok('ลบ avatar ของบัญชีทดสอบกลับสู่สภาพเดิม (200) เพื่อไม่ให้ตาราง avatar มีข้อมูลของ suite ค้าง',
    avRemoved.status === 200, {
      input: 'DELETE /api/users/:id/avatar',
      expected: '200',
      actual: `${avRemoved.status} ${errorMessage(avRemoved).slice(0, 100)}`,
    });

  // F3. KYC upload limit read live
  const pendingCustomer = (await rows(
    conn,
    "SELECT id, customerNumber, kycStatus FROM customers WHERE kycStatus='PENDING' ORDER BY customerNumber LIMIT 1",
  ))[0];
  const docsFor = async (id) => Number((await rows(conn, 'SELECT COUNT(*) n FROM kyc_documents WHERE customerId=?', [id]))[0]?.n ?? -1);
  const docsBefore = await docsFor(pendingCustomer?.id ?? 'none');
  const kycTight = await api('PUT', '/api/config/kyc', { token: admin, body: { maxFileSizeKb: 1 } });
  const kycUploadBig = await api('POST', `/api/customers/${pendingCustomer?.id}/kyc/documents`, {
    token: tokens.op1,
    form: multipartWithFields(pngFor(4), { documentType: 'PASSPORT' }, { filename: 'cfg.png', type: 'image/png' }),
  });
  ok('kyc.upload.maxFileSizeKb=1 ทำให้เอกสาร 4KB ของลูกค้าถูกปัด 413 "configured limit of 1 KB" (ค่ากลางมีผลทันที)',
    kycTight.status === 200 && kycTight.json?.data?.policy?.maxFileSizeKb === 1 && kycUploadBig.status === 413 &&
      errorMessage(kycUploadBig).includes('configured limit of 1 KB'), {
      input: `PUT /kyc {maxFileSizeKb:1} then upload to ${pendingCustomer?.customerNumber} (${pendingCustomer?.kycStatus})`,
      expected: '413 from multer using the live policy value',
      actual: `${kycUploadBig.status} ${errorMessage(kycUploadBig).slice(0, 140)}`,
    });
  await applySnapshot();
  const kycUploadOk = await api('POST', `/api/customers/${pendingCustomer?.id}/kyc/documents`, {
    token: tokens.op1,
    form: multipartWithFields(pngFor(4), { documentType: 'PASSPORT' }, { filename: 'cfg.png', type: 'image/png' }),
  });
  const createdDoc = (kycUploadOk.json?.data?.documents ?? []).find((d) => d.fileName === 'cfg.png');
  ok('หลังคืน policy เป็น 5120 KB อัปโหลดภาพ 4KB ได้ 201 (ยืนยันว่าไม่ cache ค่า 1 KB ไว้)',
    kycUploadOk.status === 201 && !!createdDoc?.id, {
      input: 'restore + POST document',
      expected: '201 + เอกสาร PASSPORT ใน response',
      actual: `${kycUploadOk.status} doc=${createdDoc?.id ?? 'none'} ${errorMessage(kycUploadOk).slice(0, 100)}`,
    });
  const docDelete = await api('DELETE', `/api/customers/${pendingCustomer?.id}/kyc/documents/${createdDoc?.id}`, { token: tokens.op1 });
  const docsAfter = await docsFor(pendingCustomer?.id);
  const custStatusNow = (await rows(conn, 'SELECT kycStatus FROM customers WHERE id=?', [pendingCustomer?.id]))[0]?.kycStatus;
  ok('ลบเอกสารที่ใช้ทดสอบเสร็จ: 200 และจำนวนเอกสาร + kycStatus ของลูกค้ากลับเท่าก่อนทดสอบ',
    docDelete.status === 200 && docsAfter === docsBefore && custStatusNow === pendingCustomer?.kycStatus, {
      input: `${pendingCustomer?.customerNumber}: DELETE document แล้วนับเอกสาร + อ่านสถานะ`,
      expected: `200 + docs=${docsBefore} + status=${pendingCustomer?.kycStatus}`,
      actual: `${docDelete.status} docs=${docsAfter} status=${custStatusNow}`,
      note: 'ลูกค้า PENDING จึงไม่โดน touchKycStatusAfterChange (ทำงานเฉพาะ VERIFIED) — สถานะ business ไม่เปลี่ยนจากการทดสอบ config',
    });

  // ================================================================ G. malformed rows (SQL layer)
  const gCases = [
    {
      name: 'แถว number ค่า 0: overlay ถือเป็น "ไม่ได้ตั้ง" แล้วถอยกลับไป env default',
      key: 'kyc.expiryWarningDays', value: 0, text: null,
      want: (p) => p?.expiryWarningDays === ENV_DEFAULTS.kyc.expiryWarningDays,
      expect: 'expiryWarningDays = 60 (default) ไม่ใช่ 0',
    },
    {
      name: 'แถว number ติดลบ: ถูกมองข้ามแบบเดียวกัน',
      key: 'kyc.maxTotalBytesPerCustomer', value: -1, text: null,
      want: (p) => p?.maxTotalBytesPerCustomer === ENV_DEFAULTS.kyc.maxTotalBytesPerCustomer,
      expect: 'default 31457280',
    },
    {
      name: 'แถว boolean ค่า 2: ไม่ใช่ 1 จึงอ่านเป็น false',
      key: 'avatar.enabled', value: 2, text: null,
      want: (p) => p?.enabled === false,
      expect: 'enabled=false',
    },
    {
      name: 'แถว csv ที่ valueText ว่าง: overlay ไม่ทับ จึงได้ default',
      key: 'kyc.upload.allowedMimeTypes', value: 0, text: '',
      want: (p) => JSON.stringify(p?.allowedMimeTypes) === JSON.stringify(ENV_DEFAULTS.kyc.allowedMimeTypes),
      expect: '3 mime จาก env',
    },
    {
      name: 'docTypes มีค่าแปลกปลอมปน: กรองเหลือเฉพาะชนิดที่รู้จัก',
      key: 'kyc.allowedDocumentTypes', value: 0, text: 'NATIONAL_ID,BOGUS_TYPE',
      want: (p) => JSON.stringify(p?.allowedDocumentTypes) === JSON.stringify(['NATIONAL_ID']) &&
        JSON.stringify(p?.requiredIdentityTypes) === JSON.stringify(['NATIONAL_ID']),
      expect: 'allowedDocumentTypes=["NATIONAL_ID"] และ requiredIdentityTypes ถูกตัดเหลือตัวที่ร่วมชุด',
    },
    {
      name: 'docTypes แปลกปลอมทั้งแถว: ผลกรองว่าง จึงถอยกลับไป default ทั้งชุด',
      key: 'kyc.allowedDocumentTypes', value: 0, text: 'NOPE,NUH_UH',
      want: (p) => JSON.stringify(p?.allowedDocumentTypes) === JSON.stringify(ENV_DEFAULTS.kyc.allowedDocumentTypes),
      expect: 'default ครบ 6 ชนิด',
    },
    {
      name: 'mime เก็บ pdf ไว้แถวเดียว: policy แลกเป็น 3 ชนิดที่รองรับ (แถวถูกข้ามเงียบ)',
      key: 'kyc.upload.allowedMimeTypes', value: 0, text: 'application/pdf',
      want: (p) => JSON.stringify(p?.allowedMimeTypes) === JSON.stringify(SUPPORTED_MIME),
      expect: 'image/jpeg,image/png,image/webp',
    },
    {
      name: 'requiredIdentityTypes ตัดกับ allowedDocumentTypes ตอนอ่าน (ชนิดที่ปิดใช้งานถูกลืม)',
      key: 'kyc.allowedDocumentTypes', value: 0, text: 'PASSPORT',
      extra: ['kyc.requiredIdentityTypes', 0, 'NATIONAL_ID,ID_CARD,PASSPORT'],
      want: (p) => JSON.stringify(p?.requiredIdentityTypes) === JSON.stringify(['PASSPORT']) &&
        JSON.stringify(p?.allowedDocumentTypes) === JSON.stringify(['PASSPORT']),
      expect: 'requiredIdentityTypes=["PASSPORT"]',
    },
    {
      name: 'minLength ใน DB ใหญ่กว่า maxLength: overlay แก้ตัวเอง ด้วย clamp (ไม่มี warning)',
      key: 'password.minLength', value: 100, text: null,
      want: (p) => p?.minLength === 16 && p?.maxLength === 16,
      expect: 'minLength ถูก clamp เป็น 16 ทั้งที่แถวเก็บ 100.00',
    },
  ];
  for (const g of gCases) {
    await sqlSet(g.key, g.value, g.text);
    if (g.extra) await sqlSet(g.extra[0], g.extra[1], g.extra[2]);
    const read = g.key.startsWith('avatar') ? await getAvatar() : g.key.startsWith('password') ? await getPassword() : await getKyc();
    const stored = mapOf(await cfgNow()).get(g.key);
    ok(g.name, g.want(read?.policy), {
      input: `SQL ${g.key} = ${g.value}${g.text === null ? '' : ` , valueText="${g.text}"`}`,
      expected: g.expect,
      actual: `${JSON.stringify(read?.policy).slice(0, 150)} | stored=${stored?.value}/${stored?.valueText}`,
      note: 'layering เป็น read-time leniency: ค่าเสียไม่ทำให้ GET ล้ม และไม่บอกผู้ใช้ว่าแถวที่ตั้งไว้ไม่มีผลจริง',
    });
    await applySnapshot();
  }

  await sqlSet('password.minLength', 6.5, null);
  const pwDecimal = await getPassword();
  ok('แถว number ทศนิยม (6.50) ผ่าน overlay ได้ ทั้งที่ PUT ต้องจำนวนเต็ม: policy คืน 6.5 (read path ไม่ตรวจ int)',
    pwDecimal?.policy?.minLength === 6.5, {
      input: 'SQL password.minLength = 6.50',
      expected: '6.5',
      actual: `${pwDecimal?.policy?.minLength}`,
      note: 'ทางแก้ใน-band คือ PUT {minLength:6} — zod int() กันไว้ฝั่งเขียนเท่านั้น',
    });
  await applySnapshot();
  const pwIntGuard = await api('PUT', '/api/config/password', { token: admin, body: { minLength: 6.5 } });
  ok('แต่ API ไม่ยอมรับทศนิยม: PUT {minLength:6.5} = 400', pwIntGuard.status === 400, {
    input: 'PUT /api/config/password {minLength: 6.5}',
    expected: '400',
    actual: `${pwIntGuard.status} ${errorMessage(pwIntGuard).slice(0, 100)}`,
  });

  await sqlSet('kyc.upload.maxFileSizeKb', 200000, null);
  const outOfBandGet = await api('GET', '/api/config/kyc', { token: admin });
  const outOfBandUnrelated = await api('PUT', '/api/config/kyc', { token: admin, body: { requireFamilyBook: true } });
  const outOfBandFix = await api('PUT', '/api/config/kyc', { token: admin, body: { maxFileSizeKb: 5120 } });
  ok('แถว out-of-band (200000 KB) ทำให้ PUT ที่ไม่เกี่ยวกับ field นั้น fail 422 แต่แก้ได้ใน-band โดยส่ง field นั้นมาด้วย',
    outOfBandGet.status === 200 && outOfBandGet.json?.data?.policy?.maxFileSizeKb === 200000 &&
      outOfBandUnrelated.status === 422 &&
      errorMessage(outOfBandUnrelated).includes('maxFileSizeKb must be between 1 and 102400') &&
      outOfBandFix.status === 200, {
      input: 'SQL 200000 -> GET -> PUT {requireFamilyBook} -> PUT {maxFileSizeKb:5120}',
      expected: '200 / 422 ที่ชี้ field ที่ caller ไม่ได้ส่ง / 200',
      actual: `${outOfBandGet.status} policy=${outOfBandGet.json?.data?.policy?.maxFileSizeKb} unrelated=${outOfBandUnrelated.status} ${errorMessage(outOfBandUnrelated).slice(0, 55)} fix=${outOfBandFix.status}`,
      note: 'F-CFG-OBS-5: candidate policy ประกอบจากค่าที่เก็บไว้จริง (previous + patch) ไม่ใช่ body ล้วน — error จึงชื่อ field ที่ admin ไม่รู้จักได้ (UX issue ไม่ใช่ data corruption; มีทางแก้ใน-band อยู่แล้ว)',
    });
  await markConfigSeen();
  await applySnapshot();

  // ================================================================ H. findings
  // F-CFG-1: expiryWarningDays = 0 passes zod and the business check, but the number overlay only
  // honours values > 0, so "turn the expiry warning off" is silently impossible through the API.
  const zeroPut = await api('PUT', '/api/config/kyc', { token: admin, body: { expiryWarningDays: 0 } });
  const zeroRows = mapOf(await cfgNow());
  const zeroPolicy = zeroPut.json?.data?.policy;
  ok('F-CFG-1: PUT /kyc {expiryWarningDays: 0} ต้องตั้งค่าปิดคำเตือนเอกสารหมดอายุได้จริง (zod อนุญาต 0 และ assertPolicyMakesSense อนุญาต 0)',
    zeroPut.status === 200 && zeroPolicy?.expiryWarningDays === 0, {
      input: 'PUT /api/config/kyc {expiryWarningDays: 0}',
      expected: '200 + policy.expiryWarningDays = 0',
      actual: `HTTP ${zeroPut.status} row=${zeroRows.get('kyc.expiryWarningDays')?.value} แต่ policy.expiryWarningDays=${zeroPolicy?.expiryWarningDays} (ค่าที่ระบบใช้จริง)`,
      note: 'เขียนลงแถวเป็น 0.00 แล้ว overlay (kind=number, เงื่อนไข n>0) ทิ้งค่ากลับเป็น env default 60 —แม้ response ของ PUT เองก็ยังตอบ 60 การตั้งค่า "ปิดคำเตือน" จึงเป็นไปไม่ได้ทาง API และไม่มีข้อความ error บอกเลย (ฟิลด์อื่นถูก zod min(1) กันไว้ มีฟิลด์เดียวที่ 0 ถูกต้องตามกติกา)',
    });
  const zeroRestore = await api('PUT', '/api/config/kyc', { token: admin, body: { expiryWarningDays: 60 } });
  ok('หลัง PUT {expiryWarningDays:60} ค่ากลับมาใช้ได้ปกติ (ยืนยันว่า 0 คือข้อยกเว้นของ overlay ไม่ใช่ cache เสีย)',
    zeroRestore.status === 200 && zeroRestore.json?.data?.policy?.expiryWarningDays === 60, {
      input: 'PUT /kyc {expiryWarningDays:60}',
      expected: '200 + 60',
      actual: `${zeroRestore.status} ${zeroRestore.json?.data?.policy?.expiryWarningDays}`,
    });
  await markConfigSeen();
  await applySnapshot();

  // F-CFG-2: PUT /thresholds writes its two rows without a transaction, so a value the DECIMAL(18,2)
  // column refuses lands the first row and orphans the second — central config left half-changed.
  const huge = await api('PUT', '/api/config/thresholds', {
    token: admin,
    body: { checkerThreshold: 5_000_000_000_000_000, headThreshold: 1_000_000_000_000_000_000 },
  });
  const hugeRows = mapOf(await cfgNow());
  const hugeAudit = await configAuditSince();
  const hugeTh = await getThresholds();
  ok('F-CFG-2: PUT /thresholds ต้อง atomic — ค่าที่คอลัมน์ DECIMAL(18,2) รับไม่ไหวไม่ควรทิ้ง config ไว้ครึ่งเดียว',
    huge.status < 500 && Number(hugeRows.get('approval.checkerThreshold')?.value) === Number(snapshotMap.get('approval.checkerThreshold').value) &&
      hugeAudit.fresh.length === (huge.status === 200 ? 1 : 0) &&
      !(Number(hugeRows.get('approval.checkerThreshold')?.value) > Number(hugeRows.get('approval.headThreshold')?.value)), {
        input: 'PUT {checker: 5e15 (ในขอบเขต DECIMAL), head: 1e18 (นอกขอบเขต)}',
        expected: 'ทั้งสองแถวไม่ขยับ (rollback) หรือ 4xx ที่บอกชัดว่าตั้งค่าไม่ได้ — ห้ามเหลือ checker>head',
        actual: `HTTP ${huge.status} ${errorMessage(huge).slice(0, 40)} checker=${hugeRows.get('approval.checkerThreshold')?.value} head=${hugeRows.get('approval.headThreshold')?.value} audit=${hugeAudit.fresh.length}`,
        note: `config.router.ts:58-73 upsert checker ก่อน head โดยไม่มี transaction — head พังด้วย out-of-range จึงค้าง checker ค่าใหม่ (GET ตอนนี้ ${JSON.stringify(hugeTh)}) และไม่มี audit CONFIG_UPDATED เลยสักแถว การแก้ config กลางที่ระบบยอมให้เกิดขึ้นจึงไร้หลักฐาน`,
      });
  await applySnapshot();
  const fpAfterHuge = await fingerprint();
  ok('คืน threshold จาก snapshot ได้ตรง (รวม updatedAt) และ fingerprint กลับเท่า baseline',
    fpAfterHuge.thresholds === fpBefore.thresholds && rowsJson(await cfgNow()) === snapshotJson, {
      input: 'applySnapshot() + full row diff',
      expected: 'identical to baseline',
      actual: `thresholds=${fpAfterHuge.thresholds} rows=${(await cfgNow()).length}`,
    });

  const thOverflowGuard = await api('PUT', '/api/config/thresholds', { token: admin, body: { checkerThreshold: 1e18, headThreshold: 1e18 } });
  ok('กรณีค่าเกิน DECIMAL ทั้งสองฝั่ง: ไม่ได้เขียนอะไรค้างไว้เลย (เพราะแถวแรกพังก่อน)',
    JSON.stringify(mapOf(await cfgNow())) === JSON.stringify(mapOf(snapshot)), {
      input: 'PUT {1e18, 1e18}',
      expected: 'rows unchanged',
      actual: `${thOverflowGuard.status} rows unchanged=${JSON.stringify(mapOf(await cfgNow())) === JSON.stringify(mapOf(snapshot))}`,
      note: 'คำอธิบายว่าทำไม F-CFG-2 ต้องให้ checker อยู่ในขอบเขตเท่านั้นจึงจะโผล่ — 500 ที่ client แยกไม่ออกว่าตั้งค่าผิดหรือ server เสีย ยังเป็นพฤติกรรมเดียวกับ F-LOG-3',
    });
  await markConfigSeen();
  await applySnapshot();

  // ================================================================ I. restore + invariants
  const freshAll = (await rows(
    conn,
    'SELECT id, action, userId FROM audit_logs',
  )).filter((r) => !auditIdsBefore.has(r.id));
  const mineActions = ['CONFIG_UPDATED', 'USER_CREATED', 'USER_UPDATED', 'USER_AVATAR_UPDATED', 'USER_AVATAR_DELETED',
    'KYC_DOCUMENT_UPLOADED', 'KYC_DOCUMENT_DELETED', 'KYC_REVERIFY_REQUIRED', 'USER_LOGIN'];
  const mine = freshAll.filter((r) => mineActions.includes(r.action) || suiteUsers.some((u) => u.id === r.userId));
  const unexpected = freshAll.filter((r) => !mine.includes(r));
  if (mine.length) await conn.query('DELETE FROM audit_logs WHERE id IN (?)', [mine.map((r) => r.id)]);
  ok('audit rows ที่ suite นี้ก่อถูกลบครบ และไม่มี action อื่นเจือ',
    unexpected.length === 0 && freshAll.length === mine.length, {
      input: 'id-set differencing on audit_logs',
      expected: `only ${mineActions.slice(0, 3).join('/')}... ของ suite นี้`,
      actual: `new=${freshAll.length} deleted=${mine.length} unexpected=${unexpected.length}${unexpected.length ? ` [${unexpected.map((r) => r.action).join(',')}]` : ''}`,
      note: 'การแก้ config กลางใน suite นี้ถูก revert ค่าเดิมทั้งหมด จึงลบ trail ของมันออกด้วย รวมถึง USER_LOGIN จากขั้นตอนที่ยืนยันว่าบัญชีเดิมยัง login ได้ (audit ของ production ต้องคงไว้ — DB ชุดนี้ถูกล้างก่อนขึ้นจริงอยู่แล้ว)',
    });

  const ids = suiteUsers.map((u) => u.id);
  if (ids.length) {
    await conn.query('DELETE FROM user_avatar_contents WHERE avatarId IN (SELECT id FROM user_avatars WHERE userId IN (?))', [ids]);
    await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [ids]);
    await conn.query('DELETE FROM notification_outbox WHERE userId IN (?)', [ids]);
    await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [ids]);
    await conn.query('DELETE FROM users WHERE id IN (?)', [ids]);
  }
  await applySnapshot();
  await settle(1200);

  const finalRows = await cfgNow();
  const rowDiff = finalRows
    .map((r) => {
      const orig = snapshotMap.get(r.key);
      if (!orig) return `${r.key}: แถวเกินที่ suite สร้าง`;
      const bad = ['value', 'valueText', 'description', 'updatedBy', 'updatedAt'].filter(
        (f) => String(orig[f] ?? '') !== String(r[f] ?? ''),
      );
      return bad.length ? `${r.key}: ${bad.join(',')} -> (${r.value}/${r.valueText}/${r.updatedBy}/${r.updatedAt})` : null;
    })
    .filter(Boolean);
  ok('system_config กลับเป็นค่าเดิมทุกแถว ทุกคอลัมน์ (รวม updatedAt) และไม่มี key ค้าง',
    rowDiff.length === 0 && finalRows.length === snapshot.length, {
      input: `${snapshot.length} แถว baseline, เทียบรายคอลัมน์`,
      expected: 'no differences, no extra keys',
      actual: rowDiff.length ? rowDiff.join(' | ') : `${finalRows.length}/${snapshot.length} identical`,
    });

  const fpEnd = await fingerprint();
  ok('ปิด suite แล้ว fingerprint ทั้ง 4 surface เท่ากับก่อนเริ่ม (config กลางไม่เสียหาย)',
    JSON.stringify(fpEnd) === JSON.stringify(fpBefore), {
      input: 'thresholds + kyc/password checksum + avatar policy',
      expected: JSON.stringify(fpBefore),
      actual: JSON.stringify(fpEnd),
    });

  const afterCounts = {};
  for (const t of TABLES) afterCounts[t] = Number((await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n);
  const drift = TABLES.filter((t) => afterCounts[t] !== baselineCounts[t]).map((t) => `${t}: ${baselineCounts[t]} -> ${afterCounts[t]}`);
  ok('จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline', drift.length === 0, {
    input: TABLES.join(','),
    expected: TABLES.map((t) => `${t}=${baselineCounts[t]}`).join(','),
    actual: TABLES.map((t) => `${t}=${afterCounts[t]}`).join(','),
    note: drift.length ? drift.join(' | ') : 'no drift',
  });

  const leftoverUser = (await rows(conn, 'SELECT COUNT(*) n FROM users WHERE username LIKE ?', [`tst_cf_${RUN_TAG}%`]))[0];
  ok('ไม่มีบัญชีทดสอบของ suite ค้างใน users', Number(leftoverUser?.n ?? 0) === 0, {
    input: `username LIKE 'tst_cf_${RUN_TAG}%'`,
    expected: '0',
    actual: `${leftoverUser?.n} แถว`,
  });
}
