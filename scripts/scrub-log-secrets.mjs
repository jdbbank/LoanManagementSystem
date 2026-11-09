#!/usr/bin/env node
/**
 * Scrub plaintext secrets out of the hourly server log files (F-LOG-4).
 * Older lines were written before the notification transport started redacting, so the
 * 6-digit OTP is still readable from disk. This rewrites those lines in place, keeping the
 * rest of the log intact.
 *
 * Usage:
 *   node scripts/scrub-log-secrets.mjs            dry run: report only
 *   node scripts/scrub-log-secrets.mjs --apply    rewrite the files
 *   node scripts/scrub-log-secrets.mjs --dir <path>
 */
import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LOG_DIR = path.resolve('server', 'src', 'logs');

/** Each entry replaces the secret with a marker that keeps the line shape readable. */
const SECRET_PATTERNS = [
  { name: 'otp_lao_subject', pattern: /(ເລກຢືນຢັນ\s*)\d{6}/g, replace: '$1<redacted>' },
  { name: 'otp_en_subject', pattern: /((?:verification|one[- ]time) code\D{0,4})(\d{6})/gi, replace: '$1<redacted>' },
  { name: 'reset_token_url', pattern: /(reset-password\?token=)[A-Za-z0-9_-]{8,}/g, replace: '$1<redacted>' },
];

function parseArgs(argv) {
  const dirIndex = argv.indexOf('--dir');
  return {
    apply: argv.includes('--apply'),
    dir: dirIndex >= 0 && argv[dirIndex + 1] ? path.resolve(argv[dirIndex + 1]) : DEFAULT_LOG_DIR,
  };
}

function logFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .sort()
    .map((name) => path.join(dir, name));
}

function countHits(text) {
  const hits = {};
  for (const { name, pattern } of SECRET_PATTERNS) {
    const found = text.match(new RegExp(pattern.source, pattern.flags)) ?? [];
    if (found.length) hits[name] = found.length;
  }
  return hits;
}

function scrub(text) {
  let out = text;
  for (const { pattern, replace } of SECRET_PATTERNS) out = out.replace(pattern, replace);
  return out;
}

const { apply, dir } = parseArgs(process.argv.slice(2));
if (!fs.existsSync(dir)) {
  console.log(`log dir not found: ${dir}`);
  process.exit(1);
}

let totalBefore = 0;
let filesTouched = 0;
for (const file of logFiles(dir)) {
  const text = fs.readFileSync(file, 'utf8');
  const hits = countHits(text);
  const count = Object.values(hits).reduce((a, n) => a + n, 0);
  if (!count) continue;
  totalBefore += count;
  filesTouched += 1;
  const summary = Object.entries(hits)
    .map(([name, n]) => `${name}=${n}`)
    .join(' ');
  console.log(`${path.basename(file)}: ${count} secret occurrence(s) [${summary}]`);
  if (apply) fs.writeFileSync(file, scrub(text), 'utf8');
}

console.log(
  apply
    ? `SCRUBBED ${totalBefore} occurrence(s) across ${filesTouched} file(s).`
    : `DRY RUN: ${totalBefore} occurrence(s) across ${filesTouched} file(s). Re-run with --apply to rewrite.`,
);
