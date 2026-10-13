// 3.10 Reports + dashboard: `GET /api/reports/monthly` must be a pure restatement of the POSTED
// ledger, and `/api/dashboard/stats` must agree with it to the cent.
//
// The report endpoints are read-only, so nearly every case compares the API against the
// `expected.apiRows` oracle (a mechanical restatement built by scripts/test/dataset.mjs) and
// against independent SQL aggregates. Section H is the only part that writes: it adds one loan
// and one payment, proves that exactly the expected month rows move, then removes everything and
// proves the report returns to the byte-identical baseline.
import { api as http, check, eqMoney, errorMessage, expected, rows, settle, statusCheck } from '../lib/harness.mjs';
import { fmt, toCents } from '../oracle.mjs';

const CAT = 'reports';

const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a ?? 0) === cent(b ?? 0);
const moneyText = (fields, o) => fields.map((f) => `${f}=${fmt(cent(o?.[f]))}`).join(' ');
const countsText = (o) => `transactions=${o?.transactions} loansOpened=${o?.loansOpened}`;

const MONEY_FIELDS = [
  'disbursed',
  'moneyIn',
  'reversed',
  'writtenOff',
  'waived',
  'penaltyCharged',
  'principalPaid',
  'interestPaid',
  'penaltyPaid',
  'interestAccrued',
  'penaltyAdded',
  'outstandingDelta',
  'closingOutstanding',
  'collected',
];
const INT_FIELDS = ['loansOpened', 'transactions'];
const GROWTH_KEYS = ['collected', 'disbursed', 'outstanding'];
const TOTAL_KEYS = ['disbursed', 'moneyIn', 'reversed', 'collected', 'interestPaid', 'penaltyPaid', 'writtenOff'];

const monthKey = (date) => date.toISOString().slice(0, 7);
const monthWindow = (value, shift) => {
  const [year, month] = value.split('-').map(Number);
  return monthKey(new Date(Date.UTC(year, month - 1 + shift, 1)));
};
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The metric a growth cell compares; mirrors how reports.router picks collected / disbursed / closing. */
const growthValue = (row, key) => (key === 'outstanding' ? row.closingOutstanding : key === 'disbursed' ? row.disbursed : row.collected);

const growthSame = (a, b) => {
  for (const k of GROWTH_KEYS) {
    const x = a?.[k] ?? {};
    const y = b?.[k] ?? {};
    if (!sameMoney(x.absolute, y.absolute)) return `${k}.absolute got ${fmt(cent(x.absolute))} want ${fmt(cent(y.absolute))}`;
    const xp = x.percent ?? null;
    const yp = y.percent ?? null;
    if ((xp === null) !== (yp === null)) return `${k}.percent got ${xp} want ${yp}`;
    if (xp !== null && !eqMoney(xp, yp)) return `${k}.percent got ${xp} want ${yp}`;
  }
  return null;
};

/** Field-by-field diff of one API row against one oracle row; an empty array means identical. */
const rowDiff = (actual, oracle) => {
  if (!actual) return [`row ${oracle?.month} missing from the response`];
  const diffs = [];
  if (actual.month !== oracle.month) diffs.push(`month got ${actual.month} want ${oracle.month}`);
  for (const f of MONEY_FIELDS) if (!sameMoney(actual[f], oracle[f])) diffs.push(`${f} got ${fmt(cent(actual[f]))} want ${fmt(cent(oracle[f]))}`);
  for (const f of INT_FIELDS) if (Number(actual[f]) !== Number(oracle[f])) diffs.push(`${f} got ${actual[f]} want ${oracle[f]}`);
  for (const g of ['mom', 'yoy']) {
    const d = growthSame(actual[g], oracle[g]);
    if (d) diffs.push(`${g}.${d}`);
  }
  return diffs;
};

