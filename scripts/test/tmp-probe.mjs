import { openDb, rows } from './lib/harness.mjs';
const conn = await openDb();
const t = await rows(conn, "SELECT table_name n FROM information_schema.tables WHERE table_schema='loan_management' ORDER BY table_name");
console.log(t.map(r=>r.n).join(','));
const a = await rows(conn, "SELECT column_name c FROM information_schema.columns WHERE table_schema='loan_management' AND table_name='audit_logs' ORDER BY ordinal_position");
console.log('audit:', a.map(r=>r.c).join(','));
const u = await rows(conn, "SELECT column_name c FROM information_schema.columns WHERE table_schema='loan_management' AND table_name='system_config' ORDER BY ordinal_position");
console.log('system_config:', u.map(r=>r.c).join(','));
await conn.end();
