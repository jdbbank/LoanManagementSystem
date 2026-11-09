#!/usr/bin/env node
// One command for the whole pre-production test run:
//   oracle self-test -> mysqldump backup -> guarded wipe -> deterministic seed -> all HTTP suites -> case appendix
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
  ['1/6 oracle self-test', ['oracle-selftest.mjs'], []],
  ['2/6 database backup', ['backup-test-db.mjs'], []],
  ['3/6 wipe test database', ['reset-db.mjs', '--confirm-loan_management'], []],
  ['4/6 seed simulated dataset', ['seed-test-data.mjs'], []],
  ['5/6 HTTP suites 01-19', ['run-e2e.mjs'], process.argv.slice(2)],
  ['6/6 case appendix TEST-REPORT-CASES.md', ['report.mjs'], []],
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

let suiteStatus = 0;
for (const [label, [scriptFile, ...scriptArgs], extra] of STEPS) {
  line(`${label} — node scripts/test/${scriptFile}`);
  const r = spawnSync(process.execPath, [path.join(HERE, scriptFile), ...scriptArgs, ...extra], { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
  if (r.error) {
    console.error(`[full] FAILED to start ${scriptFile}: ${r.error.message}`);
    process.exit(1);
  }
  // run-e2e exits 2 when at least one case failed — that is a recorded finding, not a crash,
  // and the appendix still has to be written before the run is allowed to end.
  const okCode = scriptFile === 'run-e2e.mjs' ? r.status === 0 || r.status === 2 : r.status === 0;
  if (!okCode) {
    console.error(`\n[full] STOP: ${label} exited ${r.status}. Later steps did not run.`);
    process.exit(r.status ?? 1);
  }
  if (scriptFile === 'run-e2e.mjs') suiteStatus = r.status;
}
if (suiteStatus === 2) {
  line('DONE with findings');
  console.log('[full] some cases failed on purpose (see scripts/test/results.json — เปิดด้วย editor เพื่อดูข้อความไทย)');
  console.log('[full] the failing cases are listed with evidence in TEST-REPORT.md');
  process.exit(2);
}
line('DONE — every case passed');
