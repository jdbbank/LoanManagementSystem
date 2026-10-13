// 3.11 Notification pipeline: the admin template API, enqueue -> outbox -> dispatcher, sealing at
// rest, the delivery-list contract, and the retry / requeue state machine.
//
// Everything the suite writes is its own: throwaway users, their outbox rows, their reset tokens,
// the audit rows their actions produce (found by id-set differencing, because EMAIL_TEMPLATE_UPDATED
// and NOTIFICATION_REQUEUED carry the ADMIN actor id, not a subject id), and the exact restore of the
// nine email templates. The dispatcher runs on the dev `log` transport, so no message leaves the
// machine and every row the suite creates drains to SENT on its own.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  PASSWORD,
  ROOT,
  SERVER_ENV,
  api as http,
  check,
  errorMessage,
  isSealed,
  login,
  rows,
  settle,
  statusCheck,
  unseal,
} from '../lib/harness.mjs';

const CAT = 'notifications';
const RUN_TAG = String(Date.now()).slice(-6);

/** The nine codes the backend owns (DEFAULT_TEMPLATES in email-template.service.ts). */
const CODES = [
  'LOAN_APPLICATION_SUBMITTED',
  'LOAN_APPROVED',
  'LOAN_REJECTED',
  'PAYMENT_POSTED',
  'SETTLEMENT_REQUESTED',
  'SETTLEMENT_DECIDED',
  'USER_CREATED',
  'PASSWORD_RESET_OTP',
  'PASSWORD_RESET_LINK',
];

/** Audit actions this suite is expected to produce; anything else is reported, never deleted. */
const MY_AUDIT_ACTIONS = new Set([
  'USER_CREATED',
  'EMAIL_TEMPLATE_UPDATED',
  'NOTIFICATION_REQUEUED',
  'USER_RESET_REQUESTED',
  'USER_RESET_VERIFIED',
]);

const OUTBOX_COLS =
  'id, type, status, attempts, locale, subject, recipientEmail, recipientName, bodyHtml, bodyText, payload, lastError, ' +
  'CAST(sentAt AS CHAR) AS sentAt, CAST(createdAt AS CHAR) AS createdAt, CAST(nextRetryAt AS CHAR) AS nextRetryAt, ' +
  'customerId, loanId, userId';

/**
 * The keys each emitter in notification-events.service.ts puts into the payload
 * (`recipientName` is added by enqueueNotification for every event). A template may only use
 * names from this table, otherwise the placeholder silently renders as an empty string.
 */
const PAYLOAD_CONTRACT = {
  LOAN_APPLICATION_SUBMITTED: ['loanCode', 'productName', 'amount', 'term', 'status'],
  LOAN_APPROVED: ['loanCode', 'amount', 'term', 'interestRate', 'decisionNote'],
  LOAN_REJECTED: ['loanCode', 'amount', 'term', 'interestRate', 'decisionNote'],
  PAYMENT_POSTED: ['loanCode', 'amount', 'paidDate', 'allocation', 'remaining'],
  SETTLEMENT_REQUESTED: ['loanCode', 'settlementAmount', 'totalOutstanding', 'status'],
  SETTLEMENT_DECIDED: ['loanCode', 'decision', 'settlementAmount', 'dueDate', 'decisionNote'],
  USER_CREATED: ['username', 'role', 'createdByName'],
  PASSWORD_RESET_OTP: ['otp', 'expiresMinutes'],
  PASSWORD_RESET_LINK: ['username', 'resetUrl', 'expiresMinutes'],
};

/** Mirrors renderEmail(): every {{key}} is replaced, unknown keys collapse to an empty string. */
const renderWith = (raw, payload) =>
  String(raw).replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, key) => {
    const value = payload[key];
    return value === null || value === undefined ? '' : String(value);
  });

const open = (value) => {
  try {
    return unseal(String(value));
  } catch {
    return '<<sealed with a different key>>';
  }
};
const openJson = (value) => {
  try {
    return JSON.parse(open(value));
  } catch {
    return {};
  }
};

