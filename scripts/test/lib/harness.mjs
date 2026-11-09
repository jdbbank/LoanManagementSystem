// Shared harness for the pre-production HTTP test run.
// Everything here talks to the running server over real HTTP (plus a read-only DB probe used
// only for checks the API intentionally does not expose, such as "secrets are stored hashed").
import { readFileSync } from 'node:fs';
import { createDecipheriv, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4000';
export const PASSWORD = process.env.TEST_PASSWORD ?? 'Tst@2026#a';

export const expected = JSON.parse(readFileSync(`${HERE}../expected.json`, 'utf8'));

function envFile() {
  const text = readFileSync(`${ROOT}server/.env`, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export const SERVER_ENV = envFile();
export const JWT_SECRET = process.env.JWT_SECRET ?? SERVER_ENV.JWT_SECRET;

// The outbox stores its content sealed with AES-256-GCM. The suites open it with the same key to
// prove the mailer still gets a usable message while the table holds no plain text.
const SEAL_PREFIX = 'sealed:v1:';
const SEAL_KEY = createHash('sha256')
  .update(process.env.NOTIFY_SECRET_KEY ?? SERVER_ENV.NOTIFY_SECRET_KEY ?? 'change-me-in-production-notify-sealing-key')
  .digest();

export const isSealed = (value) => typeof value === 'string' && value.startsWith(SEAL_PREFIX);

export function unseal(value) {
  if (typeof value !== 'string' || !isSealed(value)) return value;
  const [iv, tag, data] = value.slice(SEAL_PREFIX.length).split('.');
  const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/**
 * `enqueueNotification` seals the payload of EVERY event type, not only the reset secrets, so a
 * payload read has to open it here: `JSON_EXTRACT(payload, '$.x')` on `sealed:v1:` text is not valid
 * JSON and quietly returns NULL, which turns a payload assertion into a comparison of nulls.
 */
export const payloadOf = (row) => {
  try {
    return JSON.parse(unseal(String(row?.payload ?? '')));
  } catch {
    return {};
  }
};

// --------------------------------------------------------------------------- HTTP
export async function api(method, path, { token, body, form, headers, binary = false } = {}) {
  const h = { ...(headers ?? {}) };
  if (token) h.authorization = `Bearer ${token}`;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload });
  if (binary) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { status: res.status, json: null, headers: Object.fromEntries(res.headers.entries()), text: '', buffer };
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: Object.fromEntries(res.headers.entries()), text };
}

export const errorMessage = (res) => res.json?.error?.message ?? JSON.stringify(res.json ?? res.text).slice(0, 120);

export const login = (username, password = PASSWORD) =>
  api('POST', '/api/auth/login', { body: { username, password } });

export async function tokenFor(username, password = PASSWORD) {
  const res = await login(username, password);
  if (res.status !== 200 || !res.json.token) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.json.token;
}

// ------------------------------------------------------------------------ results
export const cases = [];

export function check(cat, name, { input, expected: exp, actual: act, pass, note }) {
  const rec = {
    id: `E2E-${String(cases.length + 1).padStart(3, '0')}`,
    category: cat,
    name,
    input: typeof input === 'string' ? input : JSON.stringify(input),
    expected: typeof exp === 'string' ? exp : JSON.stringify(exp),
    actual: typeof act === 'string' ? act : JSON.stringify(act),
    pass: !!pass,
    note: note ?? '',
  };
  cases.push(rec);
  return rec;
}

/** Records a status + optional error-message assertion for one API call. */
export function statusCheck(cat, name, res, expStatus, { input, messageIncludes, note } = {}) {
  let pass = res.status === expStatus;
  let actual = `HTTP ${res.status}`;
  if (pass && messageIncludes) {
    const msg = errorMessage(res);
    pass = msg.includes(messageIncludes);
    actual = `HTTP ${res.status} ${msg}`;
    if (!pass && res.status === expStatus) actual += ` (message lacks "${messageIncludes}")`;
  } else if (!pass) {
    actual = `HTTP ${res.status} ${errorMessage(res)}`;
  }
  return check(cat, name, { input, expected: expStatus, actual, pass, note });
}

export const eqMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

export function moneyCheck(cat, name, actualValue, expectedValue, { input, note }) {
  return check(cat, name, {
    input,
    expected: Number(expectedValue).toFixed(2),
    actual: Number(actualValue ?? NaN).toFixed(2),
    pass: eqMoney(actualValue, expectedValue),
    note,
  });
}

export function summary() {
  const byCat = {};
  for (const c of cases) {
    const b = (byCat[c.category] ??= { pass: 0, fail: 0 });
    b[c.pass ? 'pass' : 'fail'] += 1;
  }
  return { total: cases.length, byCat, failures: cases.filter((c) => !c.pass) };
}

// --------------------------------------------------------------------- DB probe (read only)
export async function openDb() {
  const env = SERVER_ENV;
  return mysql.createConnection({
    host: env.DB_HOST ?? '127.0.0.1',
    port: Number(env.DB_PORT ?? 3307),
    user: env.DB_USER ?? 'root',
    password: env.DB_PASSWORD,
    database: env.DB_NAME ?? 'loan_management',
  });
}

export const rows = (conn, sql, params) => conn.query(sql, params).then(([r]) => r);

/**
 * Reads a login token's claims without verifying it — the suites already trust the secret, they
 * need the exact mint instant to pin the revocation boundary against `passwordChangedAt`.
 */
export const jwtClaims = (token) => {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return {};
  }
};

