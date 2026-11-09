#!/usr/bin/env node
// Loads the deterministic simulated dataset into the confirmed test database, then writes
// the independently computed expectations next to it so Stage 3 can diff API output against them.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { buildDataset, TEST_PASSWORD } from './dataset.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'scripts', 'test');
const EXPECTED_DB = 'loan_management';
const SEED = 12345;
const CHUNK = 100;

// Written in dependency order; the loader also disables FK checks while it empties the tables.
const INSERT_ORDER = [
  'users', 'loan_products', 'customers', 'kyc_documents', 'kyc_document_contents', 'loans',
  'financial_transactions', 'financial_transaction_lines', 'payment_requests', 'payment_allocations',
  'settlement_agreements', 'approval_workflows', 'approval_steps', 'customer_credits', 'credit_ledger',
  'user_avatars', 'user_avatar_contents', 'audit_logs',
];
const KEPT_TABLES = ['system_config', 'email_templates'];
// Derived tables the loader fills from the rows above rather than from the deterministic dataset.
// `user_password_history` is what the no-reuse rule reads, so a fresh book needs one row per account.
const DERIVED_TABLES = ['user_password_history'];

const die = (msg) => {
  console.error(`\n[seed] ABORT: ${msg}`);
  process.exit(1);
};

function loadEnv() {
  if (process.env.NODE_ENV === 'production') die('NODE_ENV=production — refusing to seed');
  const envFile = path.join(REPO_ROOT, 'server', '.env');
  if (!fs.existsSync(envFile)) die(`server/.env not found at ${envFile}`);
  dotenv.config({ path: envFile });
  const db = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
  };
  if (!['127.0.0.1', 'localhost', '::1', 'host.docker.internal', 'loan-ms-mysql', 'mysql'].includes(db.host)) {
    die(`DB_HOST=${db.host} is not a local/docker host — refusing to seed`);
  }
  if (db.name !== EXPECTED_DB) die(`DB_NAME=${db.name} but this seeder is locked to ${EXPECTED_DB}`);
  return db;
}

const sqlValue = (v) => {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
};

async function tableColumns(conn, database, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table],
  );
  return rows.map((r) => r.c);
}

async function insertRows(conn, database, table, columns, rows) {
  if (rows.length === 0) return 0;
  const usable = columns.filter((c) => c in rows[0]);
  const list = usable.map((c) => `\`${c}\``).join(', ');
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.flatMap((r) => usable.map((c) => sqlValue(r[c])));
    const placeholders = chunk.map(() => `(${usable.map(() => '?').join(',')})`).join(',');
    await conn.query(`INSERT INTO \`${database}\`.\`${table}\` (${list}) VALUES ${placeholders}`, values);
    written += chunk.length;
  }
  return written;
}