/** Same placeholder regex the service uses, so `variables` can be re-derived independently. */
const extractKeys = (text) => [...String(text).matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((m) => m[1]);
const declaredOf = (t) => [...new Set([...extractKeys(t.subject), ...extractKeys(t.bodyHtml), ...extractKeys(t.bodyText)])].sort();

const LOG_DIRS = [`${ROOT}server/src/logs`, `${ROOT}server/dist/logs`].filter((d) => existsSync(d));
const logFiles = () => LOG_DIRS.flatMap((d) => readdirSync(d).filter((f) => f.endsWith('.log')).map((f) => `${d}/${f}`));
const logsMention = (needle) => logFiles().filter((f) => readFileSync(f, 'utf8').includes(needle));

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));
  const admin = tokens.admin;

  const ok = (name, cond, { input, expected: e = 'true', actual: a = '', note = '' } = {}) =>
    check(CAT, name, { input, expected: e, actual: typeof a === 'string' ? a : JSON.stringify(a), pass: cond, note });

  // ------------------------------------------------------------------ baselines
  const TABLES = ['users', 'notification_outbox', 'audit_logs', 'email_templates', 'password_reset_tokens', 'user_avatars'];
  const baseline = {};
  for (const t of TABLES) baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  const auditIdsBefore = new Set((await rows(conn, 'SELECT id FROM audit_logs')).map((r) => r.id));

  const templateSnapshot = await rows(
    conn,
    'SELECT id, code, locale, subject, bodyHtml, bodyText, variables, isActive, updatedBy, ' +
      "CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt FROM email_templates",
  );
  const templatesBefore = await api('GET', '/api/notifications/templates', { token: admin });
  const templatesBeforeJson = JSON.stringify(templatesBefore.json);
  const tplId = (code) => templateSnapshot.find((t) => t.code === code)?.id;

  const suiteUsers = [];
  async function makeUser(tag, { fullName, email, role = 'MAKER', username }) {
    const name = username ?? `tst_ntf_${RUN_TAG}_${tag}`;
    const res = await api('POST', '/api/users', {
      token: admin,
      body: { username: name, password: PASSWORD, fullName, email: email ?? null, role },
    });
    const user = res.json?.user;
    if (user?.id) suiteUsers.push(user);
    return { res, user, name };
  }

  const outboxFor = (userId) =>
    rows(conn, `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE userId=? ORDER BY createdAt`, [userId]);
  const outboxByIds = (ids) =>
    rows(conn, `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE id IN (?)`, [ids]);

  /** Waits for the 5s dispatcher tick to drain the given rows. */
  async function drain(ids, want, timeoutMs = 24000) {
    const deadline = Date.now() + timeoutMs;
    let current = [];
    for (;;) {
      current = await outboxByIds(ids);
      if (current.length === ids.length && current.every((r) => want.includes(r.status))) return current;
      if (Date.now() > deadline) return current;
      await settle(1200);
    }
  }

  /** The reset endpoints throttle one IP across every account, so the shared window must clear first. */
  async function awaitResetWindow(timeoutMs = 80000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const n = (await rows(conn, 'SELECT COUNT(*) n FROM password_reset_tokens WHERE createdAt > DATE_SUB(NOW(), INTERVAL 60 SECOND)'))[0].n;
      if (n === 0) return true;
      if (Date.now() > deadline) return false;
      await settle(3000);
    }
  }

  const restoreTemplate = async (t) =>
    conn.query(
      'UPDATE email_templates SET subject=?, bodyHtml=?, bodyText=?, variables=?, isActive=?, updatedBy=?, createdAt=?, updatedAt=? WHERE id=?',
      [t.subject, t.bodyHtml, t.bodyText, t.variables, t.isActive, t.updatedBy, t.createdAt, t.updatedAt, t.id],
    );

  const createdOutboxIds = [];

  try {
    // ============================================================= A. access control
    // The list/requeue guard cases need one existing row. On a freshly seeded database the outbox can
    // be empty, so the suite makes its own first row rather than assuming history.
    let anyExisting = (await rows(conn, 'SELECT id, status, attempts FROM notification_outbox ORDER BY createdAt DESC LIMIT 1'))[0];
    if (!anyExisting) {
      const probe = await makeUser('probe', { fullName: 'Test Notify Probe', email: `tst_ntf_probe_${RUN_TAG}@test.local` });
      const probeRow = (await outboxFor(probe.user.id))[0];
      createdOutboxIds.push(probeRow.id);
      anyExisting = probeRow;
    }

    statusCheck(CAT, 'ไม่ login: GET /templates ถูกปฏิเสธ 401', await api('GET', '/api/notifications/templates', { token: null }), 401, {
      input: 'GET /api/notifications/templates (anonymous)',
      messageIncludes: 'Missing bearer token',
    });
    statusCheck(CAT, 'ไม่ login: GET delivery log ถูกปฏิเสธ 401', await api('GET', '/api/notifications', { token: null }), 401, {
      input: 'GET /api/notifications (anonymous)',
      messageIncludes: 'Missing bearer token',
    });
    statusCheck(CAT, 'ไม่ login: GET /summary ถูกปฏิเสธ 401', await api('GET', '/api/notifications/summary', { token: null }), 401, {
      input: 'GET /api/notifications/summary (anonymous)',
      messageIncludes: 'Missing bearer token',
    });
    statusCheck(
      CAT,
      'ไม่ login: POST /requeue ถูกปฏิเสธ 401 (ก่อนแตะข้อมูล)',
      await api('POST', `/api/notifications/${anyExisting.id}/requeue`, { token: null }),
      401,
      { input: 'POST /api/notifications/:id/requeue (anonymous)', messageIncludes: 'Missing bearer token' },
    );

    for (const [role, token] of [
      ['MAKER', tokens.op1],
      ['CHECKER', tokens.checker1],
      ['HEAD_APPROVER', tokens.head],
      ['VIEWER', tokens.viewer],
    ]) {
      statusCheck(CAT, `${role}: GET /templates ต้อง 403 (ADMIN เท่านั้น)`, await api('GET', '/api/notifications/templates', { token }), 403, {
        input: `GET /api/notifications/templates as ${role}`,
        messageIncludes: 'Requires role: ADMIN',
      });
    }
    statusCheck(CAT, 'MAKER: GET delivery log ต้อง 403', await api('GET', '/api/notifications', { token: tokens.op1 }), 403, {
      input: 'GET /api/notifications as MAKER',
      messageIncludes: 'Requires role: ADMIN',
    });
    statusCheck(CAT, 'VIEWER: GET delivery log ต้อง 403', await api('GET', '/api/notifications', { token: tokens.viewer }), 403, {
      input: 'GET /api/notifications as VIEWER',
      messageIncludes: 'Requires role: ADMIN',
    });
    statusCheck(CAT, 'HEAD_APPROVER: GET delivery log ต้อง 403', await api('GET', '/api/notifications', { token: tokens.head }), 403, {
      input: 'GET /api/notifications as HEAD_APPROVER',
      messageIncludes: 'Requires role: ADMIN',
    });
    statusCheck(CAT, 'MAKER: PATCH template ต้อง 403', await api('PATCH', `/api/notifications/templates/${tplId('LOAN_REJECTED')}`, { token: tokens.op1, body: { subject: 'nope' } }), 403, {
      input: 'PATCH /api/notifications/templates/:id as MAKER',
      messageIncludes: 'Requires role: ADMIN',
    });

    const guardBefore = (await outboxByIds([anyExisting.id]))[0];
    const requeueAsMaker = await api('POST', `/api/notifications/${anyExisting.id}/requeue`, { token: tokens.checker1 });
    statusCheck(CAT, 'CHECKER: POST /requeue ต้อง 403', requeueAsMaker, 403, {
      input: 'POST /api/notifications/:id/requeue as CHECKER',
      messageIncludes: 'Requires role: ADMIN',
    });
    const guardAfter = (await outboxByIds([anyExisting.id]))[0];
    ok('403 ที่ role ห้าม requeue ไม่แก้แถวใน outbox เลย', guardAfter?.status === guardBefore?.status && guardAfter?.attempts === guardBefore?.attempts && guardAfter?.lastError === guardBefore?.lastError, {
      input: anyExisting.id,
      expected: `status=${guardBefore?.status} attempts=${guardBefore?.attempts} unchanged`,
      actual: `status=${guardAfter?.status} attempts=${guardAfter?.attempts} lastError=${String(guardAfter?.lastError)}`,
      note: 'requireRole ทำงานก่อน handler จึงไม่มี side effect',
    });

    for (const [role, token] of [
      ['VIEWER', tokens.viewer],
      ['MAKER', tokens.op1],
      ['HEAD_APPROVER', tokens.head],
    ]) {
      statusCheck(CAT, `${role}: GET /summary ใช้ได้ (health probe สำหรับทุกบทบาท)`, await api('GET', '/api/notifications/summary', { token }), 200, {
        input: `GET /api/notifications/summary as ${role}`,
      });
    }

    statusCheck(CAT, 'sub-path ที่ไม่มี route: 404', await api('GET', '/api/notifications/nope', { token: admin }), 404, {
      input: 'GET /api/notifications/nope',
      messageIncludes: 'Not found',
    });
    statusCheck(CAT, 'PUT /templates ไม่มี route: 404', await api('PUT', '/api/notifications/templates', { token: admin, body: {} }), 404, {
      input: 'PUT /api/notifications/templates',
      messageIncludes: 'Not found',
    });
    const delTemplate = await api('DELETE', `/api/notifications/templates/${tplId('LOAN_REJECTED')}`, { token: admin });
    statusCheck(CAT, 'template ลบผ่าน API ไม่ได้ (เก็บประวัติไว้): 404', delTemplate, 404, {
      input: 'DELETE /api/notifications/templates/:id',
      messageIncludes: 'Not found',
    });
    ok('DELETE ที่ไม่มี route ไม่ทำให้ template หายไป', !!(await rows(conn, 'SELECT id FROM email_templates WHERE id=?', [tplId('LOAN_REJECTED')])).length, {
      input: tplId('LOAN_REJECTED'),
      expected: 'row still present',
      actual: 'still present',
    });

    // ============================================================= B. template list shape
    const listed = await api('GET', '/api/notifications/templates', { token: admin });
    statusCheck(CAT, 'GET /templates ตอบ 200', listed, 200, { input: 'GET /api/notifications/templates' });
    const templates = listed.json?.data?.templates ?? [];
    const defaults = listed.json?.data?.defaults ?? [];

    ok('GET /templates คืนครบ 9 code ที่ระบบรองรับ', templates.length === 9 && new Set(templates.map((t) => t.code)).size === 9 && CODES.every((c) => templates.some((t) => t.code === c)), {
      input: 'codes',
      expected: CODES.join(','),
      actual: templates.map((t) => t.code).join(','),
    });
    ok('template ทุกแถวเป็น locale lo และเปิดใช้งาน', templates.every((t) => t.locale === 'lo' && t.isActive === true), {
      input: 'locale/isActive',
      expected: 'all lo + active',
      actual: templates.map((t) => `${t.locale}/${t.isActive}`).join(','),
      note: 'seedEmailTemplates สร้างเฉพาะ locale lo ตาม TEMPLATE_LOCALE',
    });
    const dbOrder = (await rows(conn, 'SELECT code FROM email_templates ORDER BY code')).map((r) => r.code);
    ok('ลำดับของ GET /templates ตรงกับลำดับที่ DB เรียง (ENUM order)', JSON.stringify(templates.map((t) => t.code)) === JSON.stringify(dbOrder), {
      input: 'order: api vs DB ORDER BY code',
      expected: dbOrder.join(','),
      actual: templates.map((t) => t.code).join(','),
      note: 'code เป็นคอลัมน์ ENUM ดังนั้น ORDER BY code = ลำดับที่ประกาศใน enum ไม่ใช่ alphabet — UI จึงเห็นลำดับคงที่แต่ไม่เรียงตัวอักษร',
    });

    const varMismatch = templates.filter((t) => JSON.stringify([...(t.variables ?? [])].sort()) !== JSON.stringify(declaredOf(t)));
    ok('คอลัมน์ variables ของทุก template ตรงกับ placeholder ที่อ่านได้จากเนื้อหาจริง', varMismatch.length === 0, {
      input: 'declaredVariablesOf() คำนวณซ้ำจาก subject+bodyHtml+bodyText',
      expected: 'no mismatch',
      actual: varMismatch.length ? varMismatch.map((t) => `${t.code}: stored=${JSON.stringify(t.variables)} derived=${JSON.stringify(declaredOf(t))}`).join(' | ') : '9/9 match',
    });
    ok('defaults คืน code + variables ของแบบทั้ง 9', defaults.length === 9 && defaults.every((d) => CODES.includes(d.code) && Array.isArray(d.variables)), {
      input: 'data.defaults',
      expected: '9 {code, variables}',
      actual: defaults.map((d) => d.code).join(','),
    });
    const defaultsDiff = CODES.map((code) => {
      const d = defaults.find((x) => x.code === code);
      const row = templates.find((t) => t.code === code);
      const a = [...(d?.variables ?? [])].sort().join(',');
      const b = [...(row?.variables ?? [])].sort().join(',');
      return a === b ? null : `${code}: defaults[${a}] rows[${b}]`;
    }).filter(Boolean);
    const unsupplied = CODES.map((code) => {
      const row = templates.find((t) => t.code === code);
      const supplied = new Set([...(PAYLOAD_CONTRACT[code] ?? []), 'recipientName']);
      const missing = declaredOf(row ?? {}).filter((k) => !supplied.has(k));
      return missing.length ? `${code} uses ${missing.join(',')} which no emitter supplies` : null;
    }).filter(Boolean);
    ok('template ใน DB ตรงกับ defaults ที่ code แจกจ่าย และทุก placeholder มีตัวป้อน', defaultsDiff.length === 0 && unsupplied.length === 0, {
      input: 'defaults vs stored variables, then stored placeholders vs the emitter payload contract',
      expected: 'no drift and no unsupplied variable',
      actual: [...defaultsDiff, ...unsupplied].join(' | ') || '9/9 aligned',
      note: 'F-NTF-3: แถว SETTLEMENT_REQUESTED ในฐานข้อมูลยังมี {{waiverAmount}} ทั้งใน html และ text ขณะที่ DEFAULT_TEMPLATES ปัจจุบันยกเลิกตัวแปรนี้แล้ว (grep ทั้ง server/src ไม่พบชื่อเลย) — seedEmailTemplates เป็น insert-only และ reset-db.mjs ตั้งใจเก็บ email_templates ไว้ตอนล้างฐานข้อมูล แถวจึงไม่ถูก reconcile กลับ ผลต่อผู้ใช้: asText(undefined) คืนค่าว่าง renderEmail จึงลบ placeholder ทิ้งเงียบ ๆ อีเมลขอปิดบัญชีแสดงช่อง waiver เป็นค่าว่างแทนยอดจริง และรายการตัวแปรที่ UI โชว์ก็ไม่ตรงกับที่เก็บไว้',
    });
    const settlementRow = templates.find((t) => t.code === 'SETTLEMENT_REQUESTED');
    const renderedSettlement = renderWith(settlementRow?.bodyHtml, {
      loanCode: 'LN-TST-000001',
      settlementAmount: '1,500,000.00 LAK',
      totalOutstanding: '1,600,000.00 LAK',
      status: 'awaiting approval',
      recipientName: 'Test Customer',
    });
    ok('render ตาม payload contract แล้วไม่เหลือ curly brace (ค่าที่ missing หายไปแบบเงียบ ๆ)', !/\{\{/.test(renderedSettlement) && !/waiverAmount/.test(renderedSettlement), {
      input: 'renderEmail-equivalent fill of the stored SETTLEMENT_REQUESTED body',
      expected: 'documented: unresolved placeholders collapse to an empty string, never a literal {{token}}',
      actual: `leftoverBraces=${/\{\{/.test(renderedSettlement)} stillMentionsVar=${/waiverAmount/.test(renderedSettlement)}`,
      note: 'ผู้รับจะไม่เห็นข้อความเพี้ยน แต่จะเห็นช่องข้อมูลว่างอยู่หนึ่งช่อง ซึ่งคือยอด waiver ที่ควรแสดง',
    });
    ok('id ของ template เป็น uuid ไม่ซ้ำกัน 9 ค่า', new Set(templates.map((t) => t.id)).size === 9 && templates.every((t) => /^[0-9a-f-]{36}$/.test(t.id)), {
      input: 'ids',
      expected: '9 unique uuids',
      actual: `${new Set(templates.map((t) => t.id)).size} unique`,
    });

    // ============================================================= C. template PATCH lifecycle
    const rejectedId = tplId('LOAN_REJECTED');

    const patched = await api('PATCH', `/api/notifications/templates/${rejectedId}`, {
      token: admin,
      body: { subject: 'TESTSENTINEL {{loanCode}} {{newVar}}' },
    });
    statusCheck(CAT, 'PATCH subject ของ template: 200', patched, 200, { input: 'PATCH subject + placeholder ใหม่' });
    ok('คำตอบ PATCH คืน subject ที่แก้ และ variables ถูกคำนวณรวม placeholder ใหม่', patched.json?.data?.template?.subject === 'TESTSENTINEL {{loanCode}} {{newVar}}' &&
      JSON.stringify([...(patched.json?.data?.template?.variables ?? [])].sort()) === JSON.stringify(['amount', 'decisionNote', 'loanCode', 'newVar', 'recipientName']), {
      input: 'data.template',
      expected: 'subject=TESTSENTINEL ... variables=[amount,decisionNote,loanCode,newVar,recipientName]',
      actual: `subject=${patched.json?.data?.template?.subject} variables=${JSON.stringify(patched.json?.data?.template?.variables)}`,
    });
    const patchedRow = (await rows(conn, 'SELECT subject, variables, updatedBy, isActive FROM email_templates WHERE id=?', [rejectedId]))[0];
    ok('ค่าที่ PATCH ถูกบันทึกลงฐานข้อมูลจริง (รวม updatedByเป็นผู้ดูแล)', patchedRow?.subject === 'TESTSENTINEL {{loanCode}} {{newVar}}' && patchedRow?.updatedBy !== null, {
      input: 'email_templates row',
      expected: 'subject stored + updatedBy=admin',
      actual: `subject=${patchedRow?.subject} updatedBy=${patchedRow?.updatedBy === null ? 'NULL' : 'set'}`,
    });

    const auditTpl = (await rows(conn, "SELECT id, action, userId, previousStatus, newStatus, reason FROM audit_logs WHERE action='EMAIL_TEMPLATE_UPDATED' ORDER BY createdAt DESC LIMIT 1"))[0];
    ok('PATCH template สร้าง audit EMAIL_TEMPLATE_UPDATED พร้อม old -> new', !!auditTpl && auditTpl.userId !== null &&
      String(auditTpl.reason).startsWith('Template LOAN_REJECTED/lo: "') && String(auditTpl.reason).includes('" -> "TESTSENTINEL') &&
      auditTpl.previousStatus === 'ACTIVE' && auditTpl.newStatus === 'ACTIVE', {
      input: 'audit_logs EMAIL_TEMPLATE_UPDATED',
      expected: 'reason `Template LOAN_REJECTED/lo: "old" -> "new"`, ACTIVE -> ACTIVE',
      actual: auditTpl ? `reason=${String(auditTpl.reason).slice(0, 140)} | ${auditTpl.previousStatus}->${auditTpl.newStatus}` : 'no audit row',
    });

    const safeHtml = '<p>ok <b>{{loanCode}}</b> &amp; {{amount}}</p>';
    const htmlOk = await api('PATCH', `/api/notifications/templates/${rejectedId}`, { token: admin, body: { bodyHtml: safeHtml } });
    ok('PATCH bodyHtml ที่มีเฉพาะ markup ปลอดภัย: 200 + บันทึกตรงตัว', htmlOk.status === 200 && (await rows(conn, 'SELECT bodyHtml FROM email_templates WHERE id=?', [rejectedId]))[0]?.bodyHtml === safeHtml, {
      input: safeHtml,
      expected: 'stored verbatim',
      actual: `HTTP ${htmlOk.status}`,
    });

    const xssPayloads = [
      ['<script>alert(1)</script>', 'script tag'],
      ['<iframe src="https://evil.test"></iframe>', 'iframe'],
      ['<p onclick="steal()">x</p>', 'event handler'],
      ['<a href="javascript:alert(1)">x</a>', 'javascript: url'],
    ];
    for (const [payload, label] of xssPayloads) {
      const bad = await api('PATCH', `/api/notifications/templates/${rejectedId}`, { token: admin, body: { bodyHtml: payload } });
      statusCheck(CAT, `bodyHtml แบบ ${label}: 422拒绝ไม่บันทึก`, bad, 422, {
        input: payload,
        messageIncludes: 'Email markup may not contain scripts, iframes or event handlers',
      });
      const still = (await rows(conn, 'SELECT bodyHtml FROM email_templates WHERE id=?', [rejectedId]))[0];
      ok(`payload ${label} ไม่แตะ content เดิมของ template`, still?.bodyHtml === safeHtml, {
        input: 'bodyHtml after rejected PATCH',
        expected: 'unchanged safe markup',
        actual: String(still?.bodyHtml).slice(0, 60),
      });
    }

    const guardFirst = await api('PATCH', `/api/notifications/templates/${tplId('LOAN_APPROVED')}`, { token: admin, body: { bodyHtml: '<script>x</script>' } });
    ok('ตรวจ markup ก่อน lookup: template อื่นก็ไม่ถูกแก้ (422 ไม่ใช่ 404/200)', guardFirst.status === 422, {
      input: 'PATCH another template with a script payload',
      expected: '422',
      actual: `HTTP ${guardFirst.status}: ${errorMessage(guardFirst)}`,
      note: 'assertTemplateMarkupSafe อยู่ก่อน findOne ดังนั้น payload อันตรายถูกปฏิเสธแม้ template นั้นจะอยู่ดี',
    });

    const subjectMarkup = await api('PATCH', `/api/notifications/templates/${rejectedId}`, { token: admin, body: { subject: '<script>subject</script> {reset}' } });
    const subjectStored = (await rows(conn, 'SELECT subject FROM email_templates WHERE id=?', [rejectedId]))[0]?.subject;
    ok('subject ไม่ได้ถูกตรวจ markup (ป้องกันเฉพาะ bodyHtml) — บันทึกได้ทั้ง <script>', subjectMarkup.status === 200 && subjectStored === '<script>subject</script> {reset}', {
      input: 'PATCH subject with <script> markup',
      expected: 'document current behaviour',
      actual: `HTTP ${subjectMarkup.status} stored=${subjectStored}`,
      note: 'subject ไม่ผ่าน assertTemplateMarkupSafe และไม่ถูก escape ตอน render — หัวข้อจึงมี markup ดิบลงทั้งในอีเมลและใน log',
    });

    for (const [body, label] of [
      [{ subject: '' }, 'subject ว่าง'],
      [{ bodyHtml: '' }, 'bodyHtml ว่าง'],
      [{ bodyText: '' }, 'bodyText ว่าง'],
      [{ isActive: 'yes' }, 'isActive ไม่ใช่ boolean'],
      [{ subject: 'x'.repeat(256) }, 'subject ยาว 256'],
    ]) {
      const bad = await api('PATCH', `/api/notifications/templates/${rejectedId}`, { token: admin, body });
      statusCheck(CAT, `validateBody ปฏิเสธ ${label}: 400`, bad, 400, { input: JSON.stringify(body).slice(0, 60), messageIncludes: 'Validation failed' });
    }

    const missingUuid = '00000000-dead-4000-8000-000000000cad';
    const notFoundPatch = await api('PATCH', `/api/notifications/templates/${missingUuid}`, { token: admin, body: { subject: 'ghost' } });
    statusCheck(CAT, 'PATCH template id ที่ไม่มีอยู่: 404 (ไม่ใช่ 500)', notFoundPatch, 404, {
      input: `PATCH /templates/${missingUuid}`,
      messageIncludes: 'Email template not found',
    });
    const badUuidPatch = await api('PATCH', '/api/notifications/templates/not-a-uuid', { token: admin, body: { subject: 'ghost' } });
    statusCheck(CAT, 'PATCH template id ไม่ใช่ uuid: 404', badUuidPatch, 404, {
      input: 'PATCH /templates/not-a-uuid',
      messageIncludes: 'Email template not found',
    });

    const beforeNoop = (await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action='EMAIL_TEMPLATE_UPDATED'"))[0].n;
    const noop = await api('PATCH', `/api/notifications/templates/${rejectedId}`, { token: admin, body: {} });
    const afterNoop = (await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action='EMAIL_TEMPLATE_UPDATED'"))[0].n;
    ok('PATCH {} ไม่แก้ content แต่ยังคงเขียน audit เพิ่ม 1 แถว', noop.status === 200 && afterNoop === beforeNoop + 1, {
      input: 'PATCH {} then count EMAIL_TEMPLATE_UPDATED',
      expected: '200 + one new audit row',
      actual: `HTTP ${noop.status}, audit ${beforeNoop} -> ${afterNoop}`,
      note: 'บันทึกแม้แต่ความเปลี่ยนแปลงว่างเปล่า ผู้ใช้ UI ที่กด save โดยไม่แก้อะไรจะสร้างเส้นทางตรวจนับที่ไม่สะท้อนการแก้ไขจริง',
    });

    // restore the mutated template immediately, then prove the live-render behaviour
    await restoreTemplate(templateSnapshot.find((t) => t.id === rejectedId));
    const restoredRejected = (await rows(conn, 'SELECT subject, bodyHtml, bodyText, variables, isActive, updatedBy, CAST(updatedAt AS CHAR) u FROM email_templates WHERE id=?', [rejectedId]))[0];
    const origRejected = templateSnapshot.find((t) => t.id === rejectedId);
    ok('คืนค่า template LOAN_REJECTED กลับ snapshot เดิมแบบ byte-exact', restoredRejected.subject === origRejected.subject &&
      restoredRejected.bodyHtml === origRejected.bodyHtml && restoredRejected.bodyText === origRejected.bodyText &&
      restoredRejected.variables === origRejected.variables && restoredRejected.isActive === origRejected.isActive &&
      restoredRejected.updatedBy === origRejected.updatedBy && restoredRejected.u === origRejected.updatedAt, {
      input: 'SQL restore of LOAN_REJECTED',
      expected: 'identical to the pre-suite snapshot',
      actual: `subject=${restoredRejected.subject === origRejected.subject ? 'ok' : 'DIFF'} html=${restoredRejected.bodyHtml === origRejected.bodyHtml ? 'ok' : 'DIFF'} vars=${restoredRejected.variables === origRejected.variables ? 'ok' : 'DIFF'} updatedBy=${restoredRejected.updatedBy === origRejected.updatedBy ? 'ok' : 'DIFF'} updatedAt=${restoredRejected.u === origRejected.updatedAt ? 'ok' : 'DIFF'}`,
    });

    // ============================================================= D. the template is read at enqueue time
    const userCreatedId = tplId('USER_CREATED');
    const sentinelA = await api('PATCH', `/api/notifications/templates/${userCreatedId}`, { token: admin, body: { subject: 'SENTINEL-A {{username}}' } });
    ok('PATCH subject ของ USER_CREATED สำเร็จ (ใช้เป็น sentinel)', sentinelA.status === 200, {
      input: 'SENTINEL-A {{username}}',
      expected: '200',
      actual: `HTTP ${sentinelA.status}`,
    });
    const uA = await makeUser('a', { fullName: 'Test Notify A', email: `tst_ntf_a_${RUN_TAG}@test.local` });
    const rowA = (await outboxFor(uA.user.id))[0];
    createdOutboxIds.push(rowA.id);
    ok('แถวที่ enqueue หลังแก้ template ใช้ subject แบบใหม่ (ไม่ cache)', rowA?.subject === `SENTINEL-A ${uA.name}`, {
      input: 'outbox.subject after SENTINEL-A',
      expected: `SENTINEL-A ${uA.name}`,
      actual: String(rowA?.subject),
      note: 'findActiveTemplate ถูกเรียกทุกครั้งที่ enqueue จึงเห็นฉบับแก้ไขทันที',
    });

    const sentinelB = await api('PATCH', `/api/notifications/templates/${userCreatedId}`, { token: admin, body: { subject: 'SENTINEL-B {{username}}' } });
    const uB = await makeUser('b', { fullName: 'Test Notify B', email: `tst_ntf_b_${RUN_TAG}@test.local` });
    const rowB = (await outboxFor(uB.user.id))[0];
    createdOutboxIds.push(rowB.id);
    ok('แก้ template ซ้ำครั้งที่สอง also มีผลต่อแถวถัดไปทันที', sentinelB.status === 200 && rowB?.subject === `SENTINEL-B ${uB.name}`, {
      input: 'SENTINEL-B then create another user',
      expected: `SENTINEL-B ${uB.name}`,
      actual: String(rowB?.subject),
    });

    // ============================================================= E. inactive template => no enqueue
    const off = await api('PATCH', `/api/notifications/templates/${userCreatedId}`, { token: admin, body: { isActive: false } });
    statusCheck(CAT, 'ปิดใช้งาน template USER_CREATED ผ่าน API: 200', off, 200, { input: 'PATCH isActive=false' });
    const uOff = await makeUser('off', { fullName: 'Test Notify Inactive', email: `tst_ntf_off_${RUN_TAG}@test.local` });
    ok('ปิด template แล้ว: สร้างผู้ใช้สำเร็จแต่ไม่มีแถวใน outbox (业务流程ไม่พัง)', uOff.res.status === 201 && (await outboxFor(uOff.user.id)).length === 0, {
      input: `user ${uOff.name} while the USER_CREATED template is inactive`,
      expected: 'HTTP 201 + 0 outbox rows',
      actual: `HTTP ${uOff.res.status} + ${(await outboxFor(uOff.user.id)).length} rows`,
      note: 'enqueueNotification คืน null เมื่อหา template ที่ active ไม่เจอ — caller ไม่เห็น error',
    });
    const on = await api('PATCH', `/api/notifications/templates/${userCreatedId}`, { token: admin, body: { isActive: true } });
    statusCheck(CAT, 'เปิด template กลับ: 200', on, 200, { input: 'PATCH isActive=true' });

    // ============================================================= F. escaping + sealing at rest
    const xssMarkup = '<script>alert(1)</script>';
    const xssUser = await makeUser('xss', { fullName: xssMarkup, email: `tst_ntf_xss_${RUN_TAG}@test.local` });
    const xssRow = (await outboxFor(xssUser.user.id))[0];
    createdOutboxIds.push(xssRow.id);
    const html = open(xssRow.bodyHtml);
    const text = open(xssRow.bodyText);
    // The USER_CREATED layout carries the account name in two places: the {{recipientName}} greeting
    // and the "username" table cell. Proving markup is escaped needs a cell that actually holds it.
    const rawMarkupInHtml = html.includes(xssMarkup);
    const escapedMarkupInHtml = html.includes('&lt;script&gt;alert(1)&lt;/script&gt;');
    ok('markup ที่มาจากผู้ใช้ถูก escape ใน bodyHtml (ไม่มี <script> ดิบในส่วนของ html)', !rawMarkupInHtml && escapedMarkupInHtml, {
      input: 'unseal(bodyHtml) of the USER_CREATED row',
      expected: 'only escaped entities for the user-supplied value',
      actual: `raw=${rawMarkupInHtml} escaped=${escapedMarkupInHtml}`,
      note: 'renderEmail ใช้ escapeHtml กับค่าที่แทน placeholder เท่านั้น ตัว template เองยังเป็น markup ได้',
    });
    ok('bodyText ไม่มี {{recipientName}}: fullName ของผู้ใช้ไม่ไหลเข้าส่วน plain text เลย', !text.includes(xssMarkup) && text.includes(xssUser.name), {
      input: 'unseal(bodyText) of the USER_CREATED row',
      expected: 'the username cell is present, the fullName is not referenced by this template',
      actual: `hasFullName=${text.includes(xssMarkup)} hasUsername=${text.includes(xssUser.name)}`,
      note: 'USER_CREATED เรียงรายการเฉพาะ username/role/createdByName ในส่วน text ดังนั้นค่าที่ admin ใส่ผ่าน fullName จึงไม่โผล่ใน text part',
    });
    ok('สามคอลัมน์เนื้อหาถูกซีลทั้งหมด (bodyHtml/bodyText/payload)', [xssRow.bodyHtml, xssRow.bodyText, xssRow.payload].every((v) => isSealed(v)), {
      input: 'isSealed() on the stored columns',
      expected: 'sealed:v1: x3',
      actual: [xssRow.bodyHtml, xssRow.bodyText, xssRow.payload].map((v) => (isSealed(v) ? 'sealed' : 'PLAIN')).join(','),
    });
    const payload = openJson(xssRow.payload);
    ok('payload เปิดได้และตรงข้อมูลบัญชีที่สร้าง', payload.username === xssUser.name && payload.role === 'MAKER' && typeof payload.createdByName === 'string', {
      input: 'unseal(payload)',
      expected: '{username, role, createdByName}',
      actual: JSON.stringify(payload),
    });
    ok('subject ของ USER_CREATED ใส่ username ดิบ (ไม่ escape)', String(xssRow.subject).includes(xssUser.name) && !String(xssRow.subject).includes(xssMarkup), {
      input: 'outbox.subject of the USER_CREATED row',
      expected: 'username interpolated with no escaping; fullName does not reach the subject',
      actual: String(xssRow.subject).slice(0, 90),
      note: 'subject ของ template นี้ใช้ {{username}} เท่านั้น ค่า fullName ไหลเข้า body ผ่าน {{recipientName}}',
    });

    const lfName = `tst_lf_${RUN_TAG}`;
    const forged = 'FORGED-LINE-9131';
    const lfMarkup = '<b>lf</b>';
    const uLf = await makeUser('lf', { fullName: 'Line Feed Probe', email: `tst_ntf_lf_${RUN_TAG}@test.local`, username: `${lfName}\n[ERROR  ]: ${forged} ${lfMarkup}` });
    const lfRow = uLf.res.status === 201 ? (await outboxFor(uLf.user.id))[0] : null;
    if (lfRow) createdOutboxIds.push(lfRow.id);
    ok('username ไม่มี pattern: รับค่าที่มี upline แล้วส่งต่อไปยัง subject/log', uLf.res.status === 201 && String(lfRow?.subject ?? '').includes('\n'), {
      input: `username = ${JSON.stringify(uLf.name)}`,
      expected: 'document current behaviour',
      actual: `HTTP ${uLf.res.status}, subject contains newline=${String(lfRow?.subject ?? '').includes('\n')}`,
      note: 'createUserSchema ตรวจแค่ min(3)/max(64) — ตัวอักษรควบคุมผ่านไปได้',
    });
    const forgedInLogs = lfRow ? logsMention(forged) : [];
    ok('บรรทัด log ของ transport ไม่ถูกปลอมจากข้อมูลผู้ใช้ (log forging)', lfRow === null || forgedInLogs.length === 0, {
      input: `scan log files for ${forged}`,
      expected: 'the forged marker must not appear as its own log line',
      actual: forgedInLogs.length ? `found in ${forgedInLogs.length} log file(s)` : `${logFiles().length} files scanned, clean`,
      note: 'F-NTF-2: ถ้าพบแสดงว่า subject ที่มี upline ถูกพิมพ์ลงไฟล์ log ตรง ๆ = ผู้ใช้ปลอมบรรทัด log (ระดับ ERROR) ได้ผ่านการสร้างบัญชี -- transport พิมพ์ event.subject โดยไม่ sanitize',
    });
    ok('markup ใน username: subject เก็บดิบ แต่ bodyHtml ถูก escape', String(lfRow?.subject ?? '').includes(lfMarkup) && open(lfRow?.bodyHtml ?? '').includes('&lt;b&gt;lf&lt;/b&gt;'), {
      input: 'the same row, subject vs bodyHtml',
      expected: 'documented split: raw in the subject, escaped in the html body',
      actual: `subjectRaw=${String(lfRow?.subject ?? '').includes(lfMarkup)} htmlEscaped=${open(lfRow?.bodyHtml ?? '').includes('&lt;b&gt;lf&lt;/b&gt;')}`,
      note: 'ยืนยันว่า escape เกิดเฉพาะ path ของ html ไม่ใช่ subject/text',
    });
    ok('bodyText (plain text) ไม่ถูก escape: markup จาก username คงอยู่แบบดิบ', open(lfRow?.bodyText ?? '').includes(lfMarkup), {
      input: 'unseal(bodyText) of the row whose username carried <b>lf</b>',
      expected: 'documented: renderEmail escapes only the html part',
      actual: open(lfRow?.bodyText ?? '').includes(lfMarkup) ? 'raw markup kept' : 'escaped',
      note: 'text part ส่ง {{username}} แบบไม่ escape — ถ้า mail client แปลง text เป็น html จะ runnable เก็บเป็นข้อสังเกต defence-in-depth',
    });

    const uNoMail = await makeUser('nomail', { fullName: 'Test Notify No Email', email: null });
    ok('ผู้ใช้ไม่มี email: สร้างสำเร็จ แต่ไม่มีแถว outbox (ข้ามการส่ง)', uNoMail.res.status === 201 && (await outboxFor(uNoMail.user.id)).length === 0, {
      input: `user ${uNoMail.name} with email=null`,
      expected: 'HTTP 201 + 0 outbox rows',
      actual: `HTTP ${uNoMail.res.status} + ${(await outboxFor(uNoMail.user.id)).length} rows`,
      note: 'enqueueNotification คืน null พร้อม log ว่า recipient has no email address',
    });

    // ============================================================= G. delivery-log list contract
    // Drain everything the suite has enqueued so far: the dispatcher flips rows PENDING -> SENT on a
    // 5s timer, and a status-count assertion that races that timer would be flaky, not wrong.
    const preDrain = await drain(createdOutboxIds, ['SENT']);
    ok('แถวที่ enqueue ก่อนหน้าถูก dispatcher ส่งออกครบก่อนตรวจ contract ของ list', preDrain.length === createdOutboxIds.length && preDrain.every((r) => r.status === 'SENT'), {
      input: `${createdOutboxIds.length} rows before the list checks`,
      expected: 'all SENT',
      actual: preDrain.map((r) => `${r.type}:${r.status}`).join(','),
    });

    const totalInDb = (await rows(conn, 'SELECT COUNT(*) n FROM notification_outbox'))[0].n;
    const list = await api('GET', '/api/notifications', { token: admin });
    statusCheck(CAT, 'GET /api/notifications: 200', list, 200, { input: 'GET /api/notifications' });
    ok('total อยู่ระดับ top-level และ equals จำนวนแถวทั้งตาราง', typeof list.json?.total === 'number' && list.json.total === totalInDb, {
      input: 'GET /api/notifications -> total',
      expected: `total == COUNT(notification_outbox) = ${totalInDb}`,
      actual: `total=${list.json?.total} items=${list.json?.data?.notifications?.length}`,
      note: 'ค่า default limit=50 จึงแสดง items ไม่ถึง total',
    });
    const items = list.json?.data?.notifications ?? [];
    ok('หน้า default คืน 50 แถวล่าสุด (limit default)', items.length === Math.min(50, totalInDb), {
      input: 'no limit param',
      expected: `${Math.min(50, totalInDb)} rows`,
      actual: `${items.length} rows`,
    });
    ok('รายการใน delivery log ไม่แนบเนื้อหาอีเมล (bodyHtml/bodyText/payload หายไปจริง)', items.length > 0 && items.every((n) => n.bodyHtml === undefined && n.bodyText === undefined && n.payload === undefined), {
      input: 'keys of one item',
      expected: 'delivery facts only',
      actual: Object.keys(items[0] ?? {}).join(','),
    });
    const desc = items.every((n, i) => i === 0 || String(items[i - 1].createdAt) >= String(n.createdAt));
    ok('เรียง createdAt DESC', desc, {
      input: 'createdAt sequence',
      expected: 'non-increasing',
      actual: `${String(items[0]?.createdAt)} .. ${String(items[items.length - 1]?.createdAt)}`,
    });

    for (const [q, label] of [
      ['limit=0', 'limit=0'],
      ['limit=201', 'limit=201'],
      ['limit=abc', 'limit=abc'],
      ['limit=1.5', 'limit=1.5'],
      ['offset=-1', 'offset=-1'],
      ['status=BOGUS', 'status ไม่อยู่ใน enum'],
    ]) {
      const bad = await api('GET', `/api/notifications?${q}`, { token: admin });
      statusCheck(CAT, `list query ${label}: 400`, bad, 400, { input: `GET /api/notifications?${q}`, messageIncludes: 'Validation failed' });
    }

    const page1 = await api('GET', '/api/notifications?limit=5&offset=0', { token: admin });
    const page2 = await api('GET', '/api/notifications?limit=5&offset=5', { token: admin });
    const p1 = (page1.json?.data?.notifications ?? []).map((n) => n.id);
    const p2 = (page2.json?.data?.notifications ?? []).map((n) => n.id);
    ok('Pagination ด้วย limit/offset: สองหน้าไม่ซ้อนกัน', p1.length === 5 && p2.length === 5 && p1.every((id) => !p2.includes(id)), {
      input: 'limit=5 offset=0 / offset=5',
      expected: '5 + 5 disjoint ids',
      actual: `p1=${p1.length} p2=${p2.length} overlap=${p1.filter((id) => p2.includes(id)).length}`,
    });
    const maxPage = await api('GET', '/api/notifications?limit=200', { token: admin });
    ok('limit=200 (ค่าสูงสุดที่ schema รับ) ใช้ได้', maxPage.status === 200 && (maxPage.json?.data?.notifications ?? []).length === Math.min(200, totalInDb), {
      input: 'limit=200',
      expected: `min(200, ${totalInDb}) rows`,
      actual: `${(maxPage.json?.data?.notifications ?? []).length} rows`,
    });
    const far = await api('GET', '/api/notifications?offset=100000', { token: admin });
    ok('offset เลยจำนวนแถว: 200 + รายการว่าง แต่ total คงเดิม', far.status === 200 && (far.json?.data?.notifications ?? []).length === 0 && far.json?.total === totalInDb, {
      input: 'offset=100000',
      expected: '200, [], total unchanged',
      actual: `HTTP ${far.status}, items=${(far.json?.data?.notifications ?? []).length}, total=${far.json?.total}`,
    });

    const sentCountDb = (await rows(conn, "SELECT COUNT(*) n FROM notification_outbox WHERE status='SENT'"))[0].n;
    const sentOnly = await api('GET', '/api/notifications?status=SENT&limit=200', { token: admin });
    const sentItems = sentOnly.json?.data?.notifications ?? [];
    ok('filter status=SENT: ทุกแถวบ status ตรงกัน และ total คือจำนวนที่ filter แล้ว', sentItems.length > 0 && sentItems.every((n) => n.status === 'SENT') && sentOnly.json.total === sentCountDb, {
      input: 'status=SENT',
      expected: `only SENT rows, total=${sentCountDb}`,
      actual: `items=${sentItems.length} allSent=${sentItems.every((n) => n.status === 'SENT')} total=${sentOnly.json?.total}`,
      note: 'total มาจาก getManyAndCount ที่ใช้ where เดียวกัน จึงเป็นจำนวนหลัง filter (ไม่ contradictory กับกรณีไม่ filter)',
    });

    // ============================================================= H. /summary vs the table
    const summaryRes = await api('GET', '/api/notifications/summary', { token: admin });
    statusCheck(CAT, 'GET /summary: 200', summaryRes, 200, { input: 'GET /api/notifications/summary' });
    const counts = summaryRes.json?.data?.counts ?? {};
    const byStatus = Object.fromEntries((await rows(conn, 'SELECT status, COUNT(*) n FROM notification_outbox GROUP BY status')).map((r) => [r.status, r.n]));
    ok('counts ของ /summary ตรงกับ GROUP BY status ในฐานข้อมูล', ['pending', 'sent', 'failed', 'dead'].every((k) => counts[k] === (byStatus[k.toUpperCase()] ?? 0)), {
      input: 'summary vs DB',
      expected: JSON.stringify({ pending: byStatus.PENDING ?? 0, sent: byStatus.SENT ?? 0, failed: byStatus.FAILED ?? 0, dead: byStatus.DEAD ?? 0 }),
      actual: JSON.stringify(counts),
    });
    ok('ทั้งสี่สถานะรวมแล้วเท่ากับจำนวนแถวจริง', Object.values(counts).reduce((a, b) => a + Number(b), 0) === totalInDb, {
      input: 'sum(counts) vs COUNT(*)',
      expected: String(totalInDb),
      actual: String(Object.values(counts).reduce((a, b) => a + Number(b), 0)),
      note: 'การอ่านสองครั้งนี้อาจต่างกันถ้า dispatcher ทำงานระหว่างกลาง จึง repeatable ด้วย retry ข้างล่าง',
    });
    const viewerSummary = await api('GET', '/api/notifications/summary', { token: tokens.viewer });
    ok('VIEWER เห็นตัวเลขเดียวกับ ADMIN (health probe เท่านั้น ไม่เปิดเผยเนื้อหา)', JSON.stringify(viewerSummary.json?.data?.counts) === JSON.stringify(counts), {
      input: 'GET /summary as VIEWER',
      expected: 'same counts as admin',
      actual: JSON.stringify(viewerSummary.json?.data?.counts),
      note: 'ถ้าตัวเลขต่างกันคือ dispatcher แทรกในระหว่างสอง request ไม่ใช่ สิทธิ์',
    });

    // ============================================================= I. dispatcher on the log transport
    const transport = SERVER_ENV.NOTIFY_TRANSPORT ?? 'log';
    ok('transport ที่เซิร์ฟเวอร์ใช้คือ log (ไม่แตะ SMTP/Kafka/mailer จริง)', transport === 'log', {
      input: 'server/.env NOTIFY_TRANSPORT',
      expected: 'log',
      actual: String(transport),
      note: 'NOTIFY_ENABLED=true + transport=log = pipeline ทำงานครบแต่ไม่มีอะไรออกนอกเครื่อง',
    });

    const drained = await drain(createdOutboxIds, ['SENT']);
    ok('แถวที่ suite สร้างถูก dispatcher ส่งออกครบ (PENDING -> SENT)', drained.length === createdOutboxIds.length && drained.every((r) => r.status === 'SENT'), {
      input: `${createdOutboxIds.length} suite rows`,
      expected: 'all SENT',
      actual: drained.map((r) => `${r.type}:${r.status}`).join(','),
    });
    ok('แถว SENT: sentAt ถูกset lastErrorว่าง และ attempts ยัง 0 (markSent ไม่นับ attempt)', drained.every((r) => r.sentAt !== null && r.lastError === null && r.attempts === 0), {
      input: 'sentAt/lastError/attempts of SENT rows',
      expected: 'sentAt set, lastError NULL, attempts 0',
      actual: drained.map((r) => `${r.status}/${r.attempts}/${r.sentAt ? 'sentAt' : 'NO sentAt'}`).join(','),
      note: 'attempts นับเฉพาะความล้มเหลว การส่งสำเร็จไม่เพิ่มตัวเลข',
    });
    ok('ไม่มีแถวใดของ suite มี lastError อ้างถึง SMTP/Kafka/mailer', drained.every((r) => !/smtp|kafka|ECONNREFUSED|mailer/i.test(String(r.lastError ?? ''))), {
      input: 'lastError scan',
      expected: 'no external transport error',
      actual: drained.map((r) => String(r.lastError ?? 'null')).join(','),
    });
    const logEvidence = logsMention(`[notify:log] USER_CREATED -> ${uA.user.email}`);
    ok('ไฟล์ log มีบรรทัด [notify:log] ของแถวที่ suite สร้าง (หลักฐานว่าใช้ transport ในเครื่อง)', logEvidence.length > 0, {
      input: `scan for the notify:log line of ${uA.user.email}`,
      expected: 'at least one matching line',
      actual: logEvidence.length ? `found in ${logEvidence.length} file(s)` : `${logFiles().length} files scanned, not found`,
    });

    // a real OTP + reset link through the reset endpoints, then the sealing/redaction proof
    const windowClear = await awaitResetWindow();
    const uOtp = await makeUser('otp', { fullName: 'Test Notify Otp', email: `tst_ntf_otp_${RUN_TAG}@test.local` });
    const otpAck = await api('POST', '/api/auth/forgot-password', { token: null, body: { email: uOtp.user.email } });
    statusCheck(CAT, 'forgot-password ของบัญชี suite: 202', otpAck, 202, { input: uOtp.user.email });
    ok('รอ cooldown/IP throttle ว่างก่อนเรียก reset', windowClear, {
      input: 'recent password_reset_tokens count',
      expected: 'window clear',
      actual: windowClear ? 'clear' : 'shared 60s window still busy — the OTP case may have been throttled',
      note: 'suite นี้เป็น suite เดียวที่เรียก reset endpoints หลัง suite 02 จึงรอ windows ให้ตรงก่อน',
    });
    const otpRows = await outboxFor(uOtp.user.id);
    const otpRow = otpRows.find((r) => r.type === 'PASSWORD_RESET_OTP');
    if (otpRow) createdOutboxIds.push(otpRow.id);
    ok('PASSWORD_RESET_OTP ถูก enqueue พร้อม body แบบซีล', !!otpRow && isSealed(otpRow.bodyHtml) && isSealed(otpRow.bodyText) && isSealed(otpRow.payload), {
      input: 'outbox row type PASSWORD_RESET_OTP',
      expected: 'row present + 3 sealed columns',
      actual: otpRow ? `${[otpRow.bodyHtml, otpRow.bodyText, otpRow.payload].map((v) => (isSealed(v) ? 'sealed' : 'PLAIN')).join(',')}` : 'no OTP row',
    });
    const otpValue = String(openJson(otpRow?.payload)?.otp ?? '');
    const otpText = open(otpRow?.bodyText);
    ok('เปิด body แล้วได้ OTP ที่ใช้จริงได้ (message ไม่เสียหายจากการซีล)', /^\d{6}$/.test(otpValue) && String(otpText).includes(otpValue), {
      input: 'unseal(payload).otp + unseal(bodyText)',
      expected: '6-digit code present in the opened body',
      actual: `otp=${/^\d{6}$/.test(otpValue) ? 'ok' : 'bad shape'} inBody=${String(otpText).includes(otpValue)}`,
    });
    const otpInSubject = String(otpRow?.subject ?? '').includes(otpValue) && otpValue !== '';
    const otpLeakInLogs = otpValue ? logsMention(otpValue) : [];
    ok('OTP ไม่ปรากฏเป็น plaintext ที่เก็บในตารางเลย (รวม subject)', !otpInSubject, {
      input: 'notification_outbox columns vs the live OTP',
      expected: 'no column stores the code in plain text',
      actual: otpInSubject ? `subject stores it in the clear: "${otpRow.subject}"` : 'subject clean',
      note: 'F-NTF-1: enqueueNotification ซีลเฉพาะ bodyHtml/bodyText/payload ส่วน subject ถูกเก็บ raw และ template PASSWORD_RESET_OTP ใส่ {{otp}} ไว้ใน subject จึงอ่าน OTP กลับได้จากคอลัมน์เดียว — ขัดกับ comment ที่ว่า the message never reaches the table in plain text (suite 02 ตรวจแค่ 3 คอลัมน์ที่ซีล)',
    });
    ok('OTP ไม่หลุดไปอยู่ในไฟล์ log (transport redact content ของ event ที่มี secret)', otpLeakInLogs.length === 0, {
      input: `scan every log file for ${/^\d{6}$/.test(otpValue) ? 'the 6-digit code' : 'n/a'}`,
      expected: 'no log file contains the code',
      actual: otpLeakInLogs.length ? `found in ${otpLeakInLogs.join(',')}` : `${logFiles().length} files scanned, clean`,
      note: 'SECRET_EVENT_TYPES ใน notification-dispatcher.service.ts ทำให้บรรทัด log เขียนว่า <redacted N + M chars>',
    });
    ok('บรรทัด log ของ PASSWORD_RESET_OTP ใช้รูปแบบ <redacted ...>', logsMention('<redacted ').length > 0, {
      input: 'scan for the redaction marker',
      expected: 'the redacted branch ran',
      actual: logsMention('<redacted ').length ? 'redaction marker present' : 'no redacted line found',
    });

    const verifyRes = await api('POST', '/api/auth/verify-otp', { token: null, body: { email: uOtp.user.email, otp: otpValue } });
    statusCheck(CAT, 'verify-otp ด้วยโค้ดจาก outbox: 200 + ได้ link', verifyRes, 200, { input: 'POST /api/auth/verify-otp' });
    const linkRow = (await outboxFor(uOtp.user.id)).find((r) => r.type === 'PASSWORD_RESET_LINK');
    if (linkRow) createdOutboxIds.push(linkRow.id);
    const linkToken = String(/reset-password\?token=([^&"' ]+)/.exec(open(linkRow?.bodyText))?.[1] ?? '');
    ok('PASSWORD_RESET_LINK เก็บลิงก์แบบซีลเท่านั้น', !!linkRow && isSealed(linkRow.bodyHtml) && isSealed(linkRow.bodyText) && isSealed(linkRow.payload), {
      input: 'outbox row PASSWORD_RESET_LINK',
      expected: 'sealed columns',
      actual: linkRow ? `${[linkRow.bodyHtml, linkRow.bodyText, linkRow.payload].map((v) => (isSealed(v) ? 'sealed' : 'PLAIN')).join(',')}` : 'no link row',
    });
    ok('link reset อยู่ใน body ที่เปิดแล้ว และ subject ไม่มี token', linkToken.length > 10 && !String(linkRow?.subject ?? '').includes(linkToken), {
      input: 'unseal(bodyText) + subject',
      expected: 'token reachable in the body only',
      actual: `tokenLen=${linkToken.length} subjectHasToken=${String(linkRow?.subject ?? '').includes(linkToken)}`,
      note: 'subject ของ PASSWORD_RESET_LINK ใช้ {{username}} จึงไม่ leak ต่างจาก OTP',
    });
    const secretDrained = await drain([otpRow?.id, linkRow?.id].filter(Boolean), ['SENT']);
    ok('แถวความลับของ suite ออกด้วย log transport จน SENT (ไม่มี SMTP/Kafka เข้ามาเกี่ยว)', secretDrained.length >= 1 && secretDrained.every((r) => r.status === 'SENT' && r.lastError === null && r.attempts === 0), {
      input: 'OTP + LINK rows after the poller runs',
      expected: 'SENT, no error, attempts 0',
      actual: secretDrained.map((r) => `${r.type}:${r.status}/${r.attempts}/${String(r.lastError)}`).join(','),
      note: 'transport=log ทำให้ pipeline ครบวงจรแต่ message ไม่ออกนอกเครื่อง -- เกณฑ์ maxAttempts -> DEAD จึง reach ไม่ได้ที่นี่',
    });

    // ============================================================= J. retry / requeue state machine
    const rowSentRequeue = rowB;
    const rejectedRequeue = await api('POST', `/api/notifications/${rowSentRequeue.id}/requeue`, { token: admin });
    statusCheck(CAT, 'requeue แถวที่ SENT แล้ว: 404 (ส่งไปแล้วห้ามส่งซ้ำ)', rejectedRequeue, 404, {
      input: `POST /api/notifications/${rowSentRequeue.id}/requeue`,
      messageIncludes: 'Notification not found or already sent',
    });
    const stillSent = (await outboxByIds([rowSentRequeue.id]))[0];
    ok('requeue ที่ถูกปฏิเสธไม่แก้สถานะ', stillSent?.status === 'SENT', {
      input: rowSentRequeue.id,
      expected: 'SENT unchanged',
      actual: String(stillSent?.status),
    });

    // FAILED with an elapsed backoff is claimable again
    await conn.query("UPDATE notification_outbox SET status='FAILED', attempts=4, nextRetryAt=DATE_SUB(NOW(), INTERVAL 60 SECOND), lastError='suite: injected failure' WHERE id=?", [rowA.id]);
    const retried = (await drain([rowA.id], ['SENT'], 24000))[0];
    ok('FAILED + nextRetryAt เลยเวลา: dispatcher เก็บมาส่งใหม่จน SENT', retried?.status === 'SENT', {
      input: 'status=FAILED, attempts=4, nextRetryAt=now-60s',
      expected: 'SENT within the poll window',
      actual: String(retried?.status),
      note: 'claimableRows รวม FAILED ที่มี nextRetryAt <= now และ FAILED ที่ nextRetryAt IS NULL',
    });
    ok('ส่งสำเร็จแล้ว: lastError ถูกclear แต่ attempts/ nextRetryAt เดิมยังอยู่ (markSent ไม่รีเซ็ต)', retried?.lastError === null && retried?.attempts === 4 && retried?.nextRetryAt !== null, {
      input: 'row after the successful retry',
      expected: 'lastError NULL, attempts stays 4, stale nextRetryAt kept',
      actual: `lastError=${retried?.lastError} attempts=${retried?.attempts} nextRetryAt=${retried?.nextRetryAt}`,
      note: 'attempts นับความล้มเหลวเท่านั้น แต่ nextRetryAt ที่ค้างทำให้ delivery log แสดงค่าที่ไร้ความหมายสำหรับแถว SENT',
    });

    // FAILED with a future backoff must not be picked up
    await conn.query("UPDATE notification_outbox SET status='FAILED', attempts=1, nextRetryAt=DATE_ADD(NOW(), INTERVAL 1 HOUR), lastError='suite: waiting for backoff' WHERE id=?", [rowB.id]);
    await settle(8000);
    const parked = (await outboxByIds([rowB.id]))[0];
    ok('FAILED + nextRetryAt ยังไม่ถึงเวลา: dispatcher ข้าม (backoff เคารพเวลา)', parked?.status === 'FAILED' && String(parked?.lastError).includes('waiting for backoff'), {
      input: 'status=FAILED, nextRetryAt=now+1h, then wait 8s',
      expected: 'still FAILED with the injected lastError',
      actual: `status=${parked?.status} lastError=${String(parked?.lastError).slice(0, 40)}`,
    });

    // DEAD -> requeue -> PENDING -> SENT, with the audit row
    await conn.query("UPDATE notification_outbox SET status='DEAD', attempts=5, nextRetryAt=NULL, lastError='suite: parked dead after maxAttempts' WHERE id=?", [rowB.id]);
    const deadList = await api('GET', '/api/notifications?status=DEAD&limit=200', { token: admin });
    ok('DEAD ปรากฏใน delivery log ตาม filter', (deadList.json?.data?.notifications ?? []).some((n) => n.id === rowB.id) && deadList.json.total >= 1, {
      input: 'GET /api/notifications?status=DEAD',
      expected: 'the parked row is listed',
      actual: `items=${(deadList.json?.data?.notifications ?? []).length} total=${deadList.json?.total}`,
    });
    const requeueAuditBefore = new Set((await rows(conn, "SELECT id FROM audit_logs WHERE action='NOTIFICATION_REQUEUED'")).map((r) => r.id));
    const requeued = await api('POST', `/api/notifications/${rowB.id}/requeue`, { token: admin });
    statusCheck(CAT, 'requeue แถว DEAD: 200', requeued, 200, { input: rowB.id });
    const requeuedRow = (await outboxByIds([rowB.id]))[0];
    ok('หลัง requeue: attempts=0 + lastError/nextRetryAtถูกล้าง (สถานะกลับเป็น PENDING/ronda ส่ง)', ['PENDING', 'SENT'].includes(requeuedRow?.status) && requeuedRow?.attempts === 0 && requeuedRow?.lastError === null && requeuedRow?.nextRetryAt === null, {
      input: 'the requeued row',
      expected: 'attempts 0, lastError NULL, nextRetryAt NULL, status PENDING (or SENT if the poller already ran)',
      actual: `status=${requeuedRow?.status} attempts=${requeuedRow?.attempts} lastError=${String(requeuedRow?.lastError)} nextRetryAt=${String(requeuedRow?.nextRetryAt)}`,
      note: 'ตัวตอบกลับ API ยืนยัน status=PENDING ในเคสถัดไป จึงไม่ races กับ timer 5 วินาทีของ dispatcher',
    });
    ok('คำตอบ requeue คืน id + สถานะใหม่', requeued.json?.data?.id === rowB.id && requeued.json?.data?.status === 'PENDING', {
      input: 'response body',
      expected: `{id, status: PENDING}`,
      actual: JSON.stringify(requeued.json?.data),
    });
    await settle(600);
    const auditRequeues = (await rows(conn, "SELECT id, userId, newStatus, reason FROM audit_logs WHERE action='NOTIFICATION_REQUEUED'")).filter((r) => !requeueAuditBefore.has(r.id));
    ok('requeue สร้าง audit NOTIFICATION_REQUEUED 1 แถว (PENDING + เหตุผลระบุ type และ recipient ของแถวนั้น)',
      auditRequeues.length === 1 && auditRequeues[0].newStatus === 'PENDING' &&
        auditRequeues[0].reason === `Re-queued ${rowB.type} to ${rowB.recipientEmail}` &&
        auditRequeues[0].userId !== null, {
        input: `audit_logs ใหม่หลัง requeue ${rowB.id}`,
        expected: `1 row, reason "Re-queued ${rowB.type} to ${rowB.recipientEmail}", newStatus PENDING`,
        actual: auditRequeues.length ? auditRequeues.map((r) => `newStatus=${r.newStatus} reason=${String(r.reason).slice(0, 90)}`).join(' | ') : 'no audit row',
        note: `แถวที่ requeue คือ ${rowB.type} ของ ${rowB.recipientEmail} — ตรวจด้วย id-set เพราะ createdAt มี precision ระดับวินาที จึงลำดับไม่ reliably`,
      });
    const afterRequeueDrain = (await drain([rowB.id], ['SENT'], 24000))[0];
    ok('แถวที่ requeue ถูก dispatcher ส่งออกไปจริงรอบสอง (SENT + sentAt ถูกset ใหม่)', afterRequeueDrain?.status === 'SENT' && afterRequeueDrain?.sentAt !== null, {
      input: 'poll after requeue',
      expected: 'SENT again with a sentAt',
      actual: `status=${afterRequeueDrain?.status} sentAt=${afterRequeueDrain?.sentAt} (previous ${parked?.sentAt})`,
      note: 'ไม่มี SMTP/Kafka จริง ดังนั้นหลักฐานคือการที่แถวกลับเป็น SENT ด้วย transport ในเครื่อง',
    });

    // PENDING is re-queueable too (the guard only blocks SENT)
    await conn.query("UPDATE notification_outbox SET status='PENDING', attempts=0, sentAt=NULL, lastError=NULL, nextRetryAt=NULL WHERE id=?", [xssRow.id]);
    const pendingRequeue = await api('POST', `/api/notifications/${xssRow.id}/requeue`, { token: admin });
    ok('requeue แถวที่ PENDING อยู่แล้ว: รับได้ 200 (กันเฉพาะ SENT)', pendingRequeue.status === 200 && (await outboxByIds([xssRow.id]))[0]?.status === 'PENDING', {
      input: 'POST requeue on a PENDING row',
      expected: '200 + stays PENDING',
      actual: `HTTP ${pendingRequeue.status} status=${(await outboxByIds([xssRow.id]))[0]?.status}`,
      note: 'requeueNotification คืน null เฉพาะแถวที่ไม่มีหรือ SENT แล้ว — การกดซ้ำจึง reset attempts/nextRetryAt ของแถวรอนส่งด้วย',
    });
    await drain([xssRow.id], ['SENT'], 24000);

    const ghostRequeue = await api('POST', `/api/notifications/${missingUuid}/requeue`, { token: admin });
    statusCheck(CAT, 'requeue id ที่ไม่มีอยู่: 404', ghostRequeue, 404, {
      input: `POST /api/notifications/${missingUuid}/requeue`,
      messageIncludes: 'Notification not found or already sent',
    });
    const junkRequeue = await api('POST', '/api/notifications/not-a-uuid/requeue', { token: admin });
    statusCheck(CAT, 'requeue id ไม่ใช่ uuid: 404 ไม่ใช่ 500', junkRequeue, 404, {
      input: 'POST /api/notifications/not-a-uuid/requeue',
      messageIncludes: 'Notification not found or already sent',
    });
    const maxAttemptsCfg = SERVER_ENV.NOTIFY_MAX_ATTEMPTS ?? '5 (default)';
    ok('DEAD จาก maxAttempts ตรวจได้เพียง config (transport=log ทำให้ส่งไม่พัง)', true, {
      input: 'NOTIFY_MAX_ATTEMPTS / NOTIFY_BACKOFF_SECONDS',
      expected: 'documented coverage gap',
      actual: `maxAttempts=${maxAttemptsCfg}, backoff=${SERVER_ENV.NOTIFY_BACKOFF_SECONDS ?? '30 (default)'}s x attempts`,
      note: 'เส้นทาง markFailed -> DEAD ต้องมี transport ที่ล้มเหลวจริงจึงจะ reach ได้ — suite นี้ inject สถานะผ่าน SQL แทน จึงสรุปว่า retry/backoff/requeue ถูกต้อง แต่ยังไม่เคยพิสูจน์ threshold 5 ครั้งแบบ end-to-end',
    });

    // ============================================================= K. restore + cleanup
    // every template the suite touched returns to its exact pre-suite bytes
    for (const t of templateSnapshot) await restoreTemplate(t);
    await settle(400);
    const templatesAfterJson = JSON.stringify((await api('GET', '/api/notifications/templates', { token: admin })).json);
    ok('GET /templates กลับเป็น snapshot เดิมแบบ byte-for-byte', templatesBeforeJson === templatesAfterJson, {
      input: 'stringify(data) before vs after the suite',
      expected: 'identical',
      actual: templatesBeforeJson === templatesAfterJson ? 'identical' : `diff: first change at index ${templatesBeforeJson.split('').findIndex((c, i) => templatesAfterJson[i] !== c)}`,
    });
    const dbTemplateDiff = (await rows(
      conn,
      'SELECT id, subject, bodyHtml, bodyText, variables, isActive, updatedBy, CAST(createdAt AS CHAR) createdAt, CAST(updatedAt AS CHAR) updatedAt FROM email_templates',
    ))
      .map((row) => {
        const orig = templateSnapshot.find((t) => t.id === row.id);
        if (!orig) return `${row.id}: unexpected new template row`;
        const fields = ['subject', 'bodyHtml', 'bodyText', 'variables', 'isActive', 'updatedBy', 'createdAt', 'updatedAt'];
        const bad = fields.filter((f) => String(row[f]) !== String(orig[f]));
        return bad.length ? `${row.code}: ${bad.join(',')}` : null;
      })
      .filter(Boolean);
    ok('ฐานข้อมูล: template ทั้ง 9 คืนค่าครบทุกคอลัมน์ (รวม updatedBy/updatedAt)', dbTemplateDiff.length === 0, {
      input: 'row-by-row column diff vs the snapshot',
      expected: 'no differences',
      actual: dbTemplateDiff.length ? dbTemplateDiff.join(' | ') : '9/9 identical',
    });

    // the reset tokens and outbox rows the suite produced
    const suiteUserIds = suiteUsers.map((u) => u.id);
    const suiteOutboxIds = (await rows(conn, 'SELECT id FROM notification_outbox WHERE userId IN (?)', [suiteUserIds])).map((r) => r.id);
    await conn.query('DELETE FROM notification_outbox WHERE userId IN (?)', [suiteUserIds]);
    await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [suiteUserIds]);
    await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [suiteUserIds]);
    await conn.query('DELETE FROM users WHERE id IN (?)', [suiteUserIds]);

    const newAudit = await rows(conn, 'SELECT id, action, userId, reason FROM audit_logs');
    const fresh = newAudit.filter((r) => !auditIdsBefore.has(r.id));
    const mine = fresh.filter((r) => MY_AUDIT_ACTIONS.has(r.action) || suiteUserIds.includes(r.userId));
    const unexpected = fresh.filter((r) => !MY_AUDIT_ACTIONS.has(r.action) && !suiteUserIds.includes(r.userId));
    if (mine.length) await conn.query('DELETE FROM audit_logs WHERE id IN (?)', [mine.map((r) => r.id)]);
    ok('audit rows ใหม่ของ suite ถูกลบครบตามที่ระบุ id ไว้', unexpected.length === 0 && fresh.length === mine.length, {
      input: 'id-set differencing on audit_logs',
      expected: `only ${[...MY_AUDIT_ACTIONS].join(',')} rows for the suite's own activity`,
      actual: `new=${fresh.length} deleted=${mine.length} unexpected=${unexpected.length}${unexpected.length ? ` [${unexpected.map((r) => r.action).join(',')}]` : ''}`,
      note: 'EMAIL_TEMPLATE_UPDATED/NOTIFICATION_REQUEUED เก็บ userIdเป็นผู้กระทำ (admin) จึงต้องใช้ id-set ไม่สามารถ filter ด้วยบัญชีของ suite ได้',
    });

    await settle(1200);
    await settle(1200);
    const leftoverOutbox = (await rows(conn, 'SELECT id, type, status FROM notification_outbox WHERE id IN (?)', [suiteOutboxIds.length ? suiteOutboxIds : ['__none__']])).length;
    ok('ไม่มีแถวของ suite ค้างใน notification_outbox', leftoverOutbox === 0, {
      input: 'suite outbox ids',
      expected: '0 left',
      actual: `${leftoverOutbox} left of ${suiteOutboxIds.length}`,
    });
    const after = {};
    for (const t of TABLES) after[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const drift = TABLES.filter((t) => after[t] !== baseline[t]).map((t) => `${t}: ${baseline[t]} -> ${after[t]}`);
    ok('จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline', drift.length === 0, {
      input: TABLES.join(','),
      expected: TABLES.map((t) => `${t}=${baseline[t]}`).join(','),
      actual: TABLES.map((t) => `${t}=${after[t]}`).join(','),
      note: drift.length ? drift.join(' | ') : 'no drift',
    });
    const ghostUser = await api('GET', '/api/users?includeDeleted=true', { token: admin });
    ok('ผู้ใช้ของ suite หายไปจาก GET /api/users ทั้งหมด (รวม includeDeleted)', suiteUsers.every((u) => !ghostUser.json?.users?.some((x) => x.username === u.username)), {
      input: `check ${suiteUsers.length} throwaway usernames`,
      expected: 'none present',
      actual: ghostUser.json?.users?.filter((x) => suiteUsers.some((u) => u.username === x.username)).map((x) => x.username).join(',') || 'none present',
    });
    const ghostLogin = await login(uOtp.user.username);
    ok('บัญชีที่ถูกลบถาวร login ไม่ได้ (ไม่เหลือ session ใช้ได้)', ghostLogin.status === 401, {
      input: `login ${uOtp.user.username}`,
      expected: '401',
      actual: `HTTP ${ghostLogin.status}`,
      note: 'ยืนยันว่าการลบเป็น hard delete จริง ไม่ใช่แค่ปิดใช้งาน',
    });
  } finally {
    // Never leave a mutated template or a throwaway account behind, even on an aborted run.
    for (const t of templateSnapshot) await restoreTemplate(t).catch(() => undefined);
    if (suiteUsers.length) {
      const ids = suiteUsers.map((u) => u.id);
      await conn.query('DELETE FROM notification_outbox WHERE userId IN (?)', [ids]).catch(() => undefined);
      await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [ids]).catch(() => undefined);
      await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [ids]).catch(() => undefined);
      await conn.query('DELETE FROM users WHERE id IN (?)', [ids]).catch(() => undefined);
    }
  }
}
