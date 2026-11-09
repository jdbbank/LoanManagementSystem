#!/usr/bin/env node
// Destructive helper for the pre-production test run. Truncates data rows only:
// the table layout belongs to the migrations in server/src/migrations, so DDL is
// never touched here — an empty schema is fixed with `npm run db:migrate -w server`.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Overridable only so the guard branches can be exercised against a scratch dir.
const BACKUP_DIR = process.env.LOAN_BACKUP_DIR
  ? path.resolve(process.env.LOAN_BACKUP_DIR)
  : path.join(REPO_ROOT, 'backups');

// Name the operator confirmed for this test run. Anything else must abort.
const EXPECTED_DB = 'loan_management';
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', 'host.docker.internal', 'loan-ms-mysql', 'mysql']);
/**
 * Never truncated, not even with --wipe-config. This table is not data: it is the record of which
 * migrations built the layout that is still sitting in the schema. Empty it and `db:migrate` reads the
 * existing tables as unbuilt, replays BaselineSchema's CREATE TABLE against them and fails.
 */
const SCHEMA_BOOKKEEPING = ['schema_migrations'];
/** Policy rows the reset keeps unless the operator asks for a full wipe; the server reseeds them. */
const CONFIG_TABLES = ['system_config', 'email_templates'];
/**
 * The organisation rows `users.tenantId` points at. Written by a migration, not by data loading, and
 * never re-created by anything that runs after a reset — so wiping them would leave the server with no
 * tenant to resolve and every sign-in answering 503. Kept even under --wipe-config for the same reason
 * `schema_migrations` is kept: this is bookkeeping the schema depends on, not data.
 */
const TENANT_TABLES = ['tenants'];
const MAX_BACKUP_AGE_MS = 30 * 60 * 1000;

const die = (msg) => {
  console.error(`\n[reset-db] ABORT: ${msg}`);
  process.exit(1);
};

const flagValue = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const has = (name) => process.argv.includes(`--${name}`);
const isLocalhostHost = (host) =>
  ALLOWED_HOSTS.has(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^192\.168\./.test(host);

function loadEnv() {
  if (process.env.NODE_ENV === 'production') die('NODE_ENV=production — refusing to wipe');
  const envFile = path.join(REPO_ROOT, 'server', '.env');
  if (!fs.existsSync(envFile)) die(`server/.env not found at ${envFile}`);
  // Real shell env wins over the file, matching how server/src/config/env.ts loads.
  dotenv.config({ path: envFile });
  const db = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    name: process.env.DB_NAME,
  };
  for (const [k, v] of Object.entries(db)) if (!v) die(`server/.env is missing DB_${k.toUpperCase()}`);
  return db;
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_DIR)) return undefined;
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0];
}

async function assertServerStopped(db) {
  const port = Number(process.env.PORT ?? 4000);
  for (const p of ['/health', '/api/health']) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${p}`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        console.warn(`[reset-db] WARNING: backend answers ${p} on port ${port}; truncate runs while it is live.`);
        return;
      }
    } catch {
      /* nothing listening — expected */
    }
  }
  console.log('[reset-db] no backend responding on port ' + port + ' — safe to truncate.');
}

async function main() {
  const db = loadEnv();

  if (!isLocalhostHost(db.host)) die(`DB_HOST=${db.host} is not a local/docker host — refusing to wipe`);
  if (db.name !== EXPECTED_DB) die(`DB_NAME=${db.name} but this script is locked to ${EXPECTED_DB}`);
  if (process.env.TEST_DB_NAME && process.env.TEST_DB_NAME !== EXPECTED_DB) {
    die(`TEST_DB_NAME=${process.env.TEST_DB_NAME} does not match the confirmed database ${EXPECTED_DB}`);
  }
  if (!has(`confirm-${EXPECTED_DB}`)) {
    die(`missing required flag --confirm-${EXPECTED_DB} (the confirmation gate for this run)`);
  }

  const backup = latestBackup();
  if (!backup) die(`no .sql dump found in ${BACKUP_DIR} — run a mysqldump backup first`);
  const age = Date.now() - backup.t;
  if (age > MAX_BACKUP_AGE_MS) {
    die(`newest backup ${backup.f} is ${Math.round(age / 60000)} min old (limit ${MAX_BACKUP_AGE_MS / 60000} min)`);
  }
  console.log(
    `[reset-db] backup guard satisfied: ${path.relative(REPO_ROOT, BACKUP_DIR)}\\${backup.f} (${Math.round(age / 1000)}s old)`,
  );

  const wipeConfig = has('wipe-config');
  const skip = [...SCHEMA_BOOKKEEPING, ...TENANT_TABLES, ...(wipeConfig ? [] : CONFIG_TABLES)];

  await assertServerStopped(db);

  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.name,
    multipleStatements: false,
  });

  try {
    const [[{ current }]] = await conn.query('SELECT DATABASE() AS current');
    if (current !== EXPECTED_DB) die(`connected to ${String(current)} — expected ${EXPECTED_DB}`);

    const [rows] = await conn.query(
      `SELECT TABLE_NAME AS t FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
      [db.name],
    );
    if (rows.length === 0) die(`database ${db.name} has no base tables — run: npm run db:migrate -w server`);

    const targets = rows.map((r) => r.t).filter((t) => !skip.includes(t));
    const kept = rows.map((r) => r.t).filter((t) => skip.includes(t));
    for (const t of targets) if (!/^[a-z_]{2,64}$/.test(t)) die(`unexpected table name ${t}`);

    const [[{ rowsBefore }]] = await conn.query(
      `SELECT COALESCE(SUM(TABLE_ROWS),0) AS rowsBefore FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_TYPE='BASE TABLE'`,
      [db.name],
    );

    console.log(`[reset-db] target=${db.name} tables=${rows.length} truncate=${targets.length} keep=${kept.join(',') || 'none'}`);
    console.log(`[reset-db] approximate rows before: ${rowsBefore}`);

    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of targets) await conn.query(`TRUNCATE TABLE \`${db.name}\`.\`${t}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    console.log('[reset-db] verification (exact COUNT(*))');
    const leftovers = [];
    for (const t of targets) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${db.name}\`.\`${t}\``);
      if (Number(n) > 0) leftovers.push(`${t}=${n}`);
      console.log(`  ${t.padEnd(32)} ${Number(n) === 0 ? 'EMPTY' : n + ' rows'}`);
    }
    for (const t of kept) {
      const [[{ n }]] = await conn.query(`SELECT COUNT(*) AS n FROM \`${db.name}\`.\`${t}\``);
      console.log(`  ${t.padEnd(32)} KEPT (${n} rows)`);
    }
    if (leftovers.length > 0) die(`tables still non-empty after truncate: ${leftovers.join(', ')}`);
    console.log(`[reset-db] DONE: truncated ${targets.length} tables in ${db.name}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));
