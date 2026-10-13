import { openDb, rows } from './lib/harness.mjs';

const conn = await openDb();
const q = (sql, p) => rows(conn, sql, p ?? []);

const credits = await q('SELECT id, customerId, CAST(balance AS CHAR) b FROM customer_credits');
console.log('customer_credits rows:', credits.length);
for (const r of credits) console.log(JSON.stringify(r));

const recent = await q(
  'SELECT id, action, loanId, transactionId, userId, customerId, CAST(amount AS CHAR) amount, CAST(createdAt AS CHAR) createdAt FROM audit_logs ORDER BY createdAt DESC LIMIT 10',
);
console.log('latest audit rows:');
for (const r of recent) console.log(JSON.stringify(r));

const orphan = await q(
  'SELECT id, action, loanId, transactionId, userId, CAST(createdAt AS CHAR) createdAt FROM audit_logs a WHERE a.userId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id=a.userId) LIMIT 10',
);
console.log('audit rows pointing at deleted users:', orphan.length);
for (const r of orphan) console.log(JSON.stringify(r));

process.exit(0);
