#!/usr/bin/env node
// One command that proves the versioned migrations are the schema of record:
//
//   node scripts/test/migration-check.mjs
//
// It builds a scratch database from the migrations only, then compares it, column by column and
// index by index, with the live database the server is connected to. It also asks TypeORM whether
// the entities still match the migrated schema (they must), and checks that reverting the baseline
// refuses to run without the explicit data-loss gate.
//
// Nothing here touches the live database: it is opened read-only, through information_schema.
// The scratch database is created and dropped by this script, and its name is hard-coded.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRATCH_DB = 'loan_migrate_check';
const BOOKKEEPING_TABLE = 'schema_migrations';
const keepScratch = process.argv.includes('--keep');

const die = (msg) => {
  console.error(`\n[migration-check] FAIL: ${msg}`);
  const error = new Error(msg);
  error.guarded = true;
  throw error;
};

const step = (msg) => console.log(`[migration-check] ${msg}`);

function loadEnv() {
  if (process.env.NODE_ENV === 'production') die('NODE_ENV=production -- this check is for a local database');
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
  for (const [k, v] of Object.entries(db)) if (!v) die(`server/.env is missing DB_${k.toUpperCase()}`);
  if (!/^(127\.0\.0\.1|localhost|::1|172\.(1[6-9]|2\d|3[01])\.[0-9.]+|192\.168\.[0-9.]+)$/.test(db.host)) {
    die(`DB_HOST=${db.host} is not local -- the check creates and drops a schema, so it only runs at home`);
  }
  if (db.name === SCRATCH_DB) die(`DB_NAME is already ${SCRATCH_DB}; the check would compare a schema with itself`);
  return db;
}