const windowDiff = (apiRows_, oracleRows) => {
  const bad = [];
  for (const oracle of oracleRows) {
    const actual = apiRows_.find((r) => r.month === oracle.month);
    const d = rowDiff(actual, oracle);
    if (d.length) bad.push(`${oracle.month}: ${d.join(' | ')}`);
  }
  return bad;
};

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));

  const C7 = '00000000-2000-4000-8000-000000000007';
  const C8 = '00000000-2000-4000-8000-000000000008';
  const CU = '00000000-2000-4000-8000-000000000001';

  const ORACLE_MONTHS = Object.keys(expected.apiRows);
  const FULL = ORACLE_MONTHS.length;
  const TO_MONTH = expected.meta.to;
  const currentMonth = monthKey(new Date());

  const TOTAL_TABLES = [
    'loans',
    'financial_transactions',
    'financial_transaction_lines',
    'payment_requests',
    'payment_allocations',
    'approval_workflows',
    'approval_steps',
    'audit_logs',
    'notification_outbox',
    'customer_credits',
    'credit_ledger',
  ];
  const baseline = {};
  for (const t of TOTAL_TABLES) baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;

  const createdLoans = [];
  const createdTx = [];
  const purge = async () => {
    if (createdTx.length) {
      // Workflows point at the transaction id, so they must go before the transactions themselves.
      await conn.query('DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (?))', [createdTx]);
      await conn.query('DELETE FROM approval_workflows WHERE subjectId IN (?)', [createdTx]);
      await conn.query('DELETE FROM credit_ledger WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transaction_lines WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM audit_logs WHERE transactionId IN (?)', [createdTx]);
      await conn.query('DELETE FROM financial_transactions WHERE id IN (?)', [createdTx]);
    }
    if (createdLoans.length) {
      const inTx = 'SELECT id FROM financial_transactions WHERE loanId IN (?)';
      await conn.query(`DELETE FROM approval_steps WHERE workflowId IN (SELECT id FROM approval_workflows WHERE subjectId IN (${inTx}))`, [createdLoans]);
      await conn.query(`DELETE FROM approval_workflows WHERE subjectId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [createdLoans]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM audit_logs WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM settlement_agreements WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM reconciliation_records WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM credit_ledger WHERE customerId IN (?)', [[C7, C8]]);
      await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [[C7, C8]]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [createdLoans]);
    }
  };

  const monthly = async (query = '', token = tokens.admin) => api('GET', `/api/reports/monthly${query}`, { token });
  const dataOf = (res) => res.json?.data ?? {};
  const getMonthly = async (query = '') => dataOf(await monthly(query));

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);

  /** Same aggregation the endpoint performs, but written against the tables directly. */
  const cashFromDb = (month, customerId) =>
    rows(
      conn,
      `SELECT
         COALESCE(SUM(CASE WHEN transactionType = 'DISBURSEMENT' THEN amount ELSE 0 END), 0) disbursed,
         COALESCE(SUM(CASE WHEN transactionType IN ('PAYMENT','SETTLEMENT_PAYMENT') THEN amount ELSE 0 END), 0) moneyIn,
         COALESCE(SUM(CASE WHEN transactionType = 'PAYMENT_REVERSAL' THEN amount ELSE 0 END), 0) reversed,
         COALESCE(SUM(CASE WHEN transactionType = 'WRITE_OFF' THEN amount ELSE 0 END), 0) writtenOff,
         COALESCE(SUM(CASE WHEN transactionType = 'WAIVER' THEN amount ELSE 0 END), 0) waived,
         COALESCE(SUM(CASE WHEN transactionType = 'PENALTY' THEN amount ELSE 0 END), 0) penaltyCharged,
         COUNT(*) transactions
       FROM financial_transactions
       WHERE status = 'POSTED' AND DATE_FORMAT(postedAt, '%Y-%m') = ?${customerId ? ' AND customerId = ?' : ''}`,
      customerId ? [month, customerId] : [month],
    ).then((r) => r[0]);

  const linesFromDb = (month, customerId) =>
    rows(
      conn,
      `SELECT
         COALESCE(SUM(CASE WHEN l.component = 'PAST_PRINCIPAL' AND l.amount < 0 THEN -l.amount ELSE 0 END), 0) principalPaid,
         COALESCE(SUM(CASE WHEN l.component = 'PAST_INTEREST' AND l.amount < 0 THEN -l.amount ELSE 0 END), 0) interestPaid,
         COALESCE(SUM(CASE WHEN l.component = 'PENALTY' AND l.amount < 0 THEN -l.amount ELSE 0 END), 0) penaltyPaid,
         COALESCE(SUM(CASE WHEN l.component = 'PAST_INTEREST' AND l.amount > 0 THEN l.amount ELSE 0 END), 0) interestAccrued,
         COALESCE(SUM(CASE WHEN l.component = 'PENALTY' AND l.amount > 0 THEN l.amount ELSE 0 END), 0) penaltyAdded,
         COALESCE(SUM(l.amount), 0) outstandingDelta
       FROM financial_transaction_lines l
       JOIN financial_transactions t ON t.id = l.transactionId
       WHERE t.status = 'POSTED' AND DATE_FORMAT(t.postedAt, '%Y-%m') = ?${customerId ? ' AND t.customerId = ?' : ''}`,
      customerId ? [month, customerId] : [month],
    ).then((r) => r[0]);

  const openedFromDb = (month) => rows(conn, `SELECT COUNT(*) n FROM loans WHERE DATE_FORMAT(createdAt, '%Y-%m') = ?`, [month]).then((r) => r[0].n);
  const bookFromDb = (customerId) =>
    rows(
      conn,
      customerId ? 'SELECT COALESCE(SUM(currentOutstanding), 0) s FROM loans WHERE customerId = ?' : 'SELECT COALESCE(SUM(currentOutstanding), 0) s FROM loans',
      customerId ? [customerId] : undefined,
    ).then((r) => cent(r[0].s));
  const allLoans = () => rows(conn, 'SELECT COUNT(*) n FROM loans').then((r) => Number(r[0].n));

  try {
    // ============================================================ A. access control
    statusCheck(CAT, 'รายงานรายเดือน: ไม่มี token = 401', await monthly('', null), 401, { input: 'GET /api/reports/monthly (anonymous)' });
    for (const [label, token] of [
      ['MAKER (test_op1)', tokens.op1],
      ['CHECKER (test_checker1)', tokens.checker1],
      ['VIEWER (test_view1)', tokens.viewer],
    ]) {
      statusCheck(CAT, `รายงานรายเดือน: บทบาท ${label} ถูกปฏิเสธ 403 พร้อมรายการ role ที่ต้องมี`, await monthly('', token), 403, {
        input: label,
        messageIncludes: 'Requires role: ADMIN or HEAD_APPROVER',
      });
    }
    for (const [label, token] of [
      ['HEAD_APPROVER', tokens.head],
      ['ADMIN', tokens.admin],
    ]) {
      statusCheck(CAT, `รายงานรายเดือน: บทบาท ${label} อ่านได้ 200`, await monthly('?months=6', token), 200, { input: label });
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      statusCheck(CAT, `รายงานเป็น read-only เท่านั้น: ${method} /api/reports/monthly = 404`, await api(method, '/api/reports/monthly', { token: tokens.admin }), 404, {
        input: method,
        messageIncludes: 'Not found',
      });
    }
    statusCheck(CAT, 'route ที่ไม่มีในโมดูลรายงาน: /api/reports/annual = 404 (role ผ่านก่อน แล้วจึงไม่ match path)', await api('GET', '/api/reports/annual', { token: tokens.admin }), 404, {
      input: 'GET /api/reports/annual',
      messageIncludes: 'Not found',
    });
    statusCheck(CAT, '/api/reports โดยไม่มี path ย่อย = 404', await api('GET', '/api/reports', { token: tokens.admin }), 404, { input: 'GET /api/reports' });
    statusCheck(CAT, 'HEAD_APPROVER เรียก route ที่ไม่มีอยู่ก็ยัง 404 (ไม่ใช่ 403 ซ้อนกัน)', await api('GET', '/api/reports/annual', { token: tokens.head }), 404, { input: 'HEAD + unknown path' });

    // ============================================================ B. query validation
    for (const [raw, label] of [
      ['?months=0', 'months=0'],
      ['?months=37', 'months=37'],
      ['?months=-3', 'months=-3'],
      ['?months=1.5', 'months=1.5'],
      ['?months=abc', 'months=abc'],
      ['?months=', 'months= (ค่าว่าง)'],
    ]) {
      statusCheck(CAT, `${label} ต้องถูก zod ปฏิเสธ 400 Validation failed`, await monthly(raw), 400, {
        input: raw || '(empty)',
        messageIncludes: 'Validation failed',
      });
    }
    const def = await getMonthly('');
    check(CAT, 'ไม่ส่ง months = ค่าเริ่มต้น 12 เดือน และ from/to สะท้อนหน้าต่างจริง', {
      input: 'GET /api/reports/monthly',
      expected: { months: 12, rows: 12, from: monthWindow(TO_MONTH, -11), to: TO_MONTH },
      actual: { months: def.months, rows: def.rows?.length, from: def.from, to: def.to },
      pass: def.months === 12 && def.rows?.length === 12 && def.from === monthWindow(TO_MONTH, -11) && def.to === TO_MONTH,
    });
    const dup = await getMonthly('?months=6&months=12');
    check(CAT, 'ส่ง months ซ้ำสองค่า (Express ให้เป็น array) ไม่ crash แต่ตกกลับค่าเริ่มต้น 12', {
      input: '?months=6&months=12',
      expected: { months: 12, rows: 12 },
      actual: { months: dup.months, rows: dup.rows?.length },
      pass: dup.months === 12 && dup.rows?.length === 12,
      note: "router อ่านพารามิเตอร์เฉพาะเมื่อ typeof === 'string' จึงไม่ crash แต่ผู้ใช้ตั้งใจ 6 แล้วได้ 12 — ไม่มีสัญญาณเตือนใน response",
    });
    const one = await getMonthly('?months=1');
    check(CAT, 'months=1 ให้แถวเดียวและ from === to === เดือนปัจจุบัน', {
      input: '?months=1',
      expected: { rows: 1, from: currentMonth, to: currentMonth, month: currentMonth },
      actual: { rows: one.rows?.length, from: one.from, to: one.to, month: one.rows?.[0]?.month },
      pass: one.rows?.length === 1 && one.from === currentMonth && one.to === currentMonth && one.rows?.[0]?.month === currentMonth,
    });
    statusCheck(CAT, 'months=36 (ขอบบนของหน้าต่าง) = 200', await monthly('?months=36'), 200);
    const wide = await getMonthly('?months=36');
    const leadingZero = (wide.rows ?? []).slice(0, 2).every((r) => MONEY_FIELDS.every((f) => cent(r[f]) === 0) && r.transactions === 0 && r.loansOpened === 0);
    check(CAT, 'months=36 ขยายหน้าต่างย้อนถึง 2023-11 และแถวที่ไม่มีข้อมูลต้องเป็น 0 ทั้งหมด', {
      input: '?months=36',
      expected: { from: monthWindow(currentMonth, -35), rows: 36, leadingZeros: true },
      actual: { from: wide.from, rows: wide.rows?.length, leadingZeros: leadingZero },
      pass: wide.from === monthWindow(currentMonth, -35) && wide.rows?.length === 36 && leadingZero,
    });
    statusCheck(CAT, 'customerId ที่ไม่ใช่ uuid ต้อง 400', await monthly('?customerId=not-a-uuid'), 400, { messageIncludes: 'Validation failed' });
    const ghost = await getMonthly('?months=12&customerId=00000000-2000-4000-8000-0000000000ff');
    const ghostZero = (ghost.rows ?? []).every((r) => MONEY_FIELDS.every((f) => cent(r[f]) === 0) && r.transactions === 0);
    check(CAT, 'customerId รูปแบบถูกแต่ไม่มีอยู่จริง: ตัวเลขจาก ledger เป็น 0 ทุกแถว และ header ปิดยอด 0 (ไม่ใช่ error)', {
      input: '?customerId=<valid uuid, no rows>',
      expected: { allLedgerZero: true, opening: 0, closing: 0, transactions: 0 },
      actual: {
        allLedgerZero: ghostZero,
        opening: cent(ghost.openingOutstanding),
        closing: cent(ghost.closingOutstanding),
        transactions: (ghost.rows ?? []).reduce((s, r) => s + r.transactions, 0),
      },
      pass: ghostZero && cent(ghost.openingOutstanding) === 0 && cent(ghost.closingOutstanding) === 0,
      note: 'loansOpened ของ response นี้ยังมียอดของทั้งสมุด (เช่น 2025-11 = 3) เพราะ query "opened" ไม่กรอง customerId — ดูข้อ F-RPT-1',
    });

    // ============================================================ C. window vs oracle
    check(CAT, 'หน้าต่างรายงานต้องอยู่เดือนเดียวกับที่ fixture สร้าง มิฉะนั้นตัวเลขเทียบกันไม่ได้', {
      input: 'monthKey(now UTC) vs expected.meta.to',
      expected: TO_MONTH,
      actual: currentMonth,
      pass: currentMonth === TO_MONTH,
      note: 'expected.json สร้างจาก referenceNow ในเดือนนี้ ถ้ารันข้ามเดือนต้อง re-seed และ regenerate oracle ก่อน',
    });

    const full = await getMonthly(`?months=${FULL}`);
    const fullBad = windowDiff(full.rows ?? [], ORACLE_MONTHS.map((m) => expected.apiRows[m]));
    check(CAT, `?months=${FULL}: ตรงกับ expected.apiRows ทุกแถว ทุกฟิลด์ (เงิน / ตัวนับ / MoM / YoY)`, {
      input: `${FULL} rows vs oracle`,
      expected: 'no differences',
      actual: fullBad.length ? fullBad.join(' ;; ').slice(0, 900) : 'no differences',
      pass: fullBad.length === 0,
    });

    for (const [months, fixture] of [
      [6, expected.report.months6],
      [12, expected.report.months12],
      [16, expected.report.months16],
    ]) {
      const body = await getMonthly(`?months=${months}`);
      const bad = windowDiff(body.rows ?? [], fixture.rows ?? []);
      const headerBad = [
        ['from', body.from, fixture.from, false],
        ['to', body.to, fixture.to, false],
        ['months', body.months, fixture.months, false],
        ['openingOutstanding', body.openingOutstanding, fixture.openingOutstanding, true],
        ['closingOutstanding', body.closingOutstanding, fixture.closingOutstanding, true],
        ['loanBookOutstanding', body.loanBookOutstanding, fixture.loanBookOutstanding, true],
      ]
        .filter(([k, a, b, money]) => (money ? !sameMoney(a, b) : String(a) !== String(b)))
        .map(([k, a, b]) => `${k} got ${a} want ${b}`);
      const totalsBad = Object.keys(fixture.totals)
        .filter((k) => (k === 'loansOpened' ? Number(body.totals?.[k]) !== fixture.totals[k] : !sameMoney(body.totals?.[k], fixture.totals[k])))
        .map((k) => `totals.${k} got ${k === 'loansOpened' ? body.totals?.[k] : fmt(cent(body.totals?.[k]))} want ${k === 'loansOpened' ? fixture.totals[k] : fmt(cent(fixture.totals[k]))}`);
      const all = [...headerBad, ...totalsBad, ...bad];
      check(CAT, `หน้าต่าง ${months} เดือนตรงกับ fixture ทั้ง header, แถว และ totals`, {
        input: `?months=${months}`,
        expected: `${fixture.rows.length} rows ${fixture.from}..${fixture.to}; totals ${moneyText(TOTAL_KEYS, fixture.totals)} loansOpened=${fixture.totals.loansOpened}`,
        actual: `${body.rows?.length} rows ${body.from}..${body.to}; totals ${moneyText(TOTAL_KEYS, body.totals)} loansOpened=${body.totals?.loansOpened}${all.length ? ' ;; ' + all.join(' | ').slice(0, 700) : ''}`,
        pass: all.length === 0 && body.rows?.length === fixture.rows.length,
      });
    }

    // ============================================================ D. header invariants
    const w = await getMonthly('?months=16');
    const rowsW = w.rows ?? [];
    check(CAT, 'header: สกุลเงิน LAK และ customerId ของหน้าต่างเต็มเป็น null', {
      input: 'data.currency / data.customerId',
      expected: { currency: 'LAK', customerId: null },
      actual: { currency: w.currency, customerId: w.customerId ?? null },
      pass: w.currency === 'LAK' && (w.customerId ?? null) === null,
    });
    check(CAT, 'openingOutstanding = closing แถวแรก - outstandingDelta แถวแรก (เปิดหน้าต่างด้วย ledger ไม่ใช่ snapshot วันนี้)', {
      input: 'rows[0]',
      expected: fmt(cent(r2(rowsW[0]?.closingOutstanding - rowsW[0]?.outstandingDelta))),
      actual: fmt(cent(w.openingOutstanding)),
      pass: sameMoney(w.openingOutstanding, r2(rowsW[0].closingOutstanding - rowsW[0].outstandingDelta)),
    });
    check(CAT, 'closingOutstanding = แถวสุดท้าย = ยอดคงค้างรวมที่ oracle ล็อกไว้', {
      input: 'data.closingOutstanding',
      expected: fmt(toCents(expected.totals.closingOutstanding)),
      actual: fmt(cent(w.closingOutstanding)) + ` (last row ${fmt(cent(rowsW.at(-1)?.closingOutstanding))})`,
      pass: sameMoney(w.closingOutstanding, expected.totals.closingOutstanding) && sameMoney(rowsW.at(-1)?.closingOutstanding, w.closingOutstanding),
    });
    const seedBook = await bookFromDb();
    check(CAT, 'loanBookOutstanding = SUM(loans.currentOutstanding) จาก DB = ค่าที่ oracle ล็อกไว้', {
      input: 'data.loanBookOutstanding vs DB',
      expected: `${fmt(toCents(expected.totals.loanBookOutstanding))} / db ${fmt(seedBook)}`,
      actual: fmt(cent(w.loanBookOutstanding)),
      pass: sameMoney(w.loanBookOutstanding, expected.totals.loanBookOutstanding) && cent(w.loanBookOutstanding) === seedBook,
    });
    const sumDelta = r2(rowsW.reduce((s, r) => s + r.outstandingDelta, 0));
    check(CAT, 'ปิดสมุด: opening + Σ outstandingDelta ทุกแถว = loanBookOutstanding (ledger เป็นแหล่งความจริงเดียว)', {
      input: `opening + Σ delta over ${rowsW.length} rows`,
      expected: fmt(cent(w.loanBookOutstanding)),
      actual: `${fmt(cent(r2(w.openingOutstanding + sumDelta)))} (Σ delta ${fmt(cent(sumDelta))})`,
      pass: sameMoney(r2(w.openingOutstanding + sumDelta), w.loanBookOutstanding),
    });
    const recomputed = rowsW.reduce(
      (a, r) => ({
        ...a,
        ...Object.fromEntries(TOTAL_KEYS.map((k) => [k, r2(a[k] + r[k])])),
        loansOpened: a.loansOpened + r.loansOpened,
      }),
      { disbursed: 0, moneyIn: 0, reversed: 0, collected: 0, interestPaid: 0, penaltyPaid: 0, writtenOff: 0, loansOpened: 0 },
    );
    check(CAT, 'totals = ผลรวมของแถวในหน้าต่างเท่านั้น (ไม่มีแถวลับนอกหน้าต่างถูกปนมาบวก)', {
      input: 'sum(rows) vs data.totals',
      expected: `${moneyText(TOTAL_KEYS, recomputed)} loansOpened=${recomputed.loansOpened}`,
      actual: `${moneyText(TOTAL_KEYS, w.totals)} loansOpened=${w.totals?.loansOpened}`,
      pass: TOTAL_KEYS.every((k) => sameMoney(w.totals[k], recomputed[k])) && w.totals?.loansOpened === recomputed.loansOpened,
    });
    check(CAT, 'collected รายเดือน = moneyIn - reversed ทุกแถว (reversal ไม่ถูกนับเป็นเงินสดรับ)', {
      input: 'every row',
      expected: 'collected = moneyIn - reversed',
      actual: rowsW.filter((r) => !sameMoney(r.collected, r2(r.moneyIn - r.reversed))).map((r) => `${r.month}: ${r.collected} vs ${r2(r.moneyIn - r.reversed)}`).join(', ') || 'ok',
      pass: rowsW.every((r) => sameMoney(r.collected, r2(r.moneyIn - r.reversed))),
    });
    const runBad = [];
    let run0 = 0;
    for (const r of rowsW) {
      run0 = r2(run0 + r.outstandingDelta);
      if (!sameMoney(run0, r.closingOutstanding)) runBad.push(`${r.month}: got ${fmt(cent(r.closingOutstanding))} want ${fmt(cent(run0))}`);
    }
    check(CAT, 'closingOutstanding เป็น running sum ของ signed lines ต่อเนื่องทุกแถว', {
      input: 'replay running sum from the opening balance',
      expected: 'no differences',
      actual: runBad.join(' | ') || 'ok',
      pass: runBad.length === 0,
    });

    // ============================================================ E. per-month DB cross-check
    for (const month of ['2025-07', '2026-01', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      const row = (full.rows ?? []).find((r) => r.month === month) ?? {};
      const c = await cashFromDb(month);
      const l = await linesFromDb(month);
      const opened = await openedFromDb(month);
      const want = {
        disbursed: c.disbursed,
        moneyIn: c.moneyIn,
        reversed: c.reversed,
        writtenOff: c.writtenOff,
        waived: c.waived,
        penaltyCharged: c.penaltyCharged,
        principalPaid: l.principalPaid,
        interestPaid: l.interestPaid,
        penaltyPaid: l.penaltyPaid,
        interestAccrued: l.interestAccrued,
        penaltyAdded: l.penaltyAdded,
        outstandingDelta: l.outstandingDelta,
      };
      const bad = Object.entries(want)
        .filter(([k, v]) => !sameMoney(row[k], v))
        .map(([k, v]) => `${k} got ${fmt(cent(row[k]))} want ${fmt(cent(v))}`);
      const countsBad = Number(row.transactions) !== Number(c.transactions) || row.loansOpened !== opened ? `got ${countsText(row)} want ${countsText({ ...row, transactions: c.transactions, loansOpened: opened })}` : '';
      check(CAT, `เดือน ${month}: แถวรายงานตรงกับ SQL ที่คำนวณจากตาราง ledger ตรง ๆ`, {
        input: `SQL aggregates for ${month}`,
        expected: `${moneyText(Object.keys(want), want)} ${countsText({ transactions: c.transactions, loansOpened: opened })}`,
        actual: `${moneyText(Object.keys(want), row)} ${countsText(row)}${bad.length ? ' ;; ' + bad.join(' | ') : ''}${countsBad ? ' ;; ' + countsBad : ''}`,
        pass: !bad.length && !countsBad,
      });
    }

    // ============================================================ F. customerId scoping
    const scoped = await getMonthly(`?months=${FULL}&customerId=${CU}`);
    const scopedBad = [];
    const activeMonths = [];
    for (const r of scoped.rows ?? []) {
      if (!r.transactions) continue;
      activeMonths.push(r.month);
      const c = await cashFromDb(r.month, CU);
      const l = await linesFromDb(r.month, CU);
      if (!sameMoney(r.moneyIn, c.moneyIn)) scopedBad.push(`${r.month}.moneyIn got ${fmt(cent(r.moneyIn))} want ${fmt(cent(c.moneyIn))}`);
      if (!sameMoney(r.disbursed, c.disbursed)) scopedBad.push(`${r.month}.disbursed got ${fmt(cent(r.disbursed))} want ${fmt(cent(c.disbursed))}`);
      if (!sameMoney(r.outstandingDelta, l.outstandingDelta)) scopedBad.push(`${r.month}.outstandingDelta got ${fmt(cent(r.outstandingDelta))} want ${fmt(cent(l.outstandingDelta))}`);
      if (Number(r.transactions) !== Number(c.transactions)) scopedBad.push(`${r.month}.transactions got ${r.transactions} want ${c.transactions}`);
    }
    check(CAT, 'filter customerId: ตัวเลขเงินและตัวนับทุกตัวในแถวมาจาก ledgerของลูกหนี้รายนั้นเท่านั้น', {
      input: `?customerId=${CU} active months ${activeMonths.join(', ')}`,
      expected: 'no differences',
      actual: scopedBad.join(' | ') || `ok, ${activeMonths.length} active months`,
      pass: scopedBad.length === 0 && activeMonths.length > 0,
    });
    const scopedBook = await bookFromDb(CU);
    const wholeLoans = await allLoans();
    const scopedOpenedSum = (scoped.rows ?? []).reduce((s, r) => s + r.loansOpened, 0);
    check(CAT, 'filter customerId: loanBookOutstanding และ loansOpened ต้อง scope ตามลูกหนี้ด้วย (ข้อสังเกต F-RPT-1)', {
      input: `?customerId=${CU}`,
      expected: { loanBookOutstanding: fmt(scopedBook), loansOpened: '< loans of the whole book' },
      actual: { loanBookOutstanding: fmt(cent(scoped.loanBookOutstanding)), loansOpened: `${scopedOpenedSum} of ${wholeLoans} loans` },
      pass: cent(scoped.loanBookOutstanding) === scopedBook && scopedOpenedSum < wholeLoans,
      note: `F-RPT-1: reports.router.ts เรียก query 'opened' (COUNT loans GROUP BY DATE_FORMAT(createdAt)) และ 'balances' (SUM currentOutstanding) โดยไม่ใส่เงื่อนไข customerId response ที่ filter แล้วจึงยังแสดงยอดทั้งสมุด (${fmt(cent(scoped.loanBookOutstanding))} แทนของ ${CU} = ${fmt(scopedBook)}) และ loansOpened รวม = ${scopedOpenedSum} ซึ่งเท่าจำนวน loan ทั้งสมุด (${wholeLoans}) ทำให้รายงานระดับลูกหนี้ปิดยอดกับตัวเองไม่ได้`,
    });
    const customerLedger = cent(
      (
        await rows(
          conn,
          `SELECT COALESCE(SUM(l.amount), 0) s FROM financial_transaction_lines l
           JOIN financial_transactions t ON t.id = l.transactionId
           WHERE t.status = 'POSTED' AND t.customerId = ?`,
          [CU],
        )
      )[0].s,
    );
    const scopedWide = await getMonthly(`?months=${FULL}&customerId=${CU}`);
    check(CAT, 'filter customerId: Σ outstandingDelta ทั้งหน้าต่าง = ยอดคงค้างสะสมของลูกหนี้รายนั้น (ปิดยอดตัวเองได้จริง)', {
      input: `?customerId=${CU}&months=${FULL}`,
      expected: fmt(customerLedger),
      actual: `${fmt(cent(scopedWide.closingOutstanding))} (loanBookOutstanding ${fmt(cent(scopedWide.loanBookOutstanding))})`,
      pass: cent(scopedWide.closingOutstanding) === customerLedger,
    });

    // ============================================================ G. MoM / YoY semantics
    const byMonth = Object.fromEntries((full.rows ?? []).map((r) => [r.month, r]));
    const ruleBad = [];
    for (const r of full.rows ?? []) {
      for (const [g, offset] of [
        ['mom', -1],
        ['yoy', -12],
      ]) {
        const base = byMonth[monthWindow(r.month, offset)];
        for (const key of GROWTH_KEYS) {
          const cell = r[g]?.[key] ?? {};
          const cur = growthValue(r, key);
          if (!base) {
            if (Number(cell.absolute) !== 0 || (cell.percent ?? null) !== null) ruleBad.push(`${r.month}.${g}.${key}: base outside window should be {0,null}, got ${JSON.stringify(cell)}`);
            continue;
          }
          const b = growthValue(base, key);
          const wantAbs = r2(cur - b);
          const wantPct = b === 0 ? null : r2((wantAbs / Math.abs(b)) * 100);
          if (!sameMoney(cell.absolute, wantAbs)) ruleBad.push(`${r.month}.${g}.${key}.absolute got ${cell.absolute} want ${wantAbs}`);
          const cellPct = cell.percent ?? null;
          if ((cellPct === null) !== (wantPct === null)) ruleBad.push(`${r.month}.${g}.${key}.percent got ${cellPct} want ${wantPct}`);
          else if (wantPct !== null && !eqMoney(cellPct, wantPct)) ruleBad.push(`${r.month}.${g}.${key}.percent got ${cellPct} want ${wantPct}`);
        }
      }
    }
    check(CAT, 'MoM/YoY ใช้สูตร delta() ตรงกันทุกแถว: ฐานนอกหน้าต่าง = {0,null}, ฐาน 0 = percent null, ฐานลบใช้ค่าสัมบูรณ์', {
      input: `recompute every growth cell of ${FULL} rows`,
      expected: 'no differences',
      actual: ruleBad.slice(0, 5).join(' ;; ') || 'ok',
      pass: ruleBad.length === 0,
      note: ruleBad.length > 5 ? `${ruleBad.length} differences, first 5 shown` : '',
    });
    const jan = byMonth['2026-01'];
    check(CAT, 'ฐาน 0: MoM collected ของ 2026-01 (เดือนก่อนเก็บเงิน 0) ต้อง absolute = ยอดเดือนนั้น และ percent = null', {
      input: '2026-01.mom.collected where 2025-12 collected = 0',
      expected: { absolute: fmt(cent(jan?.collected)), percent: null, prevCollected: fmt(cent(byMonth['2025-12']?.collected)) },
      actual: { absolute: fmt(cent(jan?.mom?.collected?.absolute)), percent: jan?.mom?.collected?.percent ?? null, prevCollected: fmt(cent(byMonth['2025-12']?.collected)) },
      pass: sameMoney(jan?.mom?.collected?.absolute, jan?.collected) && (jan?.mom?.collected?.percent ?? null) === null && cent(byMonth['2025-12']?.collected) === 0,
      note: 'ถ้าโค้ดใช้ percent = absolute/previous โดยไม่กัน 0 จะเกิด Infinity/NaN ใน response ผู้ใช้ทั่วไปเห็นเป็นช่องว่าง',
    });
    const jul = byMonth['2026-07'];
    const aug = byMonth['2026-08'];
    check(CAT, 'ฐานติดลบ (2026-07 collected ติดลบจาก reversal): ตัวหารต้องเป็นค่าสัมบูรณ์ของฐาน', {
      input: '2026-08.mom.collected',
      expected: {
        absolute: fmt(cent(r2(aug.collected - jul.collected))),
        percent: r2(((aug.collected - jul.collected) / Math.abs(jul.collected)) * 100),
        base: fmt(cent(jul.collected)),
      },
      actual: { absolute: fmt(cent(aug?.mom?.collected?.absolute)), percent: aug?.mom?.collected?.percent ?? null, base: fmt(cent(jul.collected)) },
      pass: sameMoney(aug?.mom?.collected?.absolute, r2(aug.collected - jul.collected)) && eqMoney(aug?.mom?.collected?.percent, r2(((aug.collected - jul.collected) / Math.abs(jul.collected)) * 100)),
      note: `เดือน 2026-07 มี reversal 12,000,000 ทำให้ collected ติดลบ; การเติบโตเดือนถัดไปคิดจาก |ฐาน| จึงได้ +${aug?.mom?.collected?.percent}%`,
    });
    const single = await getMonthly('?months=1');
    const prevRow = byMonth[monthWindow(currentMonth, -1)];
    const lastYearRow = byMonth[monthWindow(currentMonth, -12)];
    check(CAT, 'months=1 ยังคำนวณ MoM/YoY ได้ เพราะ query window ย้อนไป 12 เดือนเกินหน้าต่างที่ขอ', {
      input: '?months=1',
      expected: {
        momAbsolute: fmt(cent(r2(single.rows?.[0]?.collected - prevRow?.collected))),
        yoyAbsolute: fmt(cent(r2(single.rows?.[0]?.collected - lastYearRow?.collected))),
      },
      actual: {
        momAbsolute: fmt(cent(single.rows?.[0]?.mom?.collected?.absolute)),
        yoyAbsolute: fmt(cent(single.rows?.[0]?.yoy?.collected?.absolute)),
      },
      pass:
        !!prevRow &&
        !!lastYearRow &&
        sameMoney(single.rows?.[0]?.mom?.collected?.absolute, r2(single.rows[0].collected - prevRow.collected)) &&
        sameMoney(single.rows?.[0]?.yoy?.collected?.absolute, r2(single.rows[0].collected - lastYearRow.collected)),
      note: `YoY เทียบกับ ${monthWindow(currentMonth, -12)} ซึ่งอยู่นอกหน้าต่างที่คืน แต่อยู่ใน query window (${monthWindow(monthWindow(currentMonth, -35), -12)} สำหรับ months=36)`,
    });

    // ============================================================ I. dashboard
    statusCheck(CAT, 'dashboard/stats: ไม่มี token = 401', await api('GET', '/api/dashboard/stats', { token: null }), 401);
    statusCheck(CAT, 'dashboard/stats: VIEWER อ่านได้ (โมดูลนี้ใช้ requireAuth อย่างเดียว ไม่มี requireRole)', await api('GET', '/api/dashboard/stats', { token: tokens.viewer }), 200, {
      input: 'GET /api/dashboard/stats as VIEWER',
      note: 'ต่างจาก /api/reports/monthly ที่กันไว้เฉพาะ ADMIN/HEAD_APPROVER — ข้อสังเกตด้าน policy ไม่ใช่บั๊ก',
    });
    statusCheck(CAT, 'dashboard/stats เป็น read-only: POST = 404', await api('POST', '/api/dashboard/stats', { token: tokens.admin }), 404, { messageIncludes: 'Not found' });

    const stats = dataOf(await api('GET', '/api/dashboard/stats', { token: tokens.head }));
    const dbAgg = (
      await rows(
        conn,
        `SELECT
           (SELECT COUNT(*) FROM customers) customers,
           (SELECT COUNT(*) FROM payment_requests WHERE status = 'PENDING') pendingRequests,
           (SELECT COUNT(*) FROM approval_workflows WHERE status = 'PENDING') pendingWorkflows,
           (SELECT COUNT(*) FROM financial_transactions WHERE status = 'POSTED') posted,
           (SELECT COALESCE(SUM(balance), 0) FROM customer_credits) creditBalance,
           COALESCE(SUM(outstandingPenalty + outstandingPastInterest + outstandingPastPrincipal), 0) totalOutstanding,
           COALESCE(SUM(CASE WHEN status = 'ACTIVE' THEN outstandingPenalty + outstandingPastInterest + outstandingPastPrincipal ELSE 0 END), 0) activeOutstanding
         FROM loans`,
      )
    )[0];
    const statusWanted = {};
    for (const st of Object.values(expected.statuses)) statusWanted[st] = (statusWanted[st] ?? 0) + 1;
    check(CAT, 'dashboard/stats: ตัวนับและยอดคงค้างทุกตัวตรงกับ DB ในสถานะ seed', {
      input: 'GET /api/dashboard/stats',
      expected: {
        customers: Number(dbAgg.customers),
        loans: expected.rowCounts.loans,
        postedTransactions: expected.totals.postedTransactions,
        totalOutstanding: fmt(toCents(expected.totals.closingOutstanding)),
        activeOutstanding: fmt(cent(dbAgg.activeOutstanding)),
        totalCustomerCredit: fmt(cent(dbAgg.creditBalance)),
        loansByStatus: statusWanted,
      },
      actual: {
        customers: stats.customers,
        loans: stats.loans,
        postedTransactions: stats.postedTransactions,
        totalOutstanding: fmt(cent(stats.totalOutstanding)),
        activeOutstanding: fmt(cent(stats.activeOutstanding)),
        totalCustomerCredit: fmt(cent(stats.totalCustomerCredit)),
        loansByStatus: stats.loansByStatus,
      },
      pass:
        stats.customers === Number(dbAgg.customers) &&
        stats.loans === expected.rowCounts.loans &&
        stats.postedTransactions === expected.totals.postedTransactions &&
        cent(stats.totalOutstanding) === toCents(expected.totals.closingOutstanding) &&
        cent(stats.totalOutstanding) === cent(dbAgg.totalOutstanding) &&
        sameMoney(stats.activeOutstanding, dbAgg.activeOutstanding) &&
        sameMoney(stats.totalCustomerCredit, dbAgg.creditBalance) &&
        ['ACTIVE', 'CLOSED', 'WRITTEN_OFF'].every((s) => stats.loansByStatus?.[s] === statusWanted[s]),
    });
    check(CAT, 'cross-module: dashboard.totalOutstanding = reports.loanBookOutstanding = oracle (สามทางต้องเท่ากันถึงทศนิยม)', {
      input: 'dashboard vs reports vs expected.json',
      expected: fmt(toCents(expected.totals.loanBookOutstanding)),
      actual: `dashboard ${fmt(cent(stats.totalOutstanding))} / reports ${fmt(cent(w.loanBookOutstanding))} / oracle ${fmt(toCents(expected.totals.loanBookOutstanding))}`,
      pass: sameMoney(stats.totalOutstanding, w.loanBookOutstanding) && cent(stats.totalOutstanding) === toCents(expected.totals.loanBookOutstanding),
    });
    check(CAT, 'dashboard: pendingPaymentRequests / pendingApprovals ตรงกับงานที่ค้างในตารางจริง', {
      input: 'payment_requests + approval_workflows in PENDING',
      expected: { pendingPaymentRequests: Number(dbAgg.pendingRequests), pendingApprovals: Number(dbAgg.pendingWorkflows) },
      actual: { pendingPaymentRequests: stats.pendingPaymentRequests, pendingApprovals: stats.pendingApprovals },
      pass: stats.pendingPaymentRequests === Number(dbAgg.pendingRequests) && stats.pendingApprovals === Number(dbAgg.pendingWorkflows),
    });

    const activity = (await api('GET', '/api/dashboard/recent-activity', { token: tokens.head })).json?.data ?? [];
    const dbActivity = await rows(conn, 'SELECT id, SUBSTRING(CAST(createdAt AS CHAR), 1, 19) t FROM financial_transactions ORDER BY createdAt DESC LIMIT 10');
    const literal = (iso) => String(iso).replace('T', ' ').slice(0, 19);
    const nonIncreasing = activity.every((r, i) => i === 0 || String(r.createdAt) <= String(activity[i - 1].createdAt));
    check(CAT, 'recent-activity: ไม่เกิน 10 แถว เรียง createdAt ใหม่ไปเก่า และตรงกับกลุ่มบนสุดของ DB', {
      input: 'GET /api/dashboard/recent-activity',
      expected: `${dbActivity.length} rows ${dbActivity.map((r) => r.t).join(',')}`,
      actual: `${activity.length} rows ${activity.map((r) => literal(r.createdAt)).join(',')}`,
      pass:
        activity.length > 0 &&
        activity.length <= 10 &&
        nonIncreasing &&
        activity.map((r) => literal(r.createdAt)).sort().join(',') === dbActivity.map((r) => r.t).sort().join(','),
      note: 'endpoint คืน raw entity (ไม่มี wrapper) จึงตรวจ ordering ได้จาก createdAt; id ใช้เทียบเป็น set ไม่ได้เพราะ DB ให้ลำดับไม่เสถียรเมื่อค่าเท่ากัน',
    });
    statusCheck(CAT, 'recent-activity: anonymous = 401, VIEWER = 200', await api('GET', '/api/dashboard/recent-activity', { token: null }), 401);
    statusCheck(CAT, 'recent-activity ของ VIEWER อ่านได้ 200', await api('GET', '/api/dashboard/recent-activity', { token: tokens.viewer }), 200);

    // ============================================================ H. live effect on the ledger
    const snapshot = async (months) => JSON.stringify(await getMonthly(`?months=${months}`));
    const beforeJson = await snapshot(16);
    const base = Object.fromEntries(JSON.parse(beforeJson).rows.map((r) => [r.month, r]));

    const p = product('TST-FLAT-M6');
    const loanRes = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: { customerId: C7, productId: p.id, principalAmount: 2000000, termValue: p.termValue, termUnit: p.termUnit, disbursedAt: '2026-08-31T18:00:00.000Z' },
    });
    if (loanRes.status !== 201) throw new Error(`loan creation failed ${loanRes.status} ${errorMessage(loanRes)}`);
    const loanR = loanRes.json.data.loan;
    createdLoans.push(loanR.id);

    const made = await api('POST', '/api/payment-requests', { token: tokens.op1, body: { loanId: loanR.id, cashAmount: 1200000 } });
    if (made.status !== 201) throw new Error(`payment request failed ${made.status} ${errorMessage(made)}`);
    const approved = await api('POST', `/api/payment-requests/${made.json.data.request.id}/approve`, { token: tokens.checker1, body: {} });
    if (approved.status !== 200) throw new Error(`approve failed ${approved.status} ${errorMessage(approved)}`);
    const payTxId = approved.json.data.transaction.id;
    createdTx.push(payTxId);
    const postedRes = await api('POST', `/api/transactions/${payTxId}/post`, { token: tokens.admin });
    if (postedRes.status !== 200) throw new Error(`post failed ${postedRes.status} ${errorMessage(postedRes)}`);

    const disbRow = (
      await rows(
        conn,
        "SELECT id, CAST(postedAt AS CHAR) posted, amount FROM financial_transactions WHERE loanId = ? AND transactionType = 'DISBURSEMENT'",
        [loanR.id],
      )
    )[0];
    createdTx.push(disbRow.id);
    const disbBucket = String(disbRow.posted).slice(0, 7);
    const disbAmount = cent(disbRow.amount);
    const payAmount = cent((await rows(conn, 'SELECT amount FROM financial_transactions WHERE id = ?', [payTxId]))[0].amount);
    const alloc = postedRes.json.data.allocation ?? {};
    const allocCents = { PENALTY: cent(alloc.PENALTY), PAST_INTEREST: cent(alloc.PAST_INTEREST), PAST_PRINCIPAL: cent(alloc.PAST_PRINCIPAL) };

    check(CAT, 'backdated disbursement: postedAt เก็บเป็น UTC instants ตรงตามที่ส่ง และ report bucket ที่เดือนนั้น', {
      input: `disbursedAt 2026-08-31T18:00:00.000Z -> DB literal "${disbRow.posted}"`,
      expected: { bucket: '2026-08', amount: fmt(cent(2216000)) },
      actual: { bucket: disbBucket, amount: fmt(disbAmount) },
      pass: disbBucket === '2026-08' && disbAmount === cent(2216000),
      note: 'monthKey ของ endpoint ใช้ ISO (UTC) ส่วน SQL bucket ใช้ DATE_FORMAT ของคอลัมน์ DATETIME — ทั้งสองต้องอิง UTC มิฉะนั้นแถวจะย้ายเดือน',
    });

    const after = await getMonthly('?months=16');
    const rowOfMonth = (m) => (after.rows ?? []).find((r) => r.month === m) ?? {};
    check(CAT, 'disbursement ใหม่สะท้อนในแถว 2026-08: disbursed / transactions / outstandingDelta / closing ขยับตรงตาม ledger', {
      input: 'row 2026-08 before vs after',
      expected: {
        disbursed: fmt(cent(base['2026-08'].disbursed) + disbAmount),
        transactions: Number(base['2026-08'].transactions) + 1,
        outstandingDelta: fmt(cent(base['2026-08'].outstandingDelta) + disbAmount),
        closing: fmt(cent(base['2026-08'].closingOutstanding) + disbAmount),
      },
      actual: {
        disbursed: fmt(cent(rowOfMonth('2026-08').disbursed)),
        transactions: rowOfMonth('2026-08').transactions,
        outstandingDelta: fmt(cent(rowOfMonth('2026-08').outstandingDelta)),
        closing: fmt(cent(rowOfMonth('2026-08').closingOutstanding)),
      },
      pass:
        cent(rowOfMonth('2026-08').disbursed) === cent(base['2026-08'].disbursed) + disbAmount &&
        rowOfMonth('2026-08').transactions === Number(base['2026-08'].transactions) + 1 &&
        cent(rowOfMonth('2026-08').outstandingDelta) === cent(base['2026-08'].outstandingDelta) + disbAmount &&
        cent(rowOfMonth('2026-08').closingOutstanding) === cent(base['2026-08'].closingOutstanding) + disbAmount,
    });
    check(CAT, `payment ที่โพสต์วันนี้เข้าแถวเดือนปัจจุบัน (${currentMonth}) เท่านั้น: moneyIn / collected / paid รายส่วนขยับตาม allocation จริง`, {
      input: `row ${currentMonth} before vs after`,
      expected: {
        moneyIn: fmt(cent(base[currentMonth].moneyIn) + payAmount),
        collected: fmt(cent(base[currentMonth].collected) + payAmount),
        interestPaid: fmt(cent(base[currentMonth].interestPaid) + allocCents.PAST_INTEREST),
        principalPaid: fmt(cent(base[currentMonth].principalPaid) + allocCents.PAST_PRINCIPAL),
        penaltyPaid: fmt(cent(base[currentMonth].penaltyPaid) + allocCents.PENALTY),
        transactions: Number(base[currentMonth].transactions) + 1,
      },
      actual: {
        moneyIn: fmt(cent(rowOfMonth(currentMonth).moneyIn)),
        collected: fmt(cent(rowOfMonth(currentMonth).collected)),
        interestPaid: fmt(cent(rowOfMonth(currentMonth).interestPaid)),
        principalPaid: fmt(cent(rowOfMonth(currentMonth).principalPaid)),
        penaltyPaid: fmt(cent(rowOfMonth(currentMonth).penaltyPaid)),
        transactions: rowOfMonth(currentMonth).transactions,
      },
      pass: [
        cent(rowOfMonth(currentMonth).moneyIn) === cent(base[currentMonth].moneyIn) + payAmount,
        cent(rowOfMonth(currentMonth).collected) === cent(base[currentMonth].collected) + payAmount,
        cent(rowOfMonth(currentMonth).interestPaid) === cent(base[currentMonth].interestPaid) + allocCents.PAST_INTEREST,
        cent(rowOfMonth(currentMonth).principalPaid) === cent(base[currentMonth].principalPaid) + allocCents.PAST_PRINCIPAL,
        cent(rowOfMonth(currentMonth).penaltyPaid) === cent(base[currentMonth].penaltyPaid) + allocCents.PENALTY,
        rowOfMonth(currentMonth).transactions === Number(base[currentMonth].transactions) + 1,
      ].every(Boolean),
      note: `allocation จริง PENALTY=${fmt(allocCents.PENALTY)} PAST_INTEREST=${fmt(allocCents.PAST_INTEREST)} PAST_PRINCIPAL=${fmt(allocCents.PAST_PRINCIPAL)} (PENALTY->PAST_INTEREST->PAST_PRINCIPAL)`,
    });
    const deltaTouched = (after.rows ?? [])
      .filter((r) => r.month !== disbBucket && r.month !== currentMonth)
      .filter((r) => cent(r.outstandingDelta) !== cent(base[r.month].outstandingDelta))
      .map((r) => r.month);
    check(CAT, 'แถวเดือนอื่นต้องไม่ขยับ: ธุรกรรมใหม่สองรายการกระทบ outstandingDelta เฉพาะเดือนของตัวเอง', {
      input: 'all other months',
      expected: [],
      actual: deltaTouched,
      pass: deltaTouched.length === 0,
    });
    const shiftWant = (m) => cent(base[m].closingOutstanding) + (m >= disbBucket ? disbAmount : 0) - (m >= currentMonth ? payAmount : 0);
    const shiftBad = (after.rows ?? []).filter((r) => cent(r.closingOutstanding) !== shiftWant(r.month)).map((r) => `${r.month}: got ${fmt(cent(r.closingOutstanding))} want ${fmt(shiftWant(r.month))}`);
    check(CAT, `ปิดยอดต่อเนื่อง: ทุกแถวต้องเลื่อน +${fmt(disbAmount)} ตั้งแต่ ${disbBucket} และ -${fmt(payAmount)} ตั้งแต่ ${currentMonth}`, {
      input: 'closingOutstanding of every row',
      expected: 'no differences',
      actual: shiftBad.join(' | ') || 'ok',
      pass: shiftBad.length === 0,
    });
    check(CAT, 'loan สร้างวันนี้แต่ disbursedAt ย้อนหลัง: loansOpened นับที่ createdAt (2026-10) ส่วน disbursement นับที่ postedAt (2026-08)', {
      input: 'row 2026-10.loansOpened and 2026-08.loansOpened',
      expected: { opened202610: Number(base['2026-10'].loansOpened) + 1, opened202608: Number(base['2026-08'].loansOpened) },
      actual: { opened202610: Number(rowOfMonth('2026-10').loansOpened), opened202608: Number(rowOfMonth('2026-08').loansOpened) },
      pass:
        Number(rowOfMonth('2026-10').loansOpened) === Number(base['2026-10'].loansOpened) + 1 &&
        Number(rowOfMonth('2026-08').loansOpened) === Number(base['2026-08'].loansOpened),
      note: 'สองคอลัมน์จึงตอบคนละคำถาม (กิจกรรมปล่อยกู้ vs การเปิดสัญญา) — เป็นข้อสังเกตของ semantics ไม่ใช่บั๊ก',
    });
    check(CAT, 'loanBookOutstanding ขยับเท่าผลสุทธิของรายการใหม่ และเท่ากับ SUM(currentOutstanding) ใน DB', {
      input: 'data.loanBookOutstanding',
      expected: fmt(cent(w.loanBookOutstanding) + disbAmount - payAmount),
      actual: `${fmt(cent(after.loanBookOutstanding))} / db ${fmt(await bookFromDb())}`,
      pass: cent(after.loanBookOutstanding) === cent(w.loanBookOutstanding) + disbAmount - payAmount && cent(after.loanBookOutstanding) === (await bookFromDb()),
    });
    const statsAfter = dataOf(await api('GET', '/api/dashboard/stats', { token: tokens.admin }));
    check(CAT, 'หลังโพสต์: dashboard.totalOutstanding ต้องขยับเท่า report (สองโมดูลมองสมุดเดียวกัน)', {
      input: 'dashboard vs reports after live postings',
      expected: fmt(cent(after.loanBookOutstanding)),
      actual: `dashboard ${fmt(cent(statsAfter.totalOutstanding))} / reports ${fmt(cent(after.loanBookOutstanding))}`,
      pass: sameMoney(statsAfter.totalOutstanding, after.loanBookOutstanding) && Number(statsAfter.loans) === expected.rowCounts.loans + 1,
    });
    const newLines = await rows(
      conn,
      `SELECT l.component, l.amount FROM financial_transaction_lines l WHERE l.transactionId IN (?)`,
      [[disbRow.id, payTxId]],
    );
    check(CAT, 'ledger ของสองธุรกรรมใหม่: Σ signed lines = ผลสุทธิที่ report แสดงในสมุด', {
      input: 'financial_transaction_lines of the two new transactions',
      expected: fmt(disbAmount - payAmount),
      actual: `${fmt(newLines.reduce((s, l) => s + cent(l.amount), 0))} (${newLines.length} lines: ${newLines.map((l) => `${l.component}=${String(l.amount)}`).join(', ')})`,
      pass: newLines.reduce((s, l) => s + cent(l.amount), 0) === disbAmount - payAmount,
    });

    // ============================================================ J. read-only behaviour + cleanup
    const twiceA = await snapshot(16);
    const twiceB = await snapshot(16);
    const unknownParam = JSON.stringify(await getMonthly('?months=16&unknown=42'));
    check(CAT, 'รายงานคำนวณจาก ledger ทุกครั้ง (ไม่มี cache): เรียกซ้ำได้ผลเหมือนกัน และพารามิเตอร์ไม่รู้จักถูกข้าม', {
      input: 'two identical calls + ?unknown=42',
      expected: 'identical JSON',
      actual: twiceA === twiceB ? (unknownParam === twiceA ? 'identical, extra param ignored' : 'extra param changed the result') : 'DIFFERENT',
      pass: twiceA === twiceB && unknownParam === twiceA,
    });

    await settle();
    await purge();
    await settle(1500);
    await purge();

    const restored = await snapshot(16);
    check(CAT, 'หลังลบข้อมูลของ suite: รายงานกลับมาเป็นค่าเดิมทุกไบต์ (ทุกตัวเลข derive จาก POSTED ledger ล้วน ๆ)', {
      input: 'months=16 before vs after cleanup',
      expected: beforeJson.slice(0, 150),
      actual: restored === beforeJson ? 'identical to baseline' : restored.slice(0, 150),
      pass: restored === beforeJson,
    });
    const counts = {};
    for (const t of TOTAL_TABLES) counts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const dirty = Object.keys(baseline).filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite (endpoint รายงานไม่เคยเขียนลง DB)', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
      pass: dirty.length === 0,
    });
    const bookAfter = await api('GET', '/api/loans?limit=100');
    check(CAT, 'ข้อมูล seed คงเดิม: 21 loan และยอดคงค้างรวม 375,068,000.00 หลัง suite รายงาน', {
      input: 'GET /api/loans after cleanup',
      expected: `${expected.rowCounts.loans} loans, outstanding ${expected.totals.closingOutstanding}`,
      actual: `${bookAfter.json.pagination?.total} loans, outstanding ${bookAfter.json.aggregates?.outstandingTotal}`,
      pass:
        bookAfter.json.pagination?.total === expected.rowCounts.loans &&
        sameMoney(bookAfter.json.aggregates?.outstandingTotal, expected.totals.closingOutstanding),
    });
    statusCheck(CAT, 'loan ของ suite หายจริงหลัง purge: 404', await api('GET', `/api/loans/${loanR.id}`), 404, { input: loanR.loanNumber });
    const idle = await getMonthly(`?months=6&customerId=${CU}`);
    const idleFlowFields = ['disbursed', 'moneyIn', 'reversed', 'writtenOff', 'waived', 'penaltyCharged', 'principalPaid', 'interestPaid', 'penaltyPaid', 'outstandingDelta', 'collected'];
    const idleZero = (idle.rows ?? []).every((r) => idleFlowFields.every((f) => cent(r[f]) === 0) && r.transactions === 0);
    check(CAT, 'ลูกหนี้ที่ไม่มีกิจกรรมในหน้าต่างที่ขอ: แถวกระแสเงินเป็น 0 ทุกเดือน แต่ closing ยัง carry forward ยอดสะสมของลูกหนี้รายนั้น', {
      input: `?customerId=${CU}&months=6 (กิจกรรมสุดท้าย 2026-01)`,
      expected: { rows: 6, allFlowZero: true, closing: fmt(customerLedger), window: `${idle.from}..${idle.to}` },
      actual: {
        rows: idle.rows?.length,
        allFlowZero: idleZero,
        closing: fmt(cent(idle.closingOutstanding)),
        window: `${idle.from}..${idle.to}`,
      },
      pass: idle.rows?.length === 6 && idleZero && cent(idle.closingOutstanding) === customerLedger && cent(idle.closingOutstanding) !== seedBook,
      note: `ปิดยอดของ ${CU} = ${fmt(customerLedger)} ไม่ equal ยอดทั้งสมุด ${fmt(seedBook)} — report ที่ filter แล้วต้องปิดยอดตาม ledger ของลูกหนี้รายนั้นจริง`,
    });
    const finalOracleBad = windowDiff((await getMonthly(`?months=${FULL}`)).rows ?? [], ORACLE_MONTHS.map((m) => expected.apiRows[m]));
    check(CAT, 'สุดท้าย: รายงานทั้งหน้าต่างกลับตรงกับ oracle เดิมทุกแถว (ไม่เหลือรอยจาก suite)', {
      input: `?months=${FULL} after cleanup`,
      expected: 'no differences',
      actual: finalOracleBad.length ? finalOracleBad.join(' ;; ').slice(0, 600) : 'no differences',
      pass: finalOracleBad.length === 0,
    });
  } finally {
    await purge().catch(() => {});
  }
}