/** MySQL DATETIME text in UTC, milliseconds kept, for a suite that writes an exact instant. */
export const utcSql = (millis) => new Date(millis).toISOString().slice(0, 23).replace('T', ' ');

/**
 * Gives in-flight server work a beat to land before a cleanup check. Side effects such as
 * outbox rows and audit trails can commit just after the response returns, and a purge that
 * runs too early then leaves rows behind that the row-count check reports as suite dirt.
 */
export const settle = (ms = 1500) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `system_config` deliberately survives reset-db, so nothing may assume the policy its cases were
 * written against — an earlier suite, or a branch's own admin, can have narrowed it. Pin the listed
 * namespaces to the shipped defaults the server itself reports and hand back the values that were live
 * before pinning plus a `restore()` (idempotent) that puts them back.
 *
 * The defaults come from the API rather than the test files on purpose: a second copy of the shipped
 * numbers here would rot the day `server/src/config/env.ts` changes. Approval thresholds are excluded —
 * the server publishes no defaults for them, so pinning them would mean hard-coding product values.
 */
export async function pinPolicies(callApi, namespaces) {
  const pins = [];
  try {
    for (const namespace of namespaces) {
      const view = (await callApi('GET', `/api/config/${namespace}`)).json?.data;
      if (!view?.defaults) throw new Error(`GET /api/config/${namespace} returned no defaults`);
      const pinned = await callApi('PUT', `/api/config/${namespace}`, { body: view.defaults });
      if (pinned.status !== 200) {
        throw new Error(`pinning ${namespace} to its defaults failed: HTTP ${pinned.status} ${errorMessage(pinned)}`);
      }
      pins.push({ namespace, defaults: view.defaults, found: view.policy });
    }
  } catch (err) {
    await restorePins(callApi, pins);
    throw err;
  }
  return {
    defaults: Object.fromEntries(pins.map((p) => [p.namespace, p.defaults])),
    found: Object.fromEntries(pins.map((p) => [p.namespace, p.found])),
    restore: () => restorePins(callApi, pins),
  };
}

const restorePins = (callApi, pins) =>
  Promise.all(
    pins
      .splice(0)
      .reverse()
      .map((p) => callApi('PUT', `/api/config/${p.namespace}`, { body: p.found })),
  );

/** Runs `body(defaults)` with every listed namespace pinned, restoring even if a case throws. */
export async function withPinnedPolicies(callApi, namespaces, body) {
  const pins = await pinPolicies(callApi, namespaces);
  try {
    return await body(pins.defaults);
  } finally {
    await pins.restore();
  }
}

// --------------------------------------------------------------------- identity map
export const USER_NAMES = {
  admin: 'test_admin',
  head: 'test_head',
  checker1: 'test_checker1',
  checker2: 'test_checker2',
  op1: 'test_op1',
  op2: 'test_op2',
  viewer: 'test_view1',
  disabled: 'test_disabled',
  noemail: 'test_noemail',
  unverified: 'test_unverified',
  deleted: 'test_deleted',
};

/** Logs in every usable account once and caches the tokens on the context. */
export async function buildContext() {
  const tokens = {};
  for (const [key, username] of Object.entries(USER_NAMES)) {
    if (['disabled', 'deleted'].includes(key)) continue;
    tokens[key] = await tokenFor(username);
  }
  const conn = await openDb();
  const call = (method, path, opts = {}) => api(method, path, { ...opts, token: opts.token ?? tokens.admin });
  return { tokens, conn, api: call, expected, base: BASE };
}
