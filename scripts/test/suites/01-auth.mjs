// 3.1 Authentication, token integrity and the role x endpoint matrix.
import { createHmac, randomBytes } from 'node:crypto';
import { JWT_SECRET, USER_NAMES, api, cases, check, errorMessage, login, statusCheck } from '../lib/harness.mjs';



const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const sign = (header, claims, secret) => {
  const head = `${b64(header)}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
};

const ROLE_TOKENS = { ADMIN: 'admin', HEAD_APPROVER: 'head', CHECKER: 'checker1', MAKER: 'op1', VIEWER: 'viewer' };

export default async function suite(ctx) {
  const { tokens, expected } = ctx;
  const CAT = 'auth/authz';
  const loan = Object.values(expected.loans)[0];
  const loanId = loan.loanId;
  const customerId = loan.customerId;

  const list = await ctx.api('GET', '/api/users');
  const byName = Object.fromEntries((list.json.users ?? []).map((u) => [u.username, u]));
  const workflowProbe = await ctx.api('GET', '/api/approvals/pending?limit=1');
  const anyWorkflowId = workflowProbe.json.data?.[0]?.workflowId ?? '';

  // ------------------------------------------------------------------ login
  for (const [role, key] of Object.entries(ROLE_TOKENS)) {
    const res = await login(USER_NAMES[key]);
    statusCheck(CAT, `login ${role} ด้วยรหัสผ่านถูกต้องได้ token`, res, 200, {
      input: USER_NAMES[key],
      note: `role ใน payload ต้องเป็น ${role}`,
    });
    check(CAT, `login ${role}: body มี token + user.role ตรงตามบทบาท`, {
      input: USER_NAMES[key],
      expected: { role, token: true },
      actual: { role: res.json?.user?.role, token: !!res.json?.token },
      pass: res.json?.user?.role === role && !!res.json?.token,
    });
  }

  const wrong = await login(USER_NAMES.admin, 'WrongPassword123');
  statusCheck(CAT, 'login รหัสผ่านผิด → 401 Invalid credentials', wrong, 401, { input: 'test_admin / wrong', messageIncludes: 'Invalid credentials' });

  const unknown = await login('test_nonexistent', 'Tst@2026#a');
  statusCheck(CAT, 'login ผู้ใช้ไม่มีจริง → 401 ข้อความเดียวกับรหัสผ่านผิด (กัน enumeration)', unknown, 401, {
    input: 'test_nonexistent',
    messageIncludes: 'Invalid credentials',
    note: errorMessage(unknown) === errorMessage(wrong) ? 'ข้อความตรงกับกรณีรหัสผ่านผิด' : 'ข้อความไม่เหมือนกัน → เปิดช่อง enumeration',
  });

  const disabled = await login(USER_NAMES.disabled, 'Tst@2026#a');
  statusCheck(CAT, 'login ผู้ใช้ที่ถูกปิดใช้งาน → 401', disabled, 401, { input: 'test_disabled', messageIncludes: 'Invalid credentials' });

  const deleted = await login(USER_NAMES.deleted, 'Tst@2026#a');
  statusCheck(CAT, 'login ผู้ใช้ที่ soft-delete → 401', deleted, 401, { input: 'test_deleted', messageIncludes: 'Invalid credentials' });

  const noBody = await api('POST', '/api/auth/login', { body: {} });
  statusCheck(CAT, 'login โดยไม่ส่ง username/password → 400 Validation failed', noBody, 400, { messageIncludes: 'Validation failed' });

  const me = await api('GET', '/api/auth/me', { token: tokens.admin });
  statusCheck(CAT, 'GET /api/auth/me พร้อม token → 200', me, 200);
  check(CAT, 'GET /api/auth/me คืนข้อมูลตรงกับผู้ใช้', {
    input: 'test_admin',
    expected: { username: USER_NAMES.admin, role: 'ADMIN' },
    actual: { username: me.json?.user?.username, role: me.json?.user?.role },
    pass: me.json?.user?.username === USER_NAMES.admin && me.json?.user?.role === 'ADMIN',
  });

  // ------------------------------------------------------------------ token integrity
  const forgedSecret = sign({ alg: 'HS256', typ: 'JWT' }, { id: randomBytes(8).toString('hex'), username: 'test_admin', fullName: 'Forged', role: 'ADMIN' }, 'not-the-real-secret');
  const forged = await api('GET', '/api/loans', { token: forgedSecret });
  statusCheck(CAT, 'token ที่เซ็นด้วย secret อื่น → 401', forged, 401, { messageIncludes: 'Invalid or expired token' });

  const forgedAdmin = sign({ alg: 'HS256', typ: 'JWT' }, { id: byName.test_view1?.id, username: 'test_view1', fullName: 'Escalated', role: 'ADMIN' }, 'wrong');
  const esc = await api('GET', '/api/users', { token: forgedAdmin });
  statusCheck(CAT, 'ปลอม role=ADMIN ใน token → 401 (ไม่ได้สิทธิ์)', esc, 401);

  const expired = sign({ alg: 'HS256', typ: 'JWT' }, { id: byName.test_admin?.id, username: 'test_admin', fullName: 'X', role: 'ADMIN', exp: Math.floor(Date.now() / 1000) - 3600 }, JWT_SECRET);
  const expiredRes = await api('GET', '/api/loans', { token: expired });
  statusCheck(CAT, 'token หมดอายุ (ต่อ secret ถูก) → 401', expiredRes, 401, { messageIncludes: 'Invalid or expired token' });

  const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: 'x', username: 'test_admin', role: 'ADMIN' })}.`;
  const noneRes = await api('GET', '/api/loans', { token: unsigned });
  statusCheck(CAT, 'token alg=none ไม่มีลายเซ็น → 401', noneRes, 401);

  const missing = await api('GET', '/api/loans');
  statusCheck(CAT, 'เรียก API โดยไม่มี header → 401 Missing bearer token', missing, 401, { messageIncludes: 'Missing bearer token' });

  const garbage = await api('GET', '/api/loans', { token: 'abc' });
  statusCheck(CAT, 'tokenรูปแบบไม่ถูกต้อง → 401', garbage, 401);

  const health = await api('GET', '/health');
  statusCheck(CAT, 'GET /health public → 200', health, 200);
  const policy = await api('GET', '/api/auth/password-policy');
  statusCheck(CAT, 'GET /api/auth/password-policy public → 200', policy, 200);

  // ------------------------------------------------------------------ role x endpoint matrix
  // Read endpoints: every signed-in role may read them (ADMIN/HEAD/CHECKER/MAKER/VIEWER → 200).
  const reads = [
    ['GET', `/api/customers`, 'customers list'],
    ['GET', `/api/loan-products`, 'loan products list'],
    ['GET', `/api/loans`, 'loans list'],
    ['GET', `/api/loans/${loanId}`, 'loan detail'],
    ['GET', `/api/loans/${loanId}/schedule`, 'loan schedule'],
    ['GET', `/api/loans/${loanId}/allocation-preview?amount=100000`, 'allocation preview'],
    ['GET', `/api/customers/${customerId}/kyc/documents`, 'KYC documents'],
    ['GET', `/api/payment-requests`, 'payment requests'],
    ['GET', `/api/payment-requests/pending-count`, 'payment pending count'],
    ['GET', `/api/transactions`, 'transactions'],
    ['GET', `/api/settlements`, 'settlements'],
    ['GET', `/api/credits`, 'customer credits'],
    ['GET', `/api/credits/ledger?customerId=${customerId}`, 'credit ledger'],
    ['GET', `/api/reconciliation/records`, 'reconciliation records'],
    ['GET', `/api/audit`, 'audit log'],
    ['GET', `/api/dashboard/stats`, 'dashboard stats'],
    ['GET', `/api/dashboard/recent-activity`, 'dashboard activity'],
    ['GET', `/api/notifications/summary`, 'notification summary'],
    ['GET', `/api/config/thresholds`, 'thresholds config'],
    ['GET', `/api/config/kyc`, 'kyc config'],
    ['GET', `/api/config/password`, 'password config'],
    ['GET', `/api/config/avatar`, 'avatar config'],
  ];
  if (anyWorkflowId) reads.push(['GET', `/api/approvals/workflows/${anyWorkflowId}`, 'approval workflow detail']);

  for (const [method, path, label] of reads) {
    for (const [role, key] of Object.entries(ROLE_TOKENS)) {
      const res = await api(method, path, { token: tokens[key] });
      check(CAT, `RBAC อ่าน ${label} ด้วย ${role}`, {
        input: `${method} ${path}`,
        expected: 200,
        actual: `HTTP ${res.status} ${res.status === 200 ? '' : errorMessage(res)}`,
        pass: res.status === 200,
      });
    }
    const anon = await api(method, path);
    check(CAT, `RBAC อ่าน ${label} ไม่ส่ง token → 401`, { input: path, expected: 401, actual: `HTTP ${anon.status}`, pass: anon.status === 401 });
  }

  const adminOnly = [
    ['GET', '/api/users', 'users list'],
    ['GET', '/api/notifications', 'notification outbox'],
    ['GET', '/api/notifications/templates', 'email templates'],
  ];
  for (const [method, path, label] of adminOnly) {
    for (const [role, key] of Object.entries(ROLE_TOKENS)) {
      const res = await api(method, path, { token: tokens[key] });
      const ok = role === 'ADMIN' ? res.status === 200 : res.status === 403;
      check(CAT, `RBAC ${label} → ${role === 'ADMIN' ? '200 เฉพาะ ADMIN' : '403'}`, {
        input: path,
        expected: role === 'ADMIN' ? 200 : '403 Requires role: ADMIN',
        actual: `HTTP ${res.status} ${errorMessage(res)}`,
        pass: ok,
      });
    }
  }

  const report = [['GET', '/api/reports/monthly?months=6', 'monthly report']];
  for (const [method, path, label] of report) {
    for (const [role, key] of Object.entries(ROLE_TOKENS)) {
      const res = await api(method, path, { token: tokens[key] });
      const allow = role === 'ADMIN' || role === 'HEAD_APPROVER';
      check(CAT, `RBAC ${label} → ${role}`, {
        input: path,
        expected: allow ? 200 : '403 Requires role: ADMIN or HEAD_APPROVER',
        actual: `HTTP ${res.status} ${errorMessage(res)}`,
        pass: res.status === (allow ? 200 : 403),
      });
    }
  }

  const reviewOnly = [['GET', '/api/approvals/pending', 'approval queue']];
  for (const [, path, label] of reviewOnly) {
    for (const [role, key] of Object.entries(ROLE_TOKENS)) {
      const res = await api('GET', path, { token: tokens[key] });
      const allow = ['CHECKER', 'HEAD_APPROVER', 'ADMIN'].includes(role);
      check(CAT, `RBAC ${label} → ${role}`, {
        input: path,
        expected: allow ? 200 : '403 Requires role: CHECKER or HEAD_APPROVER or ADMIN',
        actual: `HTTP ${res.status} ${errorMessage(res)}`,
        pass: res.status === (allow ? 200 : 403),
      });
    }
  }

  // Write endpoints: body {} fails zod validation (400) for allowed roles and is refused with
  // 403 before touching the database for VIEWER — so the matrix cannot create rows.
  const writes = [
    ['POST', '/api/customers', 'create customer', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', '/api/loan-products', 'create product', ['ADMIN']],
    ['PATCH', '/api/loan-products/00000000-0000-4000-8000-000000000001', 'patch product', ['ADMIN'], { interestRatePeriod: 'FORTNIGHT' }],
    ['POST', '/api/loans', 'create loan + disburse', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', '/api/payment-requests', 'create payment request', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/payment-requests/00000000-5000-4000-8000-000000000001/approve`, 'approve payment request', ['CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/penalties`, 'accrue penalty', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/waivers`, 'waive', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/write-offs`, 'write off', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/adjustments`, 'adjust', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/reversals`, 'payment reversal', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/transactions/write-off-reversals`, 'write-off reversal', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/settlements`, 'settlement agreement', ['MAKER', 'CHECKER', 'HEAD_APPROVER', 'ADMIN']],
    ['POST', `/api/users`, 'create user', ['ADMIN']],
    ['PUT', `/api/config/thresholds`, 'set thresholds', ['ADMIN']],
    ['PUT', `/api/config/kyc`, 'set kyc policy', ['ADMIN']],
    ['PUT', `/api/config/password`, 'set password policy', ['ADMIN']],
    ['PUT', `/api/config/avatar`, 'set avatar policy', ['ADMIN']],
    ['POST', `/api/users/00000000-9000-4000-8000-000000000001/restore`, 'restore user', ['ADMIN']],
    ['POST', `/api/users/00000000-9000-4000-8000-000000000001/send-reset-link`, 'send reset link', ['ADMIN']],
    ['POST', `/api/users/send-reset-links`, 'bulk reset links', ['ADMIN']],
    ['PATCH', `/api/users/00000000-9000-4000-8000-000000000001`, 'patch user', ['ADMIN']],
    ['DELETE', `/api/users/00000000-9000-4000-8000-000000000001`, 'soft delete user', ['ADMIN']],
    ['POST', `/api/notifications/00000000-9000-4000-8000-000000000001/requeue`, 'requeue notification', ['ADMIN']],
  ];
  for (const entry of writes) {
    const [method, path, label, allowed, body] = entry;
    for (const [role, key] of Object.entries(ROLE_TOKENS)) {
      const res = await api(method, path, { token: tokens[key], body: body ?? {} });
      const may = allowed.includes(role);
      // A role that is allowed must get past the guard (validation/business status), a role that
      // is not allowed must be refused with 403 before anything else happens.
      const pass = may ? res.status !== 403 && res.status < 500 : res.status === 403;
      check(CAT, `RBAC เขียน ${label} → ${role}`, {
        input: `${method} ${path} body ${JSON.stringify(body ?? {})}`,
        expected: may ? 'not 403 (ผ่านด่าน role แล้ว, ไม่มี 5xx)' : '403 Requires role',
        actual: `HTTP ${res.status} ${errorMessage(res)}`,
        pass,
      });
    }
  }

  // KYC review roles
  for (const [role, key] of Object.entries(ROLE_TOKENS)) {
    const res = await api('POST', `/api/customers/${customerId}/kyc/verify`, { token: tokens[key], body: {} });
    const may = ['CHECKER', 'HEAD_APPROVER', 'ADMIN'].includes(role);
    check(CAT, `RBAC KYC verify → ${role}`, {
      input: `POST kyc/verify`,
      expected: may ? 'not 403 (KYC รายนี้ VERIFIED แล้ว จึงตอบ 422 แทน — ไม่แก้ข้อมูล)' : '403 Requires role',
      actual: `HTTP ${res.status} ${errorMessage(res)}`,
      pass: may ? res.status !== 403 && res.status < 500 : res.status === 403,
    });
  }

  check(CAT, 'ไม่มี endpoint ไหนใน matrix ตอบ 500', {
    input: `${reads.length + adminOnly.length + writes.length} probes`,
    expected: 'no 5xx',
    actual: cases.filter((c) => c.category === 'auth/authz' && /HTTP 5\d\d/.test(c.actual)).length + ' responses were 5xx',
    pass: !cases.some((c) => c.category === 'auth/authz' && /HTTP 5\d\d/.test(c.actual)),
  });
}
