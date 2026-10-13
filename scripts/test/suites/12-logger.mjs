// 3.12 Logging and error observability: the hourly winston file (name, timezone, line format,
// level thresholds, rotation), the NODE_ENV=test silence, what a real unhandled error leaves
// behind, and whether the log directory itself holds secrets.
//
// The suite never edits a log file. It writes through the module the server uses (a short tsx
// child process) and through real HTTP calls, then reads the files back. Everything it touches
// in the database (throwaway users, two template bodies) is restored exactly as suite 11 does.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
  JWT_SECRET,
  PASSWORD,
  ROOT,
  SERVER_ENV,
  api as http,
  check,
  errorMessage,
  rows,
  settle,
  statusCheck,
  unseal,
} from '../lib/harness.mjs';

const CAT = 'logger';
const RUN_TAG = String(Date.now()).slice(-6);

const TSX_CLI = `${ROOT}node_modules/tsx/dist/cli.mjs`;
const PROBE_FILE = `${ROOT}scripts/test/tmp-logger-probe-${RUN_TAG}.mts`;
const LOG_DIRS = [`${ROOT}server/src/logs`, `${ROOT}server/dist/logs`].filter(existsSync);

/** A log record: `YYYY-MM-DD HH:mm:ss [LEVEL  ]: message` with the level padded to 7 columns. */
const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\S.{6})\]: ([\s\S]*)$/;
const CURRENT_FILE_RE = /^(\d{10})_LoanSystem\.log$/;
const LEGACY_FILE_RE = /^(\d{10})_apiOpenWay\.log$/;
/** Asia/Bangkok has no DST, so a fixed +07 offset is exact. */
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;
const p2 = (n) => String(n).padStart(2, '0');
const hourKey = (d) => `${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
const bkkNow = () => new Date(Date.now() + BKK_OFFSET_MS);
const utcNow = () => new Date(Date.now());
/** Milliseconds of a wall-clock stamp as written in the file (Bangkok time read as UTC). */
const stampToMs = (stamp) => {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(stamp);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
};

const filesIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.log'));
const allLogFiles = () => LOG_DIRS.flatMap((d) => filesIn(d).map((f) => `${d}/${f}`));
const loanSystemFiles = () => allLogFiles().filter((f) => /_LoanSystem\.log$/.test(f));
const readLog = (f) => readFileSync(f, 'utf8');
const recordsOf = (text) => text.split(/\r?\n/).filter((l) => l.trim() !== '');
const linesMentioning = (needle) =>
  allLogFiles().flatMap((f) => readLog(f).split(/\r?\n/).filter((l) => l.includes(needle)));
const countMentioning = (needle) => linesMentioning(needle).length;

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));
  const admin = tokens.admin;

  const ok = (name, cond, { input, expected: e = 'true', actual: a = '', note = '' } = {}) =>
    check(CAT, name, { input, expected: e, actual: typeof a === 'string' ? a : JSON.stringify(a), pass: cond, note });

  const M = (tag) => `E2E-LOG-${RUN_TAG}-${tag}`;

  /** Runs a snippet against the real logger module in a child process and returns its output. */
  function runLoggerProbe(code, nodeEnv = 'development') {
    writeFileSync(PROBE_FILE, `import { logger } from '../../server/src/utils/logger.ts';\n${code}\n`);
    const r = spawnSync(process.execPath, [TSX_CLI, PROBE_FILE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      env: { ...process.env, NODE_ENV: nodeEnv },
    });
    if (existsSync(PROBE_FILE)) unlinkSync(PROBE_FILE);
    return { stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), status: r.status, error: r.error ? String(r.error.message ?? r.error) : '' };
  }

  const suiteUsers = [];
  async function makeUser(tag, { fullName, email, role = 'MAKER' }) {
    const name = `tst_lg_${RUN_TAG}_${tag}`;
    const res = await api('POST', '/api/users', {
      token: admin,
      body: { username: name, password: PASSWORD, fullName, email: email ?? null, role },
    });
    const user = res.json?.user;
    if (user?.id) suiteUsers.push(user);
    return { res, user, name };
  }

  const OUTBOX_COLS =
    'id, type, status, attempts, locale, subject, recipientEmail, recipientName, bodyHtml, bodyText, payload, lastError, ' +
    'CAST(sentAt AS CHAR) AS sentAt, CAST(createdAt AS CHAR) AS createdAt, CAST(nextRetryAt AS CHAR) AS nextRetryAt, ' +
    'customerId, loanId, userId';
  const outboxFor = (userId) =>
    rows(conn, `SELECT ${OUTBOX_COLS} FROM notification_outbox WHERE userId=? ORDER BY createdAt`, [userId]);
  const openJson = (value) => {
    try {
      return JSON.parse(unseal(value));
    } catch {
      return {};
    }
  };

  /** Waits until a needle shows up in any log file (the stream flushes on its own schedule). */
  async function pollLogFor(needle, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (allLogFiles().some((f) => readLog(f).includes(needle))) return true;
      if (Date.now() > deadline) return false;
      await settle(1000);
    }
  }

  // ------------------------------------------------------------------ baselines
  const TABLES = ['users', 'notification_outbox', 'audit_logs', 'email_templates', 'password_reset_tokens', 'user_avatars'];

  ok('มีโฟลเดอร์ log ที่ logger ระบุไว้ (server/src/logs) ให้อ่านก่อนเริ่ม suite', LOG_DIRS.length > 0, {
    input: 'server/src/logs + server/dist/logs',
    expected: 'at least one existing log directory',
    actual: LOG_DIRS.length ? LOG_DIRS.map((d) => `${d} (${filesIn(d).length} files)`).join(', ') : 'none found',
    note: 'LOG_DIR มาจาก path.resolve(__dirname, ../logs) จึงไม่มี env ให้ย้ายไฟล์ log ออกนอก source tree ได้ — ต้องวาง log path + retention เองก่อนขึ้น Production',
  });

  // A single-line warm-up probe: it makes sure the current hour file exists before the format
  // checks read it, and it is the evidence for the level thresholds.
  const warm = runLoggerProbe(
    [
      `logger.info('${M('info')}');`,
      `logger.debug('${M('debug')}');`,
      `logger.warn('${M('warn')}');`,
      `logger.error('${M('error')}');`,
      `logger.silly('${M('silly')}');`,
      `logger.error('${M('metamsg')}', new Error('${M('metacause')}'));`,
      `logger.info({ marker: '${M('object')}', detail: 42 });`,
    ].join('\n'),
  );

  const baselineCounts = {};
  for (const t of TABLES) baselineCounts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  const auditIdsBefore = new Set((await rows(conn, 'SELECT id FROM audit_logs')).map((r) => r.id));
  const templateSnapshot = await rows(
    conn,
    'SELECT id, code, locale, subject, bodyHtml, bodyText, variables, isActive, updatedBy, ' +
      "CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt FROM email_templates",
  );
  const tplId = (code) => templateSnapshot.find((t) => t.code === code)?.id;
  const restoreTemplate = async (t) =>
    conn.query(
      'UPDATE email_templates SET subject=?, bodyHtml=?, bodyText=?, variables=?, isActive=?, updatedBy=?, createdAt=?, updatedAt=? WHERE id=?',
      [t.subject, t.bodyHtml, t.bodyText, t.variables, t.isActive, t.updatedBy, t.createdAt, t.updatedAt, t.id],
    );
  const logSizesBefore = new Map(allLogFiles().map((f) => [f, statSync(f).size]));
  const logNamesBefore = new Set(allLogFiles().map((f) => f.split('/').pop()));

  // The corpus is snapshotted before the multi-line probes write, so the line-format invariants
  // are measured on real server output rather than on the suite's own stack samples.
  const corpus = loanSystemFiles().map((f) => ({ file: f, name: f.split('/').pop(), text: readLog(f) }));

  try {
    // ============================================================= A. files, names, rotation
    ok('child process ที่ใช้ logger ตัวเดียวกับเซิร์ฟเวอร์รันได้', warm.status === 0 && !warm.error, {
      input: 'tsx child: info/debug/warn/error/silly + meta-error',
      expected: 'exit 0',
      actual: `exit=${warm.status} ${warm.error || warm.stderr.slice(0, 60)}`,
      note: 'ใช้ module จริง (server/src/utils/logger.ts) เพื่อวัด level threshold กับ silence ที่ unit level — ไม่แก้โค้ดระบบ',
    });

    const names = [...logNamesBefore];
    const currentHour = hourKey(bkkNow());
    const utcHourKey = hourKey(utcNow());
    const currentFile = `${LOG_DIRS[0]}/${currentHour}_LoanSystem.log`;

    ok('ชื่อไฟล์ทุกไฟล์เป็นรูปแบบ ชั่วโมง-ชื่อระบบ.log เท่านั้น', names.every((n) => CURRENT_FILE_RE.test(n) || LEGACY_FILE_RE.test(n)), {
      input: names.length ? names.slice(0, 6).join(',') : 'none',
      expected: '^(\\d{10})_LoanSystem\\.log$',
      actual: `${names.filter((n) => CURRENT_FILE_RE.test(n)).length} ไฟล์ปัจจุบัน + ${names.filter((n) => LEGACY_FILE_RE.test(n)).length} ไฟล์ชื่อเก่า (apiOpenWay)`,
      note: 'ไฟล์ apiOpenWay เก่า 2 ไฟล์ leftovers จากชื่อก่อนเปลี่ยนเป็น LoanSystem — ยังอยู่ในโฟลเดอร์เดียวกัน ต้อง purge ใน stage 5',
    });

    ok('มีไฟล์ของชั่วโมงปัจจุบัน (Asia/Bangkok) และ logger เขียนต่อชั่วโมง', existsSync(currentFile), {
      input: `${currentHour}_LoanSystem.log`,
      expected: 'exists',
      actual: existsSync(currentFile) ? `exists, ${statSync(currentFile).size} bytes` : 'missing',
      note: 'rotation ทดสอบจากหลักฐาน: ฐานชื่อไฟล์มีหลายชั่วโมง และแต่ละไฟล์มีเวลาในบรรทัดตรงตามชื่อไฟล์ (ข้อ B)',
    });

    ok('ชื่อไฟล์ใช้ชั่วโมง Asia/Bangkok ไม่ใช่ UTC', currentHour !== utcHourKey && existsSync(currentFile), {
      input: `bangkok=${currentHour} utc=${utcHourKey}`,
      expected: `file named after bangkok hour (${currentHour})`,
      actual: existsSync(currentFile) ? `found ${currentHour}_LoanSystem.log` : `only ${utcHourKey} would exist under UTC`,
    });

    const hourKeys = corpus.map((c) => c.name.match(CURRENT_FILE_RE)?.[1]).filter(Boolean);
    ok('มีไฟล์ log หลายชั่วโมงในโฟลเดอร์ (การแบ่งไฟล์ตามชั่วโมงทำงานจริง)', new Set(hourKeys).size >= 2, {
      input: `${corpus.length} files`,
      expected: '>= 2 distinct hours',
      actual: `${new Set(hourKeys).size} hours: ${[...new Set(hourKeys)].sort().join(' ')}`,
    });

    ok('ไม่มีไฟล์ log ที่ชื่อชั่วโมงอยู่อนาคต', hourKeys.every((h) => Number(h) <= Number(currentHour)), {
      input: hourKeys.slice(-3).join(' '),
      expected: `<= ${currentHour}`,
      actual: `max=${[...hourKeys].sort().pop()}`,
    });

    // ============================================================= B. line format contract
    const badLines = [];
    const forgedLines = [];
    const levelsSeen = new Set();
    const nonMonotonic = [];
    const wrongFileHour = [];
    const futureStamps = [];
    for (const { name, text } of corpus) {
      const fileHour = name.match(CURRENT_FILE_RE)?.[1];
      let prev = -Infinity;
      for (const line of recordsOf(text)) {
        const m = LINE_RE.exec(line);
        if (!m) {
          // Suite 11 proves F-NTF-2 (a username carrying a newline is echoed into the log by the
          // dev transport). Those injected lines are counted separately so one finding stays one
          // failure here, and this case keeps measuring the logger's own output.
          if (line.includes('FORGED-LINE-9131')) forgedLines.push(line.slice(0, 60));
          else if (badLines.length < 3) badLines.push(line.slice(0, 70));
          continue;
        }
        levelsSeen.add(m[2]);
        const ms = stampToMs(m[1]);
        if (ms < prev) nonMonotonic.push(`${name} ${m[1]}`);
        prev = ms;
        if (hourKey(new Date(ms)) !== fileHour) wrongFileHour.push(`${name} line=${m[1]}`);
        if (ms > Date.now() + BKK_OFFSET_MS + 5 * 60 * 1000) futureStamps.push(m[1]);
      }
    }
    const totalRecords = corpus.reduce((a, c) => a + recordsOf(c.text).length, 0);

    ok('ทุกบรรทัดที่ logger เขียนเอง ตรงรูปแบบ time [LEVEL  ]: message', badLines.length === 0, {
      input: `${totalRecords} non-empty lines across ${corpus.length} files`,
      expected: '0 unmatched',
      actual: badLines.length ? `unmatched ${badLines.length}: ${badLines.join(' | ')}` : `${totalRecords - forgedLines.length}/${totalRecords} match`,
      note: 'invariant นี้คือเหตุผลที่ log forging (F-NTF-2) เป็นของจริง — ดูข้อถัดไป',
    });
    ok('ไฟล์ log มีบรรทัดที่ไม่ใช่ record จากเหตุ log forging ของ suite 11 (F-NTF-2) ปรากฏอยู่', forgedLines.length > 0, {
      input: 'lines that do not start with a timestamp',
      expected: 'reported as residue of F-NTF-2, not a second finding',
      actual: `${forgedLines.length} forged line(s) in the corpus, e.g. "${forgedLines[0]}"`,
      note: 'F-NTF-2 บันทึกไว้ที่หมวด notifications (username ใส่ newline ได้ → พิมพ์ลง log ตรง ๆ) ที่นี่นับเป็นหลักฐานว่า corpus เสียรูปแบบ one-record-per-line จริง ไม่ทำ fail ซ้ำ',
    });

    ok('ช่อง level กว้าง 7 ตัวอักษรเสมอ (padEnd)', corpus.every((c) => recordsOf(c.text).every((l) => { const m = LINE_RE.exec(l); return !m || m[2].length === 7; })), {
      input: 'the bracketed level field',
      expected: 'width 7 for every line',
      actual: [...levelsSeen].map((l) => `[${l}]`).join(' '),
    });

    ok('ไฟล์ log มีเฉพาะระดับ info ขึ้นไป (debug/silly ไม่ถูกเขียนไฟล์)', [...levelsSeen].every((l) => ['INFO', 'WARN', 'ERROR'].includes(l.trim())) && !recordsOf(readLog(currentFile)).some((l) => l.includes(M('debug')) || l.includes(M('silly'))), {
      input: `levels seen: ${[...levelsSeen].join(',')}`,
      expected: 'only INFO/WARN/ERROR',
      actual: [...levelsSeen].join(','),
      note: 'transports: Console level silly, Stream(ไฟล์) level info',
    });

    ok('เวลาในไฟล์เรียงจากเก่าไปใหม่ไม่ย้อนหลัง', nonMonotonic.length === 0, {
      input: 'per-file timestamp sequence',
      expected: 'non-decreasing',
      actual: nonMonotonic.length ? nonMonotonic.slice(0, 3).join(' | ') : 'monotonic in every file',
      note: 'server นี้รีสตาร์ทบ่อยระหว่างพัฒนา (tsx watch) แต่ stream ต่อไฟล์ append จึงไม่ย้อนเวลา',
    });

    ok('ชั่วโมงในบรรทัดตรงกับชื่อไฟล์เสมอ (ไม่มีบรรทัดตกไฟล์ผิดชั่วโมง)', wrongFileHour.length === 0, {
      input: 'line stamp hour vs file name hour',
      expected: '0 mismatches',
      actual: wrongFileHour.length ? wrongFileHour.slice(0, 3).join(' | ') : `${totalRecords} lines all in the right hourly file`,
    });

    ok('ไม่มี stamp อยู่ในอนาคต', futureStamps.length === 0, {
      input: 'max stamp vs bangkok now',
      expected: '<= now + 5min',
      actual: futureStamps.length ? futureStamps.join(' ') : 'ok',
    });

    // ============================================================= C. record separation
    const sample = corpus.map((c) => c.text).join('');
    const blankLines = (sample.match(/\r?\n\n/g) ?? []).length;
    ok('ทุก record จบด้วย newline ตัวเดียว (ไม่มีบรรทัดว่างคั่นทุกบรรทัด)', blankLines === 0, {
      input: `count of "\\r\\n\\n" / "\\n\\n" in ${corpus.length} files`,
      expected: '0 blank separators',
      actual: `${blankLines} blank separators for ${totalRecords} records (ไฟล์ ~2 เท่าจำนวน record ที่จำเป็น)`,
      note: 'F-LOG-1: winston Stream transport ปิดท้ายด้วย os.EOL แล้ว appendToHourlyFile ต่อ \\n อีกชั้น => ทุกบรรทัดจบด้วย \\r\\n\\n ขัดกับรูปแบบ one record per line ที่ suite นี้อยากใช้ parse/grep และโตเกินจำเป็น 2 เท่า (ตรวจด้วย od -c เห็น \\r \\n \\n ชัด)',
    });

    // ============================================================= D. live writes over HTTP
    const unhandledBefore = countMentioning('[unhandled error]');

    const uMail = await makeUser('mail', { fullName: 'Test Log Mail', email: `tst_lg_mail_${RUN_TAG}@test.local` });
    statusCheck(CAT, 'สร้างบัญชีที่มี email (สำหรับดูบรรทัด transport log): 201', uMail.res, 201, { input: uMail.name });
    const infoHit = await pollLogFor(`[notify:log] USER_CREATED -> ${uMail.user.email}`);
    const infoLine = linesMentioning(`[notify:log] USER_CREATED -> ${uMail.user.email}`).pop() ?? '';
    ok('การ enqueue ที่สำเร็จเขียนบรรทัด [notify:log] ลงไฟล์ชั่วโมงปัจจุบัน', infoHit, {
      input: `needle: [notify:log] USER_CREATED -> ${uMail.user.email}`,
      expected: 'present in the log',
      actual: infoLine.slice(0, 120) || 'not found',
      note: 'transport=log (NOTIFY_TRANSPORT ที่ server/.env ตั้งไว้) จึงเห็น pipeline ครบวงจรในไฟล์ log โดยไม่มี SMTP/Kafka จริง',
    });
    ok('บรรทัด log ที่เขียนสดใช้รูปแบบ time [INFO   ]: และเวลาตรงตามจริง', LINE_RE.test(infoLine) && Math.abs(stampToMs(infoLine.slice(0, 19)) - (Date.now() + BKK_OFFSET_MS)) < 10 * 60 * 1000, {
      input: infoLine.slice(0, 40),
      expected: 'format + timestamp within the last 10 minutes',
      actual: `${LINE_RE.test(infoLine) ? 'format ok' : 'format bad'} / level=${LINE_RE.exec(infoLine)?.[2]?.trim()} / stamp=${infoLine.slice(0, 19)}`,
    });

    const uNoMail = await makeUser('nomail', { fullName: 'Test Log NoMail' });
    statusCheck(CAT, 'สร้างบัญชีที่ไม่มี email (เส้น warn ของ enqueue): 201', uNoMail.res, 201, { input: uNoMail.name });
    const warnHit = await pollLogFor('[notify] skipped USER_CREATED: recipient has no email address');
    ok('ไม่มี recipient email: enqueue เขียน WARN แล้วข้ามแถว (业务流程ไม่พัง)', warnHit && (await outboxFor(uNoMail.user.id)).length === 0, {
      input: 'create user with email = NULL',
      expected: 'warn line + no outbox row',
      actual: `warnLine=${warnHit ? 'found' : 'missing'} rows=${(await outboxFor(uNoMail.user.id)).length}`,
      note: 'ตรวจฝั่ง log ของ contract ที่ suite 11 เคยตรวจฝั่งตาราง — ทั้งสองทางต้องตรงกัน',
    });

    await api('PATCH', `/api/notifications/templates/${tplId('USER_CREATED')}`, { token: admin, body: { isActive: false } });
    const uOff = await makeUser('off', { fullName: 'Test Log Off', email: `tst_lg_off_${RUN_TAG}@test.local` });
    const warnTpl = await pollLogFor('[notify] skipped USER_CREATED: no active email template');
    ok('template ปิดอยู่: enqueue เขียน WARN "no active email template" แล้วข้าม', warnTpl && uOff.res.status === 201, {
      input: 'isActive=false on USER_CREATED, then create a user',
      expected: 'warn line + user still created 201',
      actual: `warnLine=${warnTpl ? 'found' : 'missing'} signup=${uOff.res.status}`,
    });
    await api('PATCH', `/api/notifications/templates/${tplId('USER_CREATED')}`, { token: admin, body: { isActive: true } });

    const boot = linesMentioning('[db] connected to ');
    const listen = linesMentioning('[server] listening on http://localhost:');
    const started = linesMentioning('[notify] dispatcher started: transport=');
    ok('บรรทัด startup (db connected / listening / dispatcher started) ถูกเขียนลงไฟล์', boot.length > 0 && listen.length > 0 && started.length > 0, {
      input: 'three boot needles',
      expected: '>= 1 line each',
      actual: `db=${boot.length} listen=${listen.length} dispatcher=${started.length}`,
    });
    const startedLine = started[started.length - 1] ?? '';
    const wantTransport = (SERVER_ENV.NOTIFY_TRANSPORT ?? 'log').toLowerCase();
    const wantInterval = SERVER_ENV.NOTIFY_POLL_INTERVAL_MS ?? '5000';
    ok('บรรทัด dispatcher started รายงาน transport/interval ตรงกับ env ที่เซิร์ฟเวอร์ใช้จริง', startedLine.includes(`transport=${wantTransport},`) && startedLine.includes(`every ${wantInterval}ms`), {
      input: `env: transport=${wantTransport} poll=${wantInterval}ms`,
      expected: 'the log echoes the effective config',
      actual: startedLine.slice(0, 140),
      note: 'ยืนยันว่าไม่มี SMTP/Kafka/mailer จริงถูกเรียกในสภาพแวดล้อมที่เทสต์ (ข้อห้ามของ mission)',
    });
    const dbLine = boot[boot.length - 1] ?? '';
    ok('บรรทัด db connected ไม่ใส่รหัสผ่านลง log', dbLine.includes(`${SERVER_ENV.DB_HOST ?? '127.0.0.1'}:${SERVER_ENV.DB_PORT ?? '3307'}/${SERVER_ENV.DB_NAME ?? 'loan_management'}`) && !dbLine.includes(String(SERVER_ENV.DB_PASSWORD ?? '__none__')), {
      input: dbLine.slice(0, 120),
      expected: 'host:port/database only',
      actual: dbLine.slice(0, 120),
    });

    const notFoundRes = await api('GET', '/api/definitely-not-a-route', { token: admin });
    statusCheck(CAT, 'route ไม่มีจริง: 404 Not found', notFoundRes, 404, { input: 'GET /api/definitely-not-a-route' });
    const anonRes = await api('GET', '/api/users', { token: null });
    statusCheck(CAT, 'ไม่ส่ง token: 401', anonRes, 401, { input: 'GET /api/users (anonymous)' });
    await settle(1500);
    ok('404/401 ไม่กลายเป็น [unhandled error] ในไฟล์ log (เฉพาะ error ตัวจริงเท่านั้น)', countMentioning('[unhandled error]') === unhandledBefore, {
      input: 'one 404 + one 401 request',
      expected: `unhandled-error lines stay at ${unhandledBefore}`,
      actual: `now ${countMentioning('[unhandled error]')}`,
      note: 'ข้อดี: ไฟล์ log ไม่เต็มไปด้วย noise จาก scanner/brute-force — แต่หมายความว่า attempts ที่ถูกปฏิเสธเห็นได้เฉพาะใน audit_logs เท่านั้น',
    });

    // ============================================================= E. encoding of the files
    const renderedSubject = String(templateSnapshot.find((t) => t.code === 'USER_CREATED')?.subject ?? '').replace('{{username}}', uMail.name);
    const subjectLines = linesMentioning(renderedSubject);
    ok('subject ภาษาลาวจาก template เขียนลงไฟล์ log ได้ครบไม่เพี้ยน (UTF-8 รอบปลายทาง)', subjectLines.length > 0, {
      input: 'search the log for the rendered Lao subject of the user the suite just created',
      expected: 'at least one line containing the exact subject text',
      actual: subjectLines.length ? `found in ${subjectLines.length} line(s)` : 'not found',
      note: 'ตรวจเป็น boolean เท่านั้น ไม่พิมพ์ภาษาลาวออก console (cp1252) — รายละเอียดอยู่ใน results.json',
    });
    const replacementChars = corpus.filter((c) => c.text.includes('\uFFFD')).map((c) => c.name);
    ok('ไม่มีอักขระเสีย (U+FFFD) ในไฟล์ log ที่อ่านกลับเป็น UTF-8', replacementChars.length === 0, {
      input: `${corpus.length} files decoded as utf8`,
      expected: '0 files with U+FFFD',
      actual: replacementChars.length ? replacementChars.join(',') : 'clean',
    });
    const mojibake = corpus.filter((c) => /Ã.|â€./.test(c.text)).map((c) => c.name);
    ok('ไม่มีร่องรอย mojibake (ไฟล์ถูกเขียน/อ่านด้วย encoding เดียวกันคือ UTF-8)', mojibake.length === 0, {
      input: 'scan for latin-1 mis-decoding patterns',
      expected: '0 files',
      actual: mojibake.length ? mojibake.join(',') : 'clean',
    });

    // ============================================================= F. level thresholds + silence
    ok(`debug ส่งออก console แต่ไม่ลงไฟล์ (level threshold ของ stream transport = info)`, warm.stdout.includes(M('debug')) && !allLogFiles().some((f) => readLog(f).includes(M('debug'))), {
      input: 'logger.debug() in a tsx child process',
      expected: 'on stdout, absent from every file',
      actual: `stdout=${warm.stdout.includes(M('debug')) ? 'yes' : 'no'} files=${allLogFiles().filter((f) => readLog(f).includes(M('debug'))).length}`,
      note: 'console ของ `npm run dev` เห็นทุกระดับ (silly) แต่ไฟล์เก็บเฉพาะ info ขึ้นไป ตาม comment ใน logger.ts',
    });
    ok('silly ก็ไม่ลงไฟล์เช่นกัน', warm.stdout.includes(M('silly')) && !allLogFiles().some((f) => readLog(f).includes(M('silly'))), {
      input: 'logger.silly()',
      expected: 'stdout only',
      actual: `stdout=${warm.stdout.includes(M('silly')) ? 'yes' : 'no'}`,
    });
    ok('info/warn/error จาก code path เดียวกันลงไฟล์ครบ', ['info', 'warn', 'error'].every((lvl) => allLogFiles().some((f) => readLog(f).includes(M(lvl)))), {
      input: 'three probes at/above info',
      expected: 'all three in the hourly file',
      actual: ['info', 'warn', 'error'].map((lvl) => `${lvl}=${allLogFiles().filter((f) => readLog(f).includes(M(lvl))).length ? 'ok' : 'MISSING'}`).join(' '),
    });

    const silent = runLoggerProbe(`logger.info('${M('silent')}');`, 'test');
    ok('NODE_ENV=test: logger silent สมบูรณ์ (ไม่เขียนไฟล์และไม่ออก console)', !allLogFiles().some((f) => readLog(f).includes(M('silent'))) && !silent.stdout.includes(M('silent')), {
      input: 'tsx child with NODE_ENV=test',
      expected: 'marker nowhere',
      actual: `files=${allLogFiles().filter((f) => readLog(f).includes(M('silent'))).length} stdout=${silent.stdout.includes(M('silent')) ? 'leaked' : 'clean'}`,
      note: 'รองรับว่า unit test (jest ตั้ง NODE_ENV=test) ไม่ไปปะปนกับ log จริงของสภาพแวดล้อม — requirement "ช่วงรันเทสต์ปิดการเขียน log ลงไฟล์"',
    });

    const metaErrLine = (linesMentioning(M('metamsg')).pop() ?? '').slice(19);
    ok('F-LOG-2: logger.error(msg, err) ต้องเก็บ stack ของ err ไว้ตามที่ renderMessage ตั้งใจไว้', metaErrLine.includes('    at ') || metaErrLine.includes(`${M('metacause')}\n`), {
      input: 'the line produced by logger.error(metaMsg, new Error(metaCause))',
      expected: 'the stack trace recorded with the message',
      actual: metaErrLine.slice(0, 150) || 'line not found',
      note: 'F-LOG-2: printf ของ logger อ่านเฉพาะ info.message ส่วน err ที่ส่งเป็น arg ที่สอง winston แปะแค่ message (จาก splat) ไม่ได้เขียน stack — renderMessage มี branch ใช้ stack ก็ต่อเมื่อ Error เป็น arg ตัวแรก ซึ่งไม่มี call site ไหนใน server/src เรียกแบบนั้น (index.ts fatal, middleware/error.ts 500, dispatcher tick, notification-events emit) ผลคือ 500 จริงบน production จะเหลือแค่ method+url+ข้อความสั้น ไม่มี trace ให้หาบรรทัดที่พัง',
    });
    ok('cause message ของ err ยังโผล่มาในบรรทัด log (พอระบุสาเหตุระดับหนึ่ง)', metaErrLine.includes(M('metacause')), {
      input: 'same line, inner error message',
      expected: 'inner message present',
      actual: metaErrLine.slice(0, 120) || 'line not found',
      note: 'หลักฐานจาก 500 จริงในข้อ G: "Data too long for column ..." และ "request entity too large" ปรากฏครบ — จึงจัด F-LOG-2 เป็น "ไม่มี stack" ไม่ใช่ "ไม่มีสาเหตุ"',
    });
    const objectLine = (linesMentioning(M('object')).pop() ?? '').slice(19);
    ok('message ที่เป็น object ถูก renderMessage แปลงเป็น JSON ครบทุก field (not string branch)', /"marker":"[^"]*object"/.test(objectLine) && /"detail":42/.test(objectLine), {
      input: 'logger.info({ marker, detail })',
      expected: 'one line with both fields as JSON',
      actual: objectLine.slice(0, 140) || 'line not found',
      note: 'branch ที่สามของ renderMessage (JSON.stringify) ใช้งานได้ตามที่ comment ใน logger.ts ว่าไว้ — แต่ structuring แบบนี้เป็น text-only จึงยังไม่มี metadata แยก field ให้ query',
    });

    // ============================================================= G. secrets in the log directory
    const secretStrings = [
      ['รหัสผ่านบัญชีเทสต์ (PASSWORD)', PASSWORD],
      ['DB_PASSWORD', SERVER_ENV.DB_PASSWORD],
      ['JWT_SECRET', JWT_SECRET ?? SERVER_ENV.JWT_SECRET],
      ['NOTIFY_SECRET_KEY', SERVER_ENV.NOTIFY_SECRET_KEY],
      ['MAILER_API_KEY', SERVER_ENV.MAILER_API_KEY],
      ['access token ของ run นี้', tokens.admin],
    ].filter(([, v]) => typeof v === 'string' && v.length > 4);
    for (const [label, value] of secretStrings) {
      const hits = allLogFiles().filter((f) => readLog(f).includes(value));
      ok(`log ไม่เก็บ ${label} แบบ plaintext`, hits.length === 0, {
        input: `scan ${allLogFiles().length} files for the value (length ${value.length})`,
        expected: 'no file contains it',
        actual: hits.length ? `found in ${hits.map((f) => f.split('/').pop()).join(',')}` : 'clean',
      });
    }

    const windowClear = (await rows(conn, 'SELECT COUNT(*) n FROM password_reset_tokens WHERE createdAt > DATE_SUB(NOW(), INTERVAL 60 SECOND)'))[0].n === 0;
    const otpAck = windowClear
      ? await api('POST', '/api/auth/forgot-password', { token: null, body: { email: uMail.user.email } })
      : { status: 'throttled-window' };
    const otpRow = (await outboxFor(uMail.user.id)).find((r) => r.type === 'PASSWORD_RESET_OTP');
    const otpValue = String(openJson(otpRow?.payload)?.otp ?? '');
    ok('ขอ OTP สำหรับตรวจ log (202) — ข้ามได้ถ้า cooldown/IP throttle ยังทำงาน', otpAck.status === 202 || !windowClear, {
      input: `POST /api/auth/forgot-password for ${uMail.user.email}`,
      expected: 'HTTP 202 (or skip when the shared 60s window is busy)',
      actual: `HTTP ${otpAck.status} windowClear=${windowClear}`,
      note: 'suite 11 ตรวจ redaction ของ transport แล้ว ที่นี่เน้นไฟล์ log เป็นหลัก',
    });
    if (otpValue) {
      const otpHits = allLogFiles().filter((f) => readLog(f).includes(otpValue));
      ok('OTP ที่ run นี้ issuance ขึ้นไป ไม่พบในไฟล์ log เลย (transport redact)', otpHits.length === 0, {
        input: 'scan every log file for the live 6-digit code',
        expected: 'no file contains it',
        actual: otpHits.length ? `found in ${otpHits.map((f) => f.split('/').pop()).join(',')}` : 'clean',
      });
    }
    if (otpValue) await pollLogFor(`PASSWORD_RESET_OTP -> ${uMail.user.email}`, 15000);
    const myOtpLines = linesMentioning(`PASSWORD_RESET_OTP -> ${uMail.user.email}`);
    const unredactedNow = myOtpLines.filter((l) => !l.includes('<redacted '));
    ok('บรรทัด transport ของ OTP ที่ run นี้ issuance ใช้ <redacted ...> (โค้ดปัจจุบัน)', otpValue ? myOtpLines.length >= 1 && unredactedNow.length === 0 : true, {
      input: `notify:log lines of ${uMail.user.email}`,
      expected: otpValue ? '>= 1 line, all redacted' : 'skipped: no OTP issued in this run (throttled)',
      actual: myOtpLines.length ? `${myOtpLines.length} line(s), ${unredactedNow.length} not redacted — ${String(myOtpLines[0]).slice(19, 90)}` : 'no line found for this run',
      note: `ตรวจเฉพาะของ run นี้ (บรรทัดเก่าก่อนมี redaction นับไว้ที่ F-LOG-4 ข้อถัดไป) — SECRET_EVENT_TYPES ใน notification-dispatcher.service.ts`,
    });

    const otpSubject = /ເລກຢືນຢັນ\s*\d{6}/;
    const otpFileHits = allLogFiles().map((f) => ({ f, n: (readLog(f).match(new RegExp(otpSubject.source, 'g')) ?? []).length })).filter((x) => x.n > 0);
    ok('ไม่มีบรรทัด log เก่าที่เก็บ OTP เป็น plaintext เหลืออยู่ในโฟลเดอร์ log', otpFileHits.length === 0, {
      input: 'scan all files for the OTP subject pattern (Lao prefix + 6 digits)',
      expected: '0 occurrences',
      actual: otpFileHits.length ? `${otpFileHits.reduce((a, x) => a + x.n, 0)} occurrences in ${otpFileHits.map((x) => `${x.f.split('/').pop()}=${x.n}`).join(', ')}` : 'clean',
      note: 'F-LOG-4: ไฟล์ 2026101222/2026101301/2026101302/2026101308 เกิดก่อนมี redaction (ดูจาก timestamp) จึงยังอ่าน OTP เดิมกลับได้จากไฟล์ log ที่อยู่กลาง source tree — โค้ดปัจจุบันไม่สร้างบรรทัดแบบนี้อีก แต่ไฟล์พวกนี้ต้องถูกลบใน stage 5 ก่อนขึ้น Production และต้อง archive/rotate log นอก repo',
    });

    // ============================================================= H. a real 500 and what it leaves
    const rid = tplId('LOAN_REJECTED');
    const overColumn = `<p>${'Z'.repeat(70000)}</p>`;
    const overParser = `<p>${'Y'.repeat(300000)}</p>`;
    const errUrlNeedle = `[unhandled error] PATCH /api/notifications/templates/${rid}`;
    const unhandledNeedleBefore = countMentioning(errUrlNeedle);

    const bigPatch = await api('PATCH', `/api/notifications/templates/${rid}`, { token: admin, body: { bodyHtml: overColumn } });
    ok('H1 template body ที่ยาวกว่าคอลัมน์ TEXT ต้องถูก reject เป็น client error (400)', bigPatch.status === 400, {
      input: `PATCH bodyHtml with ${overColumn.length} chars`,
      expected: 'HTTP 400 validation error',
      actual: `HTTP ${bigPatch.status} ${errorMessage(bigPatch).slice(0, 60)}`,
      note: 'F-NTF-4: templateSchema (notifications.router.ts) กำหนด min(1) ให้ bodyHtml/bodyText แต่ไม่มี max ขณะที่คอลัมน์เป็น TEXT (65,535 bytes) → MySQL STRICT_TRANS_TABLES เทความผิดพลาดกลับมาเป็น 500 "Internal server error" แทนที่จะบอกว่า input ยาวเกิน',
    });
    ok('H2 คำตอบ 500 ไม่ปล่อย stack/SQL/ชื่อคอลัมน์ให้ client', bigPatch.status !== 200 && !/at |QueryFailedError|Data too long|ER_DATA/i.test(JSON.stringify(bigPatch.json)), {
      input: 'the 500 response body',
      expected: 'a generic message only',
      actual: JSON.stringify(bigPatch.json).slice(0, 140),
    });
    const rowAfterBig = (await rows(conn, 'SELECT bodyHtml FROM email_templates WHERE id=?', [rid]))[0];
    ok('H3 PATCH ที่ล้มเหลวไม่แก้แถว template (transaction rollback ครบ)', rowAfterBig.bodyHtml === templateSnapshot.find((t) => t.id === rid).bodyHtml, {
      input: 'stored bodyHtml after the failed PATCH',
      expected: `unchanged (${templateSnapshot.find((t) => t.id === rid).bodyHtml.length} chars)`,
      actual: `${String(rowAfterBig.bodyHtml).length} chars, identical=${rowAfterBig.bodyHtml === templateSnapshot.find((t) => t.id === rid).bodyHtml}`,
    });
    const auditAfterFail = await rows(conn, "SELECT id FROM audit_logs WHERE action='EMAIL_TEMPLATE_UPDATED' AND reason LIKE ?", [`%${templateSnapshot.find((t) => t.id === rid).code}%`]);
    const newAuditFromFail = auditAfterFail.filter((r) => !auditIdsBefore.has(r.id));
    ok('H4 PATCH ที่ล้มเหลวไม่เขียน audit EMAIL_TEMPLATE_UPDATED', newAuditFromFail.length === 0, {
      input: 'audit rows for LOAN_REJECTED',
      expected: 'no new row',
      actual: `${newAuditFromFail.length} new row(s)`,
      note: 'audit ของ PATCH ที่สำเร็จจะถูกลบตอน cleanup ของ suite นี้อยู่แล้ว',
    });

    const parserPatch = await api('PATCH', `/api/notifications/templates/${rid}`, { token: admin, body: { bodyHtml: overParser } });
    ok('H5 request body เกิน limit ของ express.json (100kb) ควรตอบ 413 ไม่ใช่ 500', parserPatch.status === 413, {
      input: `PATCH with a ${overParser.length} char body`,
      expected: 'HTTP 413',
      actual: `HTTP ${parserPatch.status} ${errorMessage(parserPatch).slice(0, 60)}`,
      note: 'F-LOG-3: errorHandler (middleware/error.ts) ตรวจเฉพาะ AppError/ZodError/ER_DUP_ENTRY ที่เหลือยัด 500 หมด ทั้งที่ body-parser ตั้ง err.status=413/err.code=entity.too.large ไว้แล้ว client จึงแยกไม่ออกว่า "payload ใหญ่เกิน" หรือ "เซิร์ฟเวอร์พัง" และทุกครั้งจะเกิด [unhandled error] ในไฟล์ log ตามไปเรื่อยๆ',
    });
    await settle(2000);
    const unhandledNeedleAfter = countMentioning(errUrlNeedle);
    ok('H6 ทุก 500 ที่เกิดขึ้นถูกเขียน log พร้อม method+url+cause', unhandledNeedleAfter - unhandledNeedleBefore === 2, {
      input: `delta of "${errUrlNeedle}" lines`,
      expected: '+2 lines (one per failed PATCH)',
      actual: `+${unhandledNeedleAfter - unhandledNeedleBefore}: ${(linesMentioning(errUrlNeedle).slice(-2) ?? []).map((l) => l.slice(19, 130)).join(' // ')}`,
      note: 'cause มาจาก splat ของ winston (ข้อความสั้นเท่านั้น — ดู F-LOG-2)',
    });
    const healthAfter500 = await api('GET', '/health');
    const stillWorking = await api('GET', '/api/notifications/templates', { token: admin });
    ok('เซิร์ฟเวอร์ยังทำงานต่อได้หลัง 500 สองครั้ง (ไม่ crash, ไม่มี connection ค้าง)', healthAfter500.status === 200 && stillWorking.status === 200, {
      input: 'GET /health + GET /api/notifications/templates',
      expected: '200 and 200',
      actual: `${healthAfter500.status} and ${stillWorking.status}`,
    });

    // ============================================================= I. sealed body overflow: silent loss
    const uid = tplId('USER_CREATED');
    const midSize = `<p>${'X'.repeat(60000)}</p>`;
    const storeMid = await api('PATCH', `/api/notifications/templates/${uid}`, { token: admin, body: { bodyHtml: midSize } });
    ok('I1 template body ~60KB เก็บลงคอลัมน์ TEXT ได้ (200)', storeMid.status === 200 && storeMid.json?.data?.template?.bodyHtml?.length === midSize.length, {
      input: `${midSize.length} chars`,
      expected: '200 + same length stored',
      actual: `HTTP ${storeMid.status} len=${storeMid.json?.data?.template?.bodyHtml?.length}`,
      note: 'ยังไม่เกิน 65,535 bytes ของคอลัมน์ จึงผ่านทั้ง zod (ไม่มี max) และ MySQL',
    });
    const uBig = await makeUser('big', { fullName: 'Test Log Big', email: `tst_lg_big_${RUN_TAG}@test.local` });
    ok('I2 การ queue ที่ล้มเหลวไม่ทำให้ signup พัง (201 เหมือนเดิม)', uBig.res.status === 201, {
      input: 'POST /api/users while the USER_CREATED body is 60KB',
      expected: 'HTTP 201',
      actual: `HTTP ${uBig.res.status} ${errorMessage(uBig.res).slice(0, 60)}`,
      note: 'ตรงตาม contract "notifications must not break a flow" (emit -> try/catch ใน notification-events.service.ts)',
    });
    const bigRows = await outboxFor(uBig.user.id);
    ok('I3 แถว notification ต้องถูก enqueue เมื่อ template ยัง active', bigRows.length === 1, {
      input: 'notification_outbox rows for the user created with a 60KB template',
      expected: '1 row (PENDING or SENT)',
      actual: `${bigRows.length} row(s)${bigRows.length ? `: ${bigRows.map((r) => r.type).join(',')}` : ''}`,
      note: 'F-NTF-5: เนื้อหาถูก seal เป็น sealed:v1:base64(iv).base64(tag).base64(ct) ซึ่งยาวขึ้น ~4/3 + prefix → bodyHtml เกิน ~46KB จะใหญ่กว่าคอลัมน์ TEXT ของ notification_outbox เสมอ INSERT ล้มทั้งแถว "Data too long for column bodyHtml" และ emit กลืน error ไว้ ผลคืออีเมลทั้งประเภทนั้นหายไปเงียบๆ ถาวร (ไม่มีแถว = ไม่มี retry, ไม่มีอะไรให้ requeue) เหลือแค่บรรทัด log เดียว — ทางแก้: bound ความยาว template หรือเปลี่ยนคอลัมน์เป็น MEDIUMTEXT',
    });
    const queueFailFull = linesMentioning('[notify] could not queue USER_CREATED').pop() ?? '';
    const queueFailLine = queueFailFull.slice(19);
    ok('I4 ความล้มเหลวนั้นมีร่องรอยใน log พร้อมข้อความจาก driver', /could not queue USER_CREATED/.test(queueFailLine) && /Data too long|bodyHtml/i.test(queueFailLine), {
      input: 'the [notify] could not queue line',
      expected: 'level ERROR + driver message',
      actual: queueFailLine.slice(0, 150) || 'not found',
      note: `LEVEL=${LINE_RE.exec(queueFailFull)?.[2]?.trim() ?? 'n/a'} — logger.error(msg, error) แบบเดียวกับ F-LOG-2 จึงไม่มี stack ต่อท้ายบรรทัด`,
    });
    await restoreTemplate(templateSnapshot.find((t) => t.id === uid));
    const uBack = await makeUser('back', { fullName: 'Test Log Back', email: `tst_lg_back_${RUN_TAG}@test.local` });
    const backRows = await outboxFor(uBack.user.id);
    ok('I5 หลังคืน template แล้วการ queue กลับมาทำงานปกติ (มีแถว 1 แถว)', uBack.res.status === 201 && backRows.length === 1, {
      input: 'create a user after the restore',
      expected: '201 + 1 outbox row',
      actual: `signup=${uBack.res.status} rows=${backRows.length} (${backRows.map((r) => `${r.type}:${r.status}`).join(',')})`,
    });
    // ============================================================= J. restore + cleanup
    const tplAfter = await rows(
      conn,
      'SELECT id, code, subject, bodyHtml, bodyText, variables, isActive, updatedBy, ' +
        "CAST(createdAt AS CHAR) AS createdAt, CAST(updatedAt AS CHAR) AS updatedAt FROM email_templates",
    );
    const dbTemplateDiff = tplAfter
      .map((row) => {
        const orig = templateSnapshot.find((t) => t.id === row.id);
        const bad = ['subject', 'bodyHtml', 'bodyText', 'variables', 'isActive', 'updatedBy', 'createdAt', 'updatedAt'].filter(
          (f) => String(row[f]) !== String(orig?.[f]),
        );
        return bad.length ? `${row.code}: ${bad.join(',')}` : null;
      })
      .filter(Boolean);
    ok('ฐานข้อมูล: template ทั้ง 9 กลับเป็นค่าเดิมทุกคอลัมน์', dbTemplateDiff.length === 0, {
      input: 'column-by-column diff vs the snapshot',
      expected: 'no differences',
      actual: dbTemplateDiff.length ? dbTemplateDiff.join(' | ') : '9/9 identical',
    });

    const suiteUserIds = suiteUsers.map((u) => u.id);
    const suiteOutboxIds = suiteUserIds.length
      ? (await rows(conn, 'SELECT id FROM notification_outbox WHERE userId IN (?)', [suiteUserIds])).map((r) => r.id)
      : [];
    if (suiteUserIds.length) {
      await conn.query('DELETE FROM notification_outbox WHERE userId IN (?)', [suiteUserIds]);
      await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [suiteUserIds]);
      await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [suiteUserIds]);
      await conn.query('DELETE FROM users WHERE id IN (?)', [suiteUserIds]);
    }
    await settle(1500);

    const allAudit = await rows(conn, 'SELECT id, action, userId, reason FROM audit_logs');
    const fresh = allAudit.filter((r) => !auditIdsBefore.has(r.id));
    const mine = fresh.filter((r) => ['USER_CREATED', 'EMAIL_TEMPLATE_UPDATED'].includes(r.action) || suiteUserIds.includes(r.userId));
    const unexpected = fresh.filter((r) => !['USER_CREATED', 'EMAIL_TEMPLATE_UPDATED'].includes(r.action) && !suiteUserIds.includes(r.userId));
    if (mine.length) await conn.query('DELETE FROM audit_logs WHERE id IN (?)', [mine.map((r) => r.id)]);
    ok('audit rows ที่ suite นี้ก่อถูกลบครบ และไม่มี action อื่นเจือ', unexpected.length === 0 && fresh.length === mine.length, {
      input: 'id-set differencing on audit_logs',
      expected: 'only USER_CREATED / EMAIL_TEMPLATE_UPDATED rows of this suite',
      actual: `new=${fresh.length} deleted=${mine.length} unexpected=${unexpected.length}${unexpected.length ? ` [${unexpected.map((r) => r.action).join(',')}]` : ''}`,
      note: 'EMAIL_TEMPLATE_UPDATED เก็บ userIdเป็นผู้กระทำ (admin) จึงต้องนับด้วย id-set',
    });

    const leftover = suiteUserIds.length ? (await rows(conn, 'SELECT id FROM users WHERE id IN (?)', [suiteUserIds])).length : 0;
    ok('ไม่มีบัญชีของ suite ค้างในตาราง users', leftover === 0, {
      input: `${suiteUserIds.length} ids`,
      expected: '0 left',
      actual: `${leftover} left`,
    });
    const afterCounts = {};
    for (const t of TABLES) afterCounts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const drift = TABLES.filter((t) => afterCounts[t] !== baselineCounts[t]).map((t) => `${t}: ${baselineCounts[t]} -> ${afterCounts[t]}`);
    ok('จำนวนแถวทุกตารางที่เกี่ยวข้องกลับมาเท่า baseline', drift.length === 0, {
      input: TABLES.join(','),
      expected: TABLES.map((t) => `${t}=${baselineCounts[t]}`).join(','),
      actual: TABLES.map((t) => `${t}=${afterCounts[t]}`).join(','),
      note: drift.length ? drift.join(' | ') : 'no drift',
    });

    const namesNow = new Set(allLogFiles().map((f) => f.split('/').pop()));
    const removed = [...logNamesBefore].filter((n) => !namesNow.has(n));
    const added = [...namesNow].filter((n) => !logNamesBefore.has(n));
    ok('suite ไม่ลบหรือตั้งชื่อไฟล์ log ใหม่ (ไฟล์ที่เพิ่มต้องเป็นชั่วโมงถัดไปเท่านั้น)', removed.length === 0 && added.every((n) => CURRENT_FILE_RE.test(n)), {
      input: 'file-name set diff before/after',
      expected: 'nothing removed, additions are hourly files',
      actual: `removed=${removed.length ? removed.join(',') : 'none'} added=${added.length ? added.join(',') : 'none'}`,
    });
    const shrunk = allLogFiles().filter((f) => logSizesBefore.has(f) && statSync(f).size < logSizesBefore.get(f)).map((f) => f.split('/').pop());
    ok('ไม่มีไฟล์ log ใดหดลง (append-only, suite ไม่ได้ truncate)', shrunk.length === 0, {
      input: `${logSizesBefore.size} files compared with their baseline size`,
      expected: '0 smaller files',
      actual: shrunk.length ? shrunk.join(',') : 'all files equal or larger',
    });
    ok('ไม่ทิ้งไฟล์ probe ไว้ใน scripts/test', !existsSync(PROBE_FILE), {
      input: PROBE_FILE.split('/').pop(),
      expected: 'deleted',
      actual: existsSync(PROBE_FILE) ? 'still present' : 'deleted',
    });
    ok('เซิร์ฟเวอร์ยังปกติหลัง suite จบ', (await api('GET', '/health')).status === 200, {
      input: 'GET /health',
      expected: 200,
      actual: String((await api('GET', '/health')).status),
    });
  } finally {
    for (const t of templateSnapshot) await restoreTemplate(t);
    const ids = suiteUsers.map((u) => u.id);
    if (ids.length) {
      await conn.query('DELETE FROM notification_outbox WHERE userId IN (?)', [ids]);
      await conn.query('DELETE FROM password_reset_tokens WHERE userId IN (?)', [ids]);
      await conn.query('DELETE FROM user_avatars WHERE userId IN (?)', [ids]);
      await conn.query('DELETE FROM users WHERE id IN (?)', [ids]);
    }
    if (existsSync(PROBE_FILE)) unlinkSync(PROBE_FILE);
  }
}
