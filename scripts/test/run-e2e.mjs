// Runs the whole pre-production HTTP suite against a live server and writes results.json.
// Console output stays ASCII-only (Windows cp1252 console); the Thai case text lives in results.json.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BASE, api, buildContext, cases, summary } from './lib/harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const SUITES = [
  ['01-auth', './suites/01-auth.mjs'],
  ['02-forgot-password', './suites/02-forgot-password.mjs'],
  ['03-users', './suites/03-users.mjs'],
  ['04-kyc', './suites/04-kyc.mjs'],
  ['05-loans', './suites/05-loans.mjs'],
  ['06-payments', './suites/06-payments.mjs'],
  ['07-posting', './suites/07-posting.mjs'],
  ['08-settlement', './suites/08-settlement.mjs'],
  ['09-reconciliation', './suites/09-reconciliation.mjs'],
  ['10-reports', './suites/10-reports.mjs'],
  ['11-notifications', './suites/11-notifications.mjs'],
  ['12-logger', './suites/12-logger.mjs'],
  ['13-config', './suites/13-config.mjs'],
  ['14-concurrency', './suites/14-concurrency.mjs'],
  ['15-invariants', './suites/15-invariants.mjs'],
];

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const health = await api('GET', '/health');
if (health.status !== 200) {
  console.error(`server not reachable at ${BASE} (HTTP ${health.status}) — start it with SEED_ON_BOOT=false`);
  process.exit(1);
}

const ctx = await buildContext();
const loaded = [];
for (const [name, spec] of SUITES) {
  if (only.length && !only.includes(name)) continue;
  const mod = await import(spec);
  loaded.push([name, mod]);
}

let index = 0;
for (const [name, mod] of loaded) {
  const before = cases.length;
  try {
    await mod.default(ctx);
  } catch (err) {
    console.log(`${name}: THREW ${String(err?.message ?? err).slice(0, 200)}`);
    cases.push({
      id: `E2E-${String(cases.length + 1).padStart(3, '0')}`,
      category: name,
      name: `suite crashed: ${String(err?.message ?? err).slice(0, 200)}`,
      input: '-',
      expected: 'suite completes',
      actual: String(err?.stack ?? err).slice(0, 400),
      pass: false,
      note: 'runtime error',
    });
  }
  const cat = name.replace(/^\d+-/, '');
  const done = cases.slice(before);
  const failed = done.filter((c) => !c.pass);
  console.log(
    `${new Date().toISOString()} ${cat.padEnd(20)} ${String(done.length).padStart(3)} cases  ${String(done.length - failed.length).padStart(3)} pass  ${String(failed.length).padStart(3)} FAIL  ${failed.map((f) => f.id).join(',')}`
  );
}

const s = summary();
writeFileSync(`${HERE}results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, summary: s, cases }, null, 2));
await ctx.conn.end();
console.log('-'.repeat(64));
for (const [cat, b] of Object.entries(s.byCat)) console.log(`${cat.padEnd(22)} ${String(b.pass).padStart(4)} pass ${String(b.fail).padStart(4)} fail`);
console.log(`TOTAL ${s.total} cases, ${s.failures.length} failures -> scripts/test/results.json`);
process.exit(s.failures.length ? 2 : 0);
