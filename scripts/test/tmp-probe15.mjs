import { openDb, rows } from './lib/harness.mjs';
import { writeFileSync } from 'fs';

const out = [];
const L = (...a) => out.push(a.join(' '));
const conn = await openDb();
const cOf = (v) => Math.round(parseFloat(String(v)) * 100);

const txs = await rows(
  conn,
  `SELECT t.id, t.referenceNo ref, t.transactionType ty, CAST(t.amount AS CHAR) amount, t.componentAmounts ca
   FROM financial_transactions t WHERE t.status='POSTED' ORDER BY t.referenceNo`,
  [],
);
const lines = await rows(conn, 'SELECT transactionId txId, component, CAST(amount AS CHAR) amount FROM financial_transaction_lines', []);
const byTx = new Map();
for (const l of lines) byTx.set(l.txId, (byTx.get(l.txId) ?? 0) + cOf(l.amount));
const absByTx = new Map();
for (const l of lines) absByTx.set(l.txId, (absByTx.get(l.txId) ?? 0) + Math.abs(cOf(l.amount)));
const ledger = await rows(conn, "SELECT customerId, type, CAST(amount AS CHAR) amount, transactionId txId FROM credit_ledger ORDER BY createdAt", []);
const accr = new Map(ledger.filter((r) => r.type === 'ACCRUED').map((r) => [r.txId, cOf(r.amount)]));

L('ty | ref | amount | signedLines | absLines | caAbsSum | accruedTx | amount-abs-accrued');
const groups = new Map();
for (const t of txs) {
  const amt = cOf(t.amount);
  const s = byTx.get(t.id) ?? 0;
  const a = absByTx.get(t.id) ?? 0;
  const ca = typeof t.ca === 'string' ? JSON.parse(t.ca) : t.ca ?? {};
  const caSum = Object.values(ca).reduce((x, v) => x + Math.abs(cOf(v)), 0);
  const ac = accr.get(t.id) ?? 0;
  const resid = amt - a - ac;
  const k = `${t.ty}${resid !== 0 ? ' RESID' : ''}`;
  groups.set(k, (groups.get(k) ?? 0) + 1);
  if (resid !== 0 || (t.ca && caSum !== a)) L(`${t.ty} | ${t.ref} | ${amt} | ${s} | ${a} | ${caSum} | ${ac} | ${resid}`);
}
L('');
L('== per-type tally (type / type+RESID => count)');
for (const [k, n] of groups) L(`${k} = ${n}`);
L('');
L('== credit_ledger rows');
for (const r of ledger) L(`${r.type} amount=${r.amount} customer=${String(r.customerId).slice(-12)} tx=${String(r.txId).slice(-12)} accruedMatchTx=${accr.has(r.txId)}`);
L('');
L('== txs referenced by ACCRUED ledger (ref, ty, amount, absLines)');
for (const r of ledger.filter((x) => x.type === 'ACCRUED')) {
  const t = txs.find((x) => x.id === r.txId);
  L(`${t?.ref} ${t?.ty} amount=${t && cOf(t.amount)} absLines=${(absByTx.get(r.txId) ?? 0)} accrued=${r.amount}`);
}
await conn.end();
writeFileSync('scripts/test/tmp-probe15.txt', out.join(String.fromCharCode(10)));
console.log('ok lines=' + out.length);
