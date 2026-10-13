#!/usr/bin/env node
// Writes the mysqldump that scripts/test/reset-db.mjs demands before it will wipe.
// The dump runs inside the MySQL container because the host has no mysqldump binary.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BACKUP_DIR = process.env.LOAN_BACKUP_DIR ? path.resolve(process.env.LOAN_BACKUP_DIR) : path.join(REPO_ROOT, 'backups');

const die = (msg) => {
  console.error(`\n[backup] ABORT: ${msg}`);
  process.exit(1);
};

if (process.env.NODE_ENV === 'production') die('NODE_ENV=production — refusing to run');
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
if (db.name !== 'loan_management') die(`DB_NAME=${db.name} — this backup is locked to loan_management`);

function findContainer() {
  if (process.env.LOAN_DB_CONTAINER) return process.env.LOAN_DB_CONTAINER;
  const probe = spawnSync('docker', ['ps', '--filter', `publish=${db.port}`, '--format', '{{.Names}}'], { encoding: 'utf8' });
  if (probe.status !== 0) die(`docker ps failed: ${(probe.stderr || probe.stdout || '').trim()}`);
  const names = probe.stdout.trim().split(/\r?\n/).filter(Boolean);
  if (names.length !== 1) die(`expected exactly one container publishing host port ${db.port}, found: ${names.join(', ') || 'none'} — set LOAN_DB_CONTAINER`);
  return names[0];
}

const container = findContainer();
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
const outFile = path.join(BACKUP_DIR, `${db.name}_${stamp}.sql`);

console.log(`[backup] docker exec ${container} mysqldump ${db.name} -> ${path.relative(REPO_ROOT, outFile)}`);
const args = [
  'exec', '-i', '-e', `MYSQL_PWD=${db.password}`, container,
  'mysqldump', '--host=127.0.0.1', '--port=3306', `--user=${db.user}`,
  '--single-transaction', '--routines', '--triggers', '--set-gtid-purged=OFF',
  '--databases', db.name,
];

const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
const out = fs.createWriteStream(outFile);
let dumpError = '';
child.stderr.on('data', (b) => (dumpError += b));
child.on('error', (e) => die(`docker spawn failed: ${e.message}`));
child.stdout.pipe(out);
const exitCode = await new Promise((resolve, reject) => {
  child.on('close', resolve);
  out.on('error', reject);
}).catch((e) => die(String(e?.message ?? e)));
await new Promise((resolve) => (out.writableEnded || out.destroyed ? resolve() : out.on('close', resolve)));
if (exitCode !== 0) die(`mysqldump exit ${exitCode}: ${dumpError.trim().slice(0, 300)}`);

const bytes = fs.statSync(outFile).size;
if (bytes < 10_000) die(`dump looks empty (${bytes} bytes) — check the container and credentials`);
const text = fs.readFileSync(outFile, 'utf8');
for (const must of ['CREATE TABLE', 'INSERT INTO', db.name]) {
  if (!text.includes(must)) die(`dump does not contain "${must}" — refusing to hand a partial backup to reset-db`);
}
console.log(`[backup] ok ${(bytes / 1048576).toFixed(1)} MB, tables=${(text.match(/CREATE TABLE/g) ?? []).length}`);
console.log(`[backup] restore with: docker exec -i ${container} mysql -u${db.user} -p**** < ${path.basename(outFile)}`);