async function main() {
  const db = loadEnv();
  const dataset = buildDataset({ seed: SEED });

  // The rotation gate in Stage D reads `passwordChangedAt`, so the seed owns it: a simulated book
  // carrying the dataset's story dates would have every password past its limit, and the very first
  // login of the very first suite would be refused. Stamping the instant the hash is written is what
  // the application itself does when it creates an account, and it leaves the rule armed at its
  // production default instead of switching it off.
  //
  // Written as UTC text on purpose, like every other DATETIME in the dataset: this connection has no
  // `timezone: 'Z'` (the server datasource does), so a JS Date would be serialised in the machine's
  // own zone and then read back 7 hours ahead of the clock — which revokes every session the server
  // mints, because authMiddleware compares `iat` against `passwordChangedAt`.
  const passwordsSetAt = new Date();
  const passwordsSetAtSql = passwordsSetAt.toISOString().slice(0, 23).replace('T', ' ');
  for (const user of dataset.rows.users) {
    user.passwordHash = bcrypt.hashSync(TEST_PASSWORD, bcrypt.genSaltSync(10));
    user.passwordChangedAt = passwordsSetAtSql;
  }

  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.name,
    multipleStatements: false,
  });
  const [[{ current }]] = await conn.query('SELECT DATABASE() AS current');
  if (current !== EXPECTED_DB) die(`connected to ${String(current)} — expected ${EXPECTED_DB}`);

  const [existing] = await conn.query(
    'SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = \'BASE TABLE\'',
    [db.name],
  );
  const tables = existing.map((r) => r.t);
  const missing = [...INSERT_ORDER, ...DERIVED_TABLES].filter((t) => !tables.includes(t));
  if (missing.length) die(`schema missing tables ${missing.join(', ')} — run: npm run db:migrate -w server`);

  const columnsFor = {};
  for (const t of tables) columnsFor[t] = await tableColumns(conn, db.name, t);

  // users.tenantId is NOT NULL and the unique indexes are per organisation, so every account needs the
  // id the migration seeded rather than an invented one. Read from the DB: this file must keep producing
  // the same book whether the tenant id is ...001 or whatever a rebuilt environment happens to hold.
  if (columnsFor.users?.includes('tenantId')) {
    if (!tables.includes('tenants')) die('users.tenantId exists but the tenants table does not — run: npm run db:migrate -w server');
    const tenantCode = process.env.DEFAULT_TENANT_CODE || 'default';
    const [[tenant]] = await conn.query(`SELECT \`id\` FROM \`${db.name}\`.\`tenants\` WHERE \`code\` = ?`, [tenantCode]);
    if (!tenant) die(`no tenants row for code ${tenantCode} — run: npm run db:migrate -w server`);
    for (const user of dataset.rows.users) user.tenantId = tenant.id;
    console.log(`[seed] tenant ${tenantCode} -> ${dataset.rows.users.length} accounts`);
  }

  console.log(`[seed] database ${db.name} on ${db.host}:${db.port}`);
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of [...INSERT_ORDER, ...DERIVED_TABLES]) await conn.query(`TRUNCATE TABLE \`${db.name}\`.\`${t}\``);
  console.log(`[seed] truncated ${INSERT_ORDER.length + DERIVED_TABLES.length} data tables (kept: ${KEPT_TABLES.join(', ')})`);

  const counts = {};
  for (const t of INSERT_ORDER) {
    const tainted = (dataset.rows[t] ?? []).find((r) => Object.values(r).some((v) => typeof v === 'number' && Number.isNaN(v)));
    if (tainted) die(`dataset produced NaN in table ${t} for row ${JSON.stringify(tainted).slice(0, 200)}`);
    console.log(`[seed] inserting ${t} (${(dataset.rows[t] ?? []).length})`);
    counts[t] = await insertRows(conn, db.name, t, columnsFor[t], dataset.rows[t] ?? []);
  }

  // One history row per seeded account: the no-reuse rule reads this table, and without the first
  // password recorded, going back to the seed password after one change would look legal.
  const history = dataset.rows.users.map((u) => ({
    id: randomUUID(),
    userId: u.id,
    passwordHash: u.passwordHash,
    createdAt: passwordsSetAtSql,
  }));
  counts.user_password_history = await insertRows(conn, db.name, 'user_password_history', columnsFor.user_password_history, history);
  console.log(`[seed] inserting user_password_history (${history.length})`);

  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  const [[{ outstanding }]] = await conn.query(
    `SELECT COALESCE(SUM(currentOutstanding),0) AS outstanding FROM \`${db.name}\`.loans`,
  );
  const dbOutstanding = Number(outstanding).toFixed(2);
  if (dbOutstanding !== dataset.expected.totals.loanBookOutstanding) {
    die(`loan book from DB ${dbOutstanding} != oracle ${dataset.expected.totals.loanBookOutstanding}`);
  }

  const expectedFile = path.join(OUT_DIR, 'expected.json');
  fs.writeFileSync(expectedFile, JSON.stringify(dataset.expected, null, 2));

  const manifest = {
    generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
    seed: SEED,
    referenceNow: dataset.expected.meta.referenceNow,
    database: db.name,
    testPasswordPolicyNote: `all seeded users share the password configured in dataset.mjs; it is not written to this file`,
    passwordRotationNote: `every seeded password is stamped as changed at ${passwordsSetAt.toISOString()} and recorded in user_password_history, so the monthly rotation gate stays armed at its default and still accepts these accounts`,
    testUsers: dataset.rows.users.map((u) => ({
      username: u.username,
      role: u.role,
      email: u.email,
      isActive: u.isActive,
      isEmailVerified: u.isEmailVerified,
      deletedAt: u.deletedAt,
    })),
    tableCounts: counts,
    keptTables: Object.fromEntries(KEPT_TABLES.map((t) => [t, null])),
    loans: Object.fromEntries(Object.entries(dataset.expected.loans).map(([k, v]) => [k, { status: v.status, outstanding: v.outstanding.total, product: v.product }])),
    totals: dataset.expected.totals,
    invariants: dataset.expected.invariant,
  };
  const keptCounts = {};
  for (const t of KEPT_TABLES) {
    const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${db.name}\`.\`${t}\``);
    keptCounts[t] = Number(n);
  }
  manifest.keptTables = keptCounts;

  fs.writeFileSync(path.join(OUT_DIR, 'seed-manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('[seed] inserted rows');
  for (const [t, n] of Object.entries(counts)) console.log(`  ${t.padEnd(30)} ${n}`);
  console.log(`[seed] kept config rows: ${JSON.stringify(keptCounts)}`);
  console.log(`[seed] loan book outstanding ${dbOutstanding} LAK matches the oracle`);
  console.log(`[seed] wrote ${path.relative(REPO_ROOT, expectedFile)} and scripts/test/seed-manifest.json`);
  await conn.end();
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