/** Runs an npm script of the server workspace with the scratch database selected. */
function run(cmd, env = {}) {
  const r = spawnSync(cmd, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: true,
    env: { ...process.env, ...env },
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { code: r.status, out, lines: out.split(/\r?\n/).filter((l) => l.trim().length > 0) };
}

/** Snapshots of the three things that make a schema: tables, their columns, their indexes. */
async function snapshot(conn, schema) {
  const [tables] = await conn.query(
    `SELECT TABLE_NAME t, ENGINE e, TABLE_COLLATION c FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    [schema],
  );
  const [columns] = await conn.query(
    `SELECT TABLE_NAME t, COLUMN_NAME n, COLUMN_TYPE ty, IS_NULLABLE nu, COLUMN_DEFAULT d, EXTRA x,
            CHARACTER_SET_NAME cs, COLLATION_NAME co
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );
  const [indexes] = await conn.query(
    `SELECT TABLE_NAME t, INDEX_NAME n, NON_UNIQUE u, SEQ_IN_INDEX s, COLUMN_NAME c
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  );
  const withoutBookkeeping = (rows) => rows.filter((r) => r.t !== BOOKKEEPING_TABLE);
  return {
    tables: withoutBookkeeping(tables),
    columns: withoutBookkeeping(columns),
    indexes: withoutBookkeeping(indexes),
  };
}

const rowKey = (r, fields) =>
  fields.map((f) => (r[f] === null || r[f] === undefined ? '~' : String(r[f]))).join('|');

function compare(label, migrated, live, fields) {
  const inLive = new Set(live.map((r) => rowKey(r, fields)));
  const inMigrated = new Set(migrated.map((r) => rowKey(r, fields)));
  const onlyMigrated = migrated.filter((r) => !inLive.has(rowKey(r, fields)));
  const onlyLive = live.filter((r) => !inMigrated.has(rowKey(r, fields)));
  const ok = onlyMigrated.length === 0 && onlyLive.length === 0;
  console.log(
    `  ${label.padEnd(9)} migrated=${String(migrated.length).padStart(4)} live=${String(live.length).padStart(4)} ${
      ok ? 'MATCH' : `DIFF (only-migrated=${onlyMigrated.length}, only-live=${onlyLive.length})`
    }`,
  );
  for (const r of onlyMigrated.slice(0, 10)) console.log(`    ONLY IN MIGRATED: ${rowKey(r, fields)}`);
  for (const r of onlyLive.slice(0, 10)) console.log(`    ONLY IN LIVE DB  : ${rowKey(r, fields)}`);
  return ok;
}

async function main() {
  const db = loadEnv();
  let failures = 0;
  const check = (ok, msg) => {
    if (ok) {
      step(`PASS: ${msg}`);
    } else {
      failures += 1;
      step(`FAIL: ${msg}`);
    }
  };

  step(`live database = ${db.name} at ${db.host}:${db.port}, scratch = ${SCRATCH_DB}`);

  const conn = await mysql.createConnection({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
    await conn.query(
      `CREATE DATABASE \`${SCRATCH_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
    step('scratch database recreated (empty)');

    const built = run('npm run build -w server');
    if (built.code !== 0) {
      console.log(built.lines.slice(-15).join('\n'));
      die('npm run build -w server failed; nothing was compared');
    }
    step('server built (migrations run from dist/)');

    const applied = run('npm run db:migrate -w server', { DB_NAME: SCRATCH_DB });
    const okApplied =
      applied.code === 0 &&
      applied.out.includes('Migration BaselineSchema') &&
      applied.out.includes('executed successfully');
    check(okApplied, 'npm run db:migrate created the scratch schema from migrations alone');
    if (!okApplied) console.log(applied.lines.slice(-12).join('\n'));

    const reRun = run('npm run db:migrate -w server', { DB_NAME: SCRATCH_DB });
    check(
      reRun.code === 0 && reRun.out.includes('No migrations are pending'),
      'a second db:migrate is a no-op (idempotent)',
    );

    const [migrated, live] = [await snapshot(conn, SCRATCH_DB), await snapshot(conn, db.name)];
    step(`compare migrated scratch schema with live ${db.name}`);
    const tablesOk = compare('tables', migrated.tables, live.tables, ['t', 'e', 'c']);
    const columnsOk = compare('columns', migrated.columns, live.columns, [
      't',
      'n',
      'ty',
      'nu',
      'd',
      'x',
      'cs',
      'co',
    ]);
    const indexesOk = compare('indexes', migrated.indexes, live.indexes, ['t', 'n', 'u', 's', 'c']);
    check(tablesOk && columnsOk && indexesOk, 'migrations reproduce the live schema exactly');

    const [appliedList] = await conn.query(
      `SELECT s.name scratch_name, l.name live_name FROM
         (SELECT name, timestamp FROM \`${SCRATCH_DB}\`.\`${BOOKKEEPING_TABLE}\`) s
         LEFT JOIN (SELECT name, timestamp FROM \`${db.name}\`.\`${BOOKKEEPING_TABLE}\`) l
           ON l.timestamp = s.timestamp`,
    );
    check(
      appliedList.length > 0 && appliedList.every((r) => r.live_name === r.scratch_name),
      'the live database carries the same applied-migration history',
    );

    const drift = run('npx typeorm -d server/dist/cli-datasource.js schema:log', { DB_NAME: SCRATCH_DB });
    check(
      drift.code === 0 && /up to date/.test(drift.out),
      'entities and migrated schema agree (schema:log finds no pending change)',
    );
    if (!/up to date/.test(drift.out)) console.log(drift.lines.slice(0, 20).join('\n'));

    const countScratchTables = async () => {
      const [rows] = await conn.query(
        `SELECT COUNT(*) n FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME <> ?`,
        [SCRATCH_DB, BOOKKEEPING_TABLE],
      );
      return Number(rows[0].n);
    };
    const [scratchHistory] = await conn.query(
      `SELECT timestamp FROM \`${SCRATCH_DB}\`.\`${BOOKKEEPING_TABLE}\``,
    );
    // One `migration:revert` call unwinds exactly one migration, newest first, so a schema built from
    // N migrations needs N calls before the baseline's data-loss guard is the one being tested.
    const maxRevertCalls = scratchHistory.length + 2;

    let guard = null;
    for (let call = 1; call <= maxRevertCalls; call += 1) {
      const tablesBefore = await countScratchTables();
      const attempt = run('npm run db:migrate:revert -w server', { DB_NAME: SCRATCH_DB });
      if (attempt.out.includes('Refusing to revert the baseline')) {
        guard = { call, tablesBefore, tablesAfter: await countScratchTables() };
        break;
      }
      if (attempt.code !== 0) {
        console.log(attempt.lines.slice(-8).join('\n'));
        die(`ungated revert #${call} failed before the baseline guard was reached`);
      }
    }
    check(guard !== null, 'db:migrate:revert refuses to drop the baseline without the data-loss gate');
    check(
      guard !== null && guard.tablesAfter === guard.tablesBefore && guard.tablesAfter > 0,
      `the refused baseline revert left all ${guard?.tablesAfter ?? 0} tables in place`,
    );

    let gatedCode = 0;
    for (let call = 1; call <= maxRevertCalls; call += 1) {
      const attempt = run('npm run db:migrate:revert -w server', {
        DB_NAME: SCRATCH_DB,
        DB_BASELINE_REVERT: 'I-ACCEPT-DATA-LOSS',
      });
      gatedCode = attempt.code;
      if (attempt.code !== 0) {
        console.log(attempt.lines.slice(-8).join('\n'));
        break;
      }
      if ((await countScratchTables()) === 0) break;
    }
    check(
      gatedCode === 0 && (await countScratchTables()) === 0,
      `the gated revert drops all ${migrated.tables.length} tables (reversible by design)`,
    );

    const rebuilt = run('npm run db:migrate -w server', { DB_NAME: SCRATCH_DB });
    check(rebuilt.code === 0, 'db:migrate rebuilds the schema after a revert');
  } finally {
    if (keepScratch) {
      step(`scratch database kept: ${SCRATCH_DB}`);
    } else {
      await conn.query(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``);
      step('scratch database dropped');
    }
    await conn.end();
  }

  console.log('');
  if (failures > 0) {
    console.log(`[migration-check] RESULT: FAIL (${failures} check group(s) failed)`);
    process.exit(1);
  }
  console.log('[migration-check] RESULT: PASS -- migrations are the schema of record');
}

main().catch((err) => {
  if (!err.guarded) console.error(`[migration-check] aborted: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
