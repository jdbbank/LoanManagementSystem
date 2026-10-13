#!/usr/bin/env node
// One command for the whole pre-production test run:
//   oracle self-test -> mysqldump backup -> guarded wipe -> deterministic seed -> all HTTP suites
// Deliberately does NOT start or stop the backend: the operator owns that process (see README),
// because a server booted with SEED_ON_BOOT=true would mix demo rows into the seeded book.
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const BASE = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4000';

const STEPS = [
  ['1/5 oracle self-test', ['oracle-selftest.mjs'], []],
  ['2/5 database backup', ['backup-test-db.mjs'], []],
  ['3/5 wipe test database', ['reset-db.mjs', '--confirm-loan_management'], []],
  ['4/5 seed simulated dataset', ['seed-test-data.mjs'], []],
  ['5/5 HTTP suites 01-15', ['run-e2e.mjs'], process.argv.slice(2)],
];

const line = (s) => console.log(`\n=== ${s}`);

const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
if (!health?.ok) {
  console.error(`\n[full] ABORT: backend not answering ${BASE}/health (HTTP ${health ? health.status : 'no response'})`);
  console.error('[full] start it first: set SEED_ON_BOOT=false in server/.env, then  npm run dev:server');
  console.error('[full] nothing was wiped and nothing was seeded.');
  process.exit(1);
}
console.log(`[full] backend is live at ${BASE}`);

for (const [label, script, extra] of STEPS) {
  line(`${label} — node scripts/test/${script[0]}`);
  const r = spawnSync(process.execPath, [path.join(HERE, script[0]), ...extra], { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
  if (r.error) {
    console.error(`[full] FAILED to start ${script[0]}: ${r.error.message}`);
    process.exit(1);
  }
  // run-e2e exits 2 when at least one case failed — that is a recorded finding, not a crash.
  const okCode = script[0] === 'run-e2e.mjs' ? r.status === 0 || r.status === 2 : r.status === 0;
  if (!okCode) {
    console.error(`\n[full] STOP: ${label} exited ${r.status}. Later steps did not run.`);
    process.exit(r.status ?? 1);
  }
  if (r.status === 2) {
    line('DONE with findings');
    console.log('[full] some cases failed on purpose (see scripts/test/results.json — เปิดด้วย editor เพื่อดูข้อความไทย)');
    process.exit(2);
  }
}
line('DONE — every case passed');
