// 3.9 Reconciliation: the POSTED ledger is the financial truth and every run compares it against
// the operational balances. A mismatch is only recorded, never auto-corrected.
//
// Only seeded loans are read. Every loan touched here is created by the suite and removed in
// `purge`; the single exception is a deliberate, test-only hand edit of a SUITE loan's balance
// columns, used to prove mismatch detection, and it is restored before cleanup.
import { api as http, errorMessage, expected, rows, settle, statusCheck, check } from '../lib/harness.mjs';
import { billedInterestCents, fmt, toCents } from '../oracle.mjs';

const CAT = 'reconciliation';

const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];
const cent = (v) => Math.round(Number(v) * 100);
const sameMoney = (a, b) => cent(a) === cent(b);
/** Takes a cents object (what `ledgerOf`/`operationalOf` return). API records carry LAK — wrap them with `centsOf` first. */
const asText = (c) => COMPS.map((k) => `${k}=${fmt(c?.[k] ?? 0)}`).join(' ');
const centsOf = (o) => Object.fromEntries(COMPS.map((k) => [k, cent(o?.[k] ?? 0)]));

export default async function suite(ctx) {
  const { tokens, conn } = ctx;
  const api = (method, path, opts = {}) => (opts.token === null ? http(method, path, opts) : ctx.api(method, path, opts));

  const C5 = '00000000-2000-4000-8000-000000000005';
  const C6 = '00000000-2000-4000-8000-000000000006';

  const userIds = Object.fromEntries(
    (await rows(conn, "SELECT id, username FROM users WHERE username IN ('test_op1','test_op2','test_head')")).map((r) => [r.username, r.id]),
  );

  const baseline = {};
  for (const t of [
    'loans',
    'financial_transactions',
    'financial_transaction_lines',
    'payment_requests',
    'approval_workflows',
    'approval_steps',
    'reconciliation_records',
    'audit_logs',
    'notification_outbox',
    'customer_credits',
    'credit_ledger',
  ]) {
    baseline[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
  }

  const createdLoans = [];
  const createdTx = [];
  const recordIds = [];
  /** Outbox rows caused by this suite that are not reachable by `loanId IN createdLoans`. */
  const trackedOutbox = [];
  const outboxIdsAtStart = new Set((await rows(conn, 'SELECT id FROM notification_outbox')).map((r) => r.id));

  const purge = async () => {
    if (recordIds.length) {
      await conn.query('DELETE FROM reconciliation_records WHERE id IN (?)', [recordIds]);
    }
    if (trackedOutbox.length) {
      await conn.query('DELETE FROM notification_outbox WHERE id IN (?)', [trackedOutbox]);
    }
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
      await conn.query(`DELETE FROM credit_ledger WHERE transactionId IN (${inTx}) OR customerId IN (?)`, [createdLoans, [C5, C6]]);
      await conn.query('DELETE FROM payment_allocations WHERE paymentRequestId IN (SELECT id FROM payment_requests WHERE loanId IN (?))', [createdLoans]);
      await conn.query(`DELETE FROM financial_transaction_lines WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query(`DELETE FROM audit_logs WHERE transactionId IN (${inTx})`, [createdLoans]);
      await conn.query('DELETE FROM financial_transactions WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM payment_requests WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM settlement_agreements WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM reconciliation_records WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM notification_outbox WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM audit_logs WHERE loanId IN (?)', [createdLoans]);
      await conn.query('DELETE FROM customer_credits WHERE customerId IN (?)', [[C5, C6]]);
      await conn.query('DELETE FROM loans WHERE id IN (?)', [createdLoans]);
    }
  };

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);

  const newLoan = async ({ customerId, productCode, principal, disbursedAt, label }) => {
    const p = product(productCode);
    const res = await api('POST', '/api/loans', {
      token: tokens.op1,
      body: { customerId, productId: p.id, principalAmount: principal, termValue: p.termValue, termUnit: p.termUnit, disbursedAt },
    });
    if (res.status !== 201) throw new Error(`${label}: loan creation failed ${res.status} ${errorMessage(res)}`);
    const loan = res.json.data.loan;
    createdLoans.push(loan.id);
    const interestCents = billedInterestCents({
      principalCents: toCents(principal),
      ratePercent: p.interestRate,
      rateUnit: p.interestRatePeriod,
      termValue: p.termValue,
      termUnit: p.termUnit,
    });
    return { ...loan, interestCents };
  };

  const loanView = async (id) => (await api('GET', `/api/loans/${id}`)).json?.data?.loan ?? null;

  /** Per-component sums of the POSTED ledger, read straight from the database. */
  const ledgerOf = async (loanId) => {
    const r = await rows(
      conn,
      `SELECT l.component AS component, SUM(l.amount) AS signedSum
       FROM financial_transaction_lines l JOIN financial_transactions t ON t.id = l.transactionId
       WHERE t.loanId = ? AND t.status = 'POSTED' GROUP BY l.component`,
      [loanId],
    );
    const out = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
    for (const row of r) out[row.component] = cent(row.signedSum);
    return out;
  };

  const operationalOf = (loan) => ({
    PENALTY: cent(loan?.outstanding?.penalty ?? 0),
    PAST_INTEREST: cent(loan?.outstanding?.pastInterest ?? 0),
    PAST_PRINCIPAL: cent(loan?.outstanding?.pastPrincipal ?? 0),
  });

  /**
   * Every run is tracked: a whole-book run writes one row per loan, and those rows belong to
   * seeded loans, so the only way cleanup stays exact is to remember each id as it appears.
   */
  const run = async (token, loanId) => {
    const res = await api('POST', `/api/reconciliation/run${loanId ? `?loanId=${loanId}` : ''}`, { token });
    for (const r of res.json?.data?.records ?? []) recordIds.push(r.id);
    return res;
  };
  const firstRecord = (res) => res.json?.data?.records?.[0] ?? {};

  try {
    // ============================================================ A. one run over the seeded book
    // The strongest single statement about the system: the loan book equals the posted ledger for
    // every seeded loan, with no drift left behind by any earlier suite.
    const bookRun = await run(tokens.admin);
    const book = bookRun.json?.data ?? {};
    check(CAT, `run ทั้งสมุด: ทุก loan ของ seed (${expected.rowCounts.loans} ฉบับ) ให้ผล MATCHED`, {
      input: 'POST /api/reconciliation/run (no loanId)',
      expected: { total: expected.rowCounts.loans, matched: expected.rowCounts.loans, mismatched: 0 },
      actual: { total: book.total, matched: book.matched, mismatched: book.mismatched },
      pass: book.total === expected.rowCounts.loans && book.mismatched === 0 && book.matched === book.total,
    });
    const badRecords = (book.records ?? []).filter((r) => r.status !== 'MATCHED' || COMPS.some((c) => cent(r.difference?.[c] ?? 0) !== 0));
    check(CAT, 'บันทึกที่ MATCHED ต้อง difference = 0 ทั้งสามส่วน', {
      input: 'records[].difference of the book run',
      expected: 'no record with a non-zero difference',
      actual: badRecords.length ? badRecords.map((r) => `${String(r.loanId).slice(0, 8)} ${asText(centsOf(r.difference))}`).join(' | ') : `${book.total} records, all zero`,
      pass: badRecords.length === 0,
    });
    const perLoanFromApi = new Map((book.records ?? []).map((r) => [r.loanId, r]));
    const seededDrift = [];
    for (const [number, info] of Object.entries(expected.loans)) {
      const rec = perLoanFromApi.get(info.loanId);
      const want = Object.fromEntries(COMPS.map((c) => [c, cent(info.outstanding[c])]));
      if (!rec) {
        seededDrift.push(`${number}: ไม่มี reconciliation record`);
        continue;
      }
      if (COMPS.some((c) => cent(rec.operationalOutstanding?.[c] ?? 0) !== want[c])) seededDrift.push(`${number}: operational ${asText(centsOf(rec.operationalOutstanding))} != expected ${asText(want)}`);
      if (COMPS.some((c) => cent(rec.computedFromHistory?.[c] ?? 0) !== want[c])) seededDrift.push(`${number}: ledger ${asText(centsOf(rec.computedFromHistory))} != expected ${asText(want)}`);
    }
    check(CAT, 'เทียบค่าที่ได้กับ expected.json ทีละ loan (21 ฉบับ)', {
      input: 'records vs expected.loans[*].outstanding',
      expected: 'every seeded loan matches expected.json',
      actual: seededDrift.length ? seededDrift.join(' | ') : `${Object.keys(expected.loans).length} loans match the expected book`,
      pass: seededDrift.length === 0,
    });
    const countsNow = async () => ({
      loans: (await rows(conn, 'SELECT COUNT(*) n FROM loans'))[0].n,
      financial_transactions: (await rows(conn, 'SELECT COUNT(*) n FROM financial_transactions'))[0].n,
      financial_transaction_lines: (await rows(conn, 'SELECT COUNT(*) n FROM financial_transaction_lines'))[0].n,
    });
    const countsAfterBook = await countsNow();
    check(CAT, 'run ไม่ใช่ write operation ต่อสมุดเงิน: ไม่แก้ loan และไม่มี transaction/line ใหม่', {
      input: 'row counts after the book run',
      expected: { loans: baseline.loans, financial_transactions: baseline.financial_transactions, financial_transaction_lines: baseline.financial_transaction_lines },
      actual: countsAfterBook,
      note: 'ตารางเดียวที่(expect) ให้ผลต่างคือ reconciliation_records',
      pass:
        countsAfterBook.loans === baseline.loans &&
        countsAfterBook.financial_transactions === baseline.financial_transactions &&
        countsAfterBook.financial_transaction_lines === baseline.financial_transaction_lines,
    });

    // ============================================================ B. roles + auth
    statusCheck(CAT, 'ไม่มี token: run ถูกปฏิเสธ 401', await run(null), 401, { input: 'anonymous POST /run' });
    statusCheck(CAT, 'ไม่มี token: อ่าน records ก็ 401', await api('GET', '/api/reconciliation/records', { token: null }), 401, { input: 'anonymous GET /records' });
    const recordsBeforeRefused = (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records'))[0].n;
    statusCheck(CAT, 'VIEWER เรียก run: 403 (เป็น read-only role สำหรับโมดูลนี้)', await run(tokens.viewer), 403, {
      input: 'POST /run as VIEWER',
      messageIncludes: 'Requires role: MAKER or CHECKER or HEAD_APPROVER or ADMIN',
    });
    check(CAT, 'คำขอที่ถูก 403 ไม่ทิ้ง record ไว้ในตารางเลย', {
      input: 'reconciliation_records count around the refused run',
      expected: recordsBeforeRefused,
      actual: (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records'))[0].n,
      pass: (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records'))[0].n === recordsBeforeRefused,
    });
    const readRoles = [];
    for (const [key, token] of Object.entries(tokens)) {
      const res = await api('GET', '/api/reconciliation/records?limit=5', { token });
      readRoles.push(`${key}:${res.status}`);
    }
    check(CAT, 'ทุก role อ่านประวัติการตรวจได้ (200)', {
      input: 'GET /records as each role',
      expected: 'all 200',
      actual: readRoles.join(' '),
      pass: readRoles.every((r) => r.endsWith(':200')),
    });

    // ============================================================ C. a healthy loan reconciles
    const L = await newLoan({ customerId: C5, productCode: 'TST-FLAT-M6', principal: 2000000, disbursedAt: '2026-03-05T00:00:00.000Z', label: 'REC-L' });
    const ledgerL0 = await ledgerOf(L.id);
    const firstRunRes = await run(tokens.op1, L.id);
    const recL = firstRecord(firstRunRes);
    check(CAT, 'loan ที่เพิ่ง disbursed: run ได้ 1 record สถานะ MATCHED และ difference = 0', {
      input: `POST /run?loanId=${L.loanNumber}`,
      expected: { total: 1, status: 'MATCHED', difference: 'PENALTY=0.00 PAST_INTEREST=0.00 PAST_PRINCIPAL=0.00' },
      actual: { total: firstRunRes.json?.data?.total, status: recL.status, difference: asText(centsOf(recL.difference)) },
      pass: firstRunRes.json?.data?.total === 1 && recL.status === 'MATCHED' && COMPS.every((c) => cent(recL.difference?.[c] ?? -1) === 0),
    });
    check(CAT, 'computedFromHistory = Σ signed lines ของรายการ POSTED จริง (ไม่ใช่ copy ของยอดคงค้าง)', {
      input: L.loanNumber,
      expected: asText(ledgerL0),
      actual: asText(centsOf(recL.computedFromHistory)),
      pass: COMPS.every((c) => cent(recL.computedFromHistory?.[c] ?? -1) === ledgerL0[c]),
    });
    const operationalL0 = operationalOf(await loanView(L.id));
    check(CAT, 'operationalOutstanding = ยอดคงค้างที่ loan กำลังถืออยู่', {
      input: L.loanNumber,
      expected: asText(operationalL0),
      actual: asText(centsOf(recL.operationalOutstanding)),
      pass: COMPS.every((c) => cent(recL.operationalOutstanding?.[c] ?? -1) === operationalL0[c]),
    });
    const recRow = (await rows(conn, 'SELECT id, loanId, status, runBy, resolvedAt, createdAt FROM reconciliation_records WHERE id = ?', [recL.id]))[0];
    check(CAT, 'record เก็บ runBy เป็น user id ที่เรียกจริง พร้อม createdAt', {
      input: 'reconciliation_records row',
      expected: { runBy: userIds.test_op1, loanId: L.id },
      actual: { runBy: recRow?.runBy, loanId: recRow?.loanId },
      pass: recRow?.runBy === userIds.test_op1 && recRow?.loanId === L.id && !!recRow?.createdAt,
    });
    check(CAT, 'resolvedAt เป็น NULL เสมอ: ไม่มี endpoint ใดปิดรายการได้ (ข้อสังเกต F-REC-3)', {
      input: 'reconciliation_records.resolvedAt',
      expected: 'null',
      actual: String(recRow?.resolvedAt),
      pass: recRow?.resolvedAt === null,
      note: 'F-REC-3: คอลัมน์ resolvedAt ถูก reserve ไว้แต่ไม่มี API เขียนถึง mismatch จึงค้างในสถานะเปิดตลอด ต้องตามดูจาก audit เอาเอง',
    });
    check(CAT, 'run ที่ MATCHED ไม่สร้าง audit row (บันทึกเฉพาะ mismatch)', {
      input: `audit action RECONCILIATION_MISMATCH on ${L.loanNumber}`,
      expected: 0,
      actual: String((await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action = 'RECONCILIATION_MISMATCH' AND loanId = ?", [L.id]))[0].n),
      pass: (await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action = 'RECONCILIATION_MISMATCH' AND loanId = ?", [L.id]))[0].n === 0,
    });

    // ============================================================ D. unposted work is invisible
    const draftWaiver = await api('POST', '/api/transactions/waivers', {
      token: tokens.op1,
      body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 50000, PAST_PRINCIPAL: 0 }, reason: 'draft ยังไม่ได้อนุมัติ' },
    });
    const draftTxId = draftWaiver.json?.data?.transaction?.id;
    if (draftTxId) createdTx.push(draftTxId);
    const draftLedger = await ledgerOf(L.id);
    const draftRun = firstRecord(await run(tokens.op1, L.id));
    check(CAT, 'waiver ที่ยัง PENDING_APPROVAL ไม่มีผลต่อการ reconcile (นับเฉพาะ POSTED)', {
      input: `run with a pending waiver of 50,000 on ${L.loanNumber}`,
      expected: { status: 'MATCHED', computed: asText(draftLedger) },
      actual: { status: draftRun.status, computed: asText(centsOf(draftRun.computedFromHistory)) },
      pass: draftRun.status === 'MATCHED' && COMPS.every((c) => cent(draftRun.computedFromHistory?.[c] ?? -1) === draftLedger[c]),
    });
    const draftStep = (await api('GET', '/api/approvals/pending?limit=200', { token: tokens.checker1 })).json?.data?.find((i) => i.subjectId === draftTxId);
    const approvedDraft = await api('POST', `/api/approvals/steps/${draftStep.stepId}/decision`, { token: tokens.checker1, body: { decision: 'APPROVE' } });
    const postedDraft = await api('POST', `/api/transactions/${draftTxId}/post`, { token: tokens.admin });
    const postedLedger = await ledgerOf(L.id);
    const postedRun = firstRecord(await run(tokens.op1, L.id));
    check(CAT, 'เมื่ออนุมัติ+โพสต์ waiver แล้ว reconciliation ยัง MATCHED (สองฝั่งขยับพร้อมกัน)', {
      input: `approve+post waiver 50,000 on ${L.loanNumber}`,
      expected: { approve: 200, post: 200, status: 'MATCHED', interest: fmt(postedLedger.PAST_INTEREST) },
      actual: { approve: approvedDraft.status, post: postedDraft.status, status: postedRun.status, interest: fmt(cent(postedRun.computedFromHistory?.PAST_INTEREST ?? -1)) },
      pass:
        approvedDraft.status === 200 &&
        postedDraft.status === 200 &&
        postedRun.status === 'MATCHED' &&
        cent(postedRun.computedFromHistory?.PAST_INTEREST ?? -1) === L.interestCents - toCents(50000) &&
        postedLedger.PAST_INTEREST === L.interestCents - toCents(50000),
    });

    // ============================================================ E. forced drift -> MISMATCHED
    // Test-only fixture: a hand edit of a SUITE loan's balance columns, restored before cleanup.
    const operationalBefore = operationalOf(await loanView(L.id));
    await conn.query(
      'UPDATE loans SET outstandingPastInterest = outstandingPastInterest - 50000, currentOutstanding = currentOutstanding - 50000 WHERE id = ?',
      [L.id],
    );
    const tampered = operationalOf(await loanView(L.id));
    check(CAT, 'ตั้งค่าทดสอบ: แก้ยอดคงค้างของ loan suite ด้วยมือ −50,000 (ไม่แตะข้อมูล seed)', {
      input: 'direct UPDATE of the suite loan balance',
      expected: fmt(operationalBefore.PAST_INTEREST - toCents(50000)),
      actual: fmt(tampered.PAST_INTEREST),
      pass: tampered.PAST_INTEREST === operationalBefore.PAST_INTEREST - toCents(50000),
    });
    const mm = firstRecord(await run(tokens.head, L.id));
    check(CAT, 'ยอดคงค้างกับ ledger ไม่ตรงกัน: ได้ MISMATCHED และ difference = operational − ledger', {
      input: L.loanNumber,
      expected: { status: 'MISMATCHED', difference: 'PENALTY=0.00 PAST_INTEREST=-50000.00 PAST_PRINCIPAL=0.00' },
      actual: { status: mm.status, difference: asText(centsOf(mm.difference)) },
      pass:
        mm.status === 'MISMATCHED' &&
        cent(mm.difference?.PENALTY ?? 0) === 0 &&
        cent(mm.difference?.PAST_INTEREST ?? 0) === -toCents(50000) &&
        cent(mm.difference?.PAST_PRINCIPAL ?? 0) === 0,
    });
    const stillTampered = operationalOf(await loanView(L.id));
    check(CAT, 'run ไม่ auto-correct: หลังพบ mismatch ยอดคงค้างของ loan ยังเหมือนเดิม', {
      input: 'loan balances after the mismatching run',
      expected: asText(tampered),
      actual: asText(stillTampered),
      pass: COMPS.every((c) => stillTampered[c] === tampered[c]),
      note: 'locked section 3: ความผิดพลาดต้องถูกบันทึกไว้แล้วแก้ด้วยการอนุมัติ adjustment ไม่ใช่งาน reconcile เขียนยอดเอง',
    });
    const mmAudit = (
      await rows(conn, "SELECT action, amount, reason, userId, previousBalance, newBalance FROM audit_logs WHERE action = 'RECONCILIATION_MISMATCH' AND loanId = ? ORDER BY createdAt", [L.id])
    )[0];
    const auditPrev = JSON.parse(String(mmAudit?.previousBalance ?? '{}'));
    const auditNew = JSON.parse(String(mmAudit?.newBalance ?? '{}'));
    const ledgerAfterTamper = await ledgerOf(L.id);
    check(CAT, 'mismatch สร้าง audit RECONCILIATION_MISMATCH พร้อมยอดสองฝั่ง และ amount = Σ|difference|', {
      input: 'audit_logs row of the mismatch',
      expected: {
        action: 'RECONCILIATION_MISMATCH',
        amount: '50000.00',
        userId: userIds.test_head,
        previousInterest: fmt(tampered.PAST_INTEREST),
        newInterest: fmt(ledgerAfterTamper.PAST_INTEREST),
      },
      actual: {
        action: mmAudit?.action,
        amount: fmt(cent(mmAudit?.amount ?? 0)),
        userId: mmAudit?.userId,
        previousInterest: fmt(cent(auditPrev.PAST_INTEREST)),
        newInterest: fmt(cent(auditNew.PAST_INTEREST)),
      },
      pass:
        mmAudit?.action === 'RECONCILIATION_MISMATCH' &&
        sameMoney(mmAudit?.amount, 50000) &&
        mmAudit?.userId === userIds.test_head &&
        cent(auditPrev.PAST_INTEREST) === tampered.PAST_INTEREST &&
        cent(auditNew.PAST_INTEREST) === ledgerAfterTamper.PAST_INTEREST &&
        String(mmAudit?.reason).includes('Resolve via approved adjustment'),
    });
    const secondMm = await run(tokens.head, L.id);
    const mmCount = (await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action = 'RECONCILIATION_MISMATCH' AND loanId = ?", [L.id]))[0].n;
    check(CAT, 'run ซ้ำบน loan เดิม: สร้าง record ใหม่ทุกครั้ง (ไม่มี dedup — ข้อสังเกต F-REC-1)', {
      input: 'two runs in a row on the same mismatching loan',
      expected: { total: 1, status: 'MISMATCHED', auditRows: 2 },
      actual: { total: secondMm.json?.data?.total, status: firstRecord(secondMm).status, auditRows: mmCount },
      pass: secondMm.json?.data?.total === 1 && firstRecord(secondMm).status === 'MISMATCHED' && mmCount === 2,
      note: 'F-REC-1: endpoint เป็น append-only จึงดูประวัติการตรวจย้อนหลังได้ แต่ไม่มีกลไกกันรันซ้ำหรือสรุปสถานะล่าสุด',
    });

    // ---- the documented resolution path: an approved adjustment
    const adjust = await api('POST', '/api/transactions/adjustments', {
      token: tokens.op1,
      body: { loanId: L.id, componentAmounts: { PENALTY: 0, PAST_INTEREST: 50000, PAST_PRINCIPAL: 0 }, reason: 'แก้ยอดคงค้างตามผล reconciliation' },
    });
    const adjustTxId = adjust.json?.data?.transaction?.id;
    if (adjustTxId) createdTx.push(adjustTxId);
    const adjustStep = (await api('GET', '/api/approvals/pending?limit=200', { token: tokens.checker1 })).json?.data?.find((i) => i.subjectId === adjustTxId);
    const adjustApproved = await api('POST', `/api/approvals/steps/${adjustStep.stepId}/decision`, { token: tokens.checker1, body: { decision: 'APPROVE' } });
    const adjustPosted = await api('POST', `/api/transactions/${adjustTxId}/post`, { token: tokens.admin });
    const afterAdjustRun = firstRecord(await run(tokens.op1, L.id));
    check(CAT, 'adjustment ที่อนุมัติ+โพสต์แล้วขยับสองฝั่งพร้อมกัน: difference ยัง −50,000 (F-REC-2)', {
      input: `${L.loanNumber} after posting a +50,000 PAST_INTEREST adjustment`,
      expected: { approve: 200, post: 200, status: 'MISMATCHED', difference: 'PAST_INTEREST=-50000.00' },
      actual: {
        approve: adjustApproved.status,
        post: adjustPosted.status,
        status: afterAdjustRun.status,
        difference: `PAST_INTEREST=${fmt(cent(afterAdjustRun.difference?.PAST_INTEREST ?? 0))}`,
      },
      pass:
        adjustApproved.status === 200 &&
        adjustPosted.status === 200 &&
        afterAdjustRun.status === 'MISMATCHED' &&
        cent(afterAdjustRun.difference?.PAST_INTEREST ?? 0) === -toCents(50000),
      note: 'F-REC-2: ข้อความใน audit ชี้ให้แก้ด้วย "approved adjustment" แต่เมื่อ loan balance ผูกกับ ledger เสมอ adjustment จึงเลื่อนทั้งสองฝั่งพร้อมกัน — ยอดที่ถูกแก้ด้วยมือต้อง revert ข้อมูล ไม่ใช่ posted adjustment',
    });

    // ---- reverting the hand edit is what actually heals the book
    await conn.query('UPDATE loans SET outstandingPastInterest = outstandingPastInterest + 50000, currentOutstanding = currentOutstanding + 50000 WHERE id = ?', [L.id]);
    const healedLedger = await ledgerOf(L.id);
    const healedRun = firstRecord(await run(tokens.op1, L.id));
    check(CAT, 'เมื่อ revert ยอดที่ถูกแก้ด้วยมือ: run กลับให้ MATCHED และสองฝั่งตรงกันจริง', {
      input: L.loanNumber,
      expected: { status: 'MATCHED', ledger: asText(healedLedger) },
      actual: { status: healedRun.status, ledger: asText(centsOf(healedRun.computedFromHistory)) },
      pass:
        healedRun.status === 'MATCHED' &&
        COMPS.every((c) => cent(healedRun.operationalOutstanding?.[c] ?? -1) === healedLedger[c]) &&
        COMPS.every((c) => cent(healedRun.difference?.[c] ?? -1) === 0),
    });
    const loanAfterHeal = operationalOf(await loanView(L.id));
    check(CAT, 'ยอดคงค้างปิดรอบตรงกับตัวเลขจริง: ดอกเบี้ย billed − waiver + adjustment, เงินต้นเท่าเดิม', {
      input: L.loanNumber,
      expected: `PENALTY=0.00 PAST_INTEREST=${fmt(L.interestCents)} PAST_PRINCIPAL=${fmt(toCents(2000000))}`,
      actual: asText(loanAfterHeal),
      pass:
        loanAfterHeal.PAST_INTEREST === L.interestCents &&
        loanAfterHeal.PAST_PRINCIPAL === toCents(2000000) &&
        loanAfterHeal.PENALTY === 0,
      note: `waiver 50,000 ถูกชดด้วย adjustment +50,000 ยอดจึงกลับมาเท่าดอกเบี้ยที่ billed ตั้งแต่ต้น`,
    });

    // ============================================================ F. a second loan + whole book again
    const M = await newLoan({ customerId: C6, productCode: 'TST-NOPEN-ZERO', principal: 400000, disbursedAt: '2026-07-05T00:00:00.000Z', label: 'REC-M' });
    const mRun = firstRecord(await run(tokens.op2, M.id));
    check(CAT, 'loan ดอกเบี้ย 0: MATCHED ทันทีที่ disbursed และยอดเงินต้นตรงตามสัญญา', {
      input: M.loanNumber,
      expected: { status: 'MATCHED', principal: '400000.00' },
      actual: { status: mRun.status, principal: fmt(cent(mRun.operationalOutstanding?.PAST_PRINCIPAL ?? -1)) },
      pass: mRun.status === 'MATCHED' && cent(mRun.operationalOutstanding?.PAST_PRINCIPAL ?? -1) === toCents(400000),
    });
    check(CAT, 'run โดย MAKER คนละคนถูกบันทึก runBy ต่างกัน', {
      input: 'reconciliation_records.runBy',
      expected: userIds.test_op2,
      actual: String((await rows(conn, 'SELECT runBy FROM reconciliation_records WHERE id = ?', [mRun.id]))[0]?.runBy),
      pass: (await rows(conn, 'SELECT runBy FROM reconciliation_records WHERE id = ?', [mRun.id]))[0]?.runBy === userIds.test_op2,
    });
    const bookRun2 = (await run(tokens.admin)).json?.data ?? {};
    check(CAT, 'run ทั้งสมุดครั้งที่สอง: loan ที่ suite สร้างรวมอยู่ด้วยและ MATCHED หมด', {
      input: 'POST /api/reconciliation/run after suite writes',
      expected: { total: expected.rowCounts.loans + createdLoans.length, mismatched: 0 },
      actual: { total: bookRun2.total, mismatched: bookRun2.mismatched },
      pass: bookRun2.total === expected.rowCounts.loans + createdLoans.length && bookRun2.mismatched === 0,
    });

    // ============================================================ G. unknown loan + input handling
    const unknownRun = await run(tokens.op1, '00000000-9999-4000-8000-000000000096');
    check(CAT, 'loanId ที่ไม่มีจริง: คืน 200 พร้อม total 0 (ไม่ใช่ 404)', {
      input: 'POST /run?loanId=<unknown uuid>',
      expected: { status: 200, total: 0, records: 0 },
      actual: { status: unknownRun.status, total: unknownRun.json?.data?.total, records: (unknownRun.json?.data?.records ?? []).length },
      pass: unknownRun.status === 200 && unknownRun.json?.data?.total === 0 && (unknownRun.json?.data?.records ?? []).length === 0,
      note: 'ข้อสังเกต: ไม่ validate loanId จึงไม่มี record กำพร้า แต่ caller ก็ไม่ได้ signal ว่า id ผิด',
    });
    const junkRun = await run(tokens.op1, 'not-a-uuid');
    check(CAT, 'loanId ไม่ใช่ uuid: ไม่ crash ไม่ create record และไม่มีแถวแปลกปลอมค้าง', {
      input: 'loanId=not-a-uuid',
      expected: { status: 200, total: 0, strayRows: 0 },
      actual: {
        status: junkRun.status,
        total: junkRun.json?.data?.total,
        strayRows: (await rows(conn, "SELECT COUNT(*) n FROM reconciliation_records WHERE loanId = 'not-a-uuid'"))[0].n,
      },
      pass: junkRun.status === 200 && junkRun.json?.data?.total === 0 && (await rows(conn, "SELECT COUNT(*) n FROM reconciliation_records WHERE loanId = 'not-a-uuid'"))[0].n === 0,
    });

    // ============================================================ H. history endpoints
    const listAll = await api('GET', '/api/reconciliation/records?limit=100', { token: tokens.viewer });
    check(CAT, 'GET /records คืน data เป็น array พร้อม pagination (page/limit/total)', {
      input: 'GET /records?limit=100',
      expected: { isArray: true, page: 1, limit: 100, total: (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records'))[0].n },
      actual: {
        isArray: Array.isArray(listAll.json?.data),
        page: listAll.json?.pagination?.page,
        limit: listAll.json?.pagination?.limit,
        total: listAll.json?.pagination?.total,
      },
      pass:
        Array.isArray(listAll.json?.data) &&
        listAll.json?.pagination?.page === 1 &&
        listAll.json?.pagination?.limit === 100 &&
        listAll.json?.pagination?.total === (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records'))[0].n,
    });
    const clamped = await api('GET', '/api/reconciliation/records?limit=500&page=0', { token: tokens.viewer });
    check(CAT, 'pagination clamp: limit 500 -> 100, page 0 -> 1', {
      input: 'GET /records?limit=500&page=0',
      expected: { page: 1, limit: 100 },
      actual: { page: clamped.json?.pagination?.page, limit: clamped.json?.pagination?.limit },
      pass: clamped.json?.pagination?.page === 1 && clamped.json?.pagination?.limit === 100,
    });
    const pageOne = await api('GET', '/api/reconciliation/records?limit=5&page=1', { token: tokens.viewer });
    const pageTwo = await api('GET', '/api/reconciliation/records?limit=5&page=2', { token: tokens.viewer });
    const pageOneIds = new Set((pageOne.json?.data ?? []).map((r) => r.id));
    check(CAT, 'การแบ่งหน้าไม่ให้แถวซ้ำกันระหว่างหน้า และเรียงใหม่ที่สุดก่อน', {
      input: 'page 1 vs page 2 at limit 5',
      expected: 'no duplicate ids across pages',
      actual: `${(pageTwo.json?.data ?? []).filter((r) => pageOneIds.has(r.id)).length} duplicates over ${pageOneIds.size}+${(pageTwo.json?.data ?? []).length} rows`,
      pass: (pageTwo.json?.data ?? []).every((r) => !pageOneIds.has(r.id)) && (pageOne.json?.data ?? []).length === 5,
    });
    const listMm = await api('GET', '/api/reconciliation/records?status=MISMATCHED&limit=100', { token: tokens.viewer });
    check(CAT, 'filter status=MISMATCHED คืนเฉพาะ mismatch และมียอดของ loan ที่ทดสอบ', {
      input: 'GET /records?status=MISMATCHED',
      expected: { onlyMismatched: true, containsL: true },
      actual: {
        onlyMismatched: (listMm.json?.data ?? []).every((r) => r.status === 'MISMATCHED'),
        containsL: (listMm.json?.data ?? []).some((r) => r.loanId === L.id),
      },
      pass: (listMm.json?.data ?? []).length > 0 && (listMm.json?.data ?? []).every((r) => r.status === 'MISMATCHED') && (listMm.json?.data ?? []).some((r) => r.loanId === L.id),
    });
    const listBogus = await api('GET', '/api/reconciliation/records?status=NOT_A_STATUS&limit=100', { token: tokens.viewer });
    check(CAT, 'status ที่ไม่รู้จัก: 200 + ข้อมูลว่าง (ไม่ validate enum)', {
      input: 'GET /records?status=NOT_A_STATUS',
      expected: { http: 200, rows: 0 },
      actual: { http: listBogus.status, rows: (listBogus.json?.data ?? []).length },
      pass: listBogus.status === 200 && (listBogus.json?.data ?? []).length === 0,
    });
    const byLoan = await api('GET', `/api/reconciliation/records?loanId=${M.id}&limit=100`, { token: tokens.viewer });
    const mRecordRows = (await rows(conn, 'SELECT COUNT(*) n FROM reconciliation_records WHERE loanId = ?', [M.id]))[0].n;
    check(CAT, 'filter loanId คืนเฉพาะ record ของ loan นั้น และให้ครบทุกครั้งที่รัน', {
      input: `loanId=${M.loanNumber}`,
      expected: { allOfLoan: true, count: mRecordRows },
      actual: { allOfLoan: (byLoan.json?.data ?? []).every((r) => r.loanId === M.id), count: (byLoan.json?.data ?? []).length },
      pass: (byLoan.json?.data ?? []).length === mRecordRows && (byLoan.json?.data ?? []).every((r) => r.loanId === M.id),
      note: `M ถูกรันสองครั้ง (รายตัว + ทั้งสมุด) จึงมี ${mRecordRows} record — endpoint เป็น append-only`,
    });
    const oneRecord = await api('GET', `/api/reconciliation/records/${mm.id}`, { token: tokens.viewer });
    check(CAT, 'GET /records/:id คืน record เดียวพร้อม JSON ทั้งสามช่อง', {
      input: mm.id,
      expected: { status: 'MISMATCHED', differenceKeys: 'PENALTY,PAST_INTEREST,PAST_PRINCIPAL' },
      actual: { status: oneRecord.json?.data?.status, differenceKeys: Object.keys(oneRecord.json?.data?.difference ?? {}).sort().join(',') },
      pass: oneRecord.status === 200 && oneRecord.json?.data?.status === 'MISMATCHED' && COMPS.every((c) => oneRecord.json.data.difference?.[c] !== undefined),
    });
    statusCheck(CAT, 'GET /records/:id ของ id ที่ไม่มี: 404 พร้อมข้อความชัดเจน', await api('GET', '/api/reconciliation/records/00000000-9999-4000-8000-000000000095', { token: tokens.viewer }), 404, {
      input: 'unknown record id',
      messageIncludes: 'Reconciliation record not found',
    });
    statusCheck(CAT, 'record เป็น read-only: PUT /records/:id ไม่มี route (404)', await api('PUT', `/api/reconciliation/records/${mm.id}`, { token: tokens.admin, body: { status: 'MATCHED' } }), 404, {
      input: 'PUT /records/:id',
      messageIncludes: 'Not found',
      note: 'ห้ามปิด/แก้สถานะ record ผ่าน API สอดคล้องกับ resolvedAt ที่ไม่มีใครเขียน',
    });

    // ============================================================ I. money never moves because of reconciliation
    const before = await countsNow();
    await run(tokens.admin);
    const after = await countsNow();
    check(CAT, 'reconciliation สร้างเฉพาะ record ไม่สร้าง transaction/line และไม่แก้ loan', {
      input: 'transaction + line + loan counts around a whole-book run',
      expected: before,
      actual: after,
      pass: before.loans === after.loans && before.financial_transactions === after.financial_transactions && before.financial_transaction_lines === after.financial_transaction_lines,
    });

    // ============================================================ J. cleanup
    await settle();
    const untracked = (await rows(conn, `SELECT COUNT(*) n FROM reconciliation_records WHERE id NOT IN (?)`, [recordIds]))[0].n;
    check(CAT, 'ทุก record ที่เกิดใน suite อยู่ในรายการที่จะลบ (ไม่มี record หลุดการติดตาม)', {
      input: 'reconciliation_records not captured by this suite',
      expected: 0,
      actual: untracked,
      pass: untracked === 0,
    });

    const outboxSince = async () => (await rows(conn, 'SELECT id, type, loanId FROM notification_outbox')).filter((r) => !outboxIdsAtStart.has(r.id));

    await purge();
    // Notification rows are enqueued inside the request transaction, but a request that finishes
    // just before cleanup can still commit after the purge statement ran. Second pass closes it.
    await settle(1500);
    const lateOutbox = await outboxSince();
    for (const r of lateOutbox) trackedOutbox.push(r.id);
    if (lateOutbox.length) await purge();
    check(CAT, 'notification ที่เกิดใน suite ถูกลบครบ (รวมแถวที่ commit ช้ากว่า purge ครั้งแรก)', {
      input: 'outbox rows still present after cleanup',
      expected: 0,
      actual: (await outboxSince()).length,
      pass: (await outboxSince()).length === 0,
      note: lateOutbox.length ? `รอบสองลบแถวที่เข้าช้า: ${lateOutbox.map((r) => `${r.type}/${String(r.loanId).slice(0, 8)}`).join(', ')}` : ' purge ครั้งเดียวก็ครบ',
    });

    const counts = {};
    for (const t of Object.keys(baseline)) counts[t] = (await rows(conn, `SELECT COUNT(*) n FROM ${t}`))[0].n;
    const dirty = Object.keys(baseline).filter((t) => counts[t] !== baseline[t]);
    check(CAT, 'หลัง purge: จำนวนแถวทุกตารางกลับเท่าก่อนเริ่ม suite', {
      input: 'row counts before vs after',
      expected: JSON.stringify(baseline),
      actual: JSON.stringify(counts),
      note: dirty.length ? `ตารางที่ยังต่าง: ${dirty.join(', ')}` : '',
      pass: dirty.length === 0,
    });
    const bookAfter = await api('GET', '/api/loans?limit=100');
    check(CAT, 'ข้อมูล seed ครบ 21 loan และยอดคงค้างรวมเท่าเดิมหลัง suite', {
      input: 'GET /api/loans after cleanup',
      expected: `${expected.rowCounts.loans} loans, outstanding ${expected.totals.closingOutstanding}`,
      actual: `${bookAfter.json.pagination?.total} loans, outstanding ${bookAfter.json.aggregates?.outstandingTotal}`,
      pass:
        bookAfter.json.pagination?.total === expected.rowCounts.loans &&
        sameMoney(bookAfter.json.aggregates?.outstandingTotal, expected.totals.closingOutstanding),
    });
    statusCheck(CAT, 'record ของ suite หายจริงหลัง purge: 404', await api('GET', `/api/reconciliation/records/${mm.id}`), 404, { input: mm.id });
    statusCheck(CAT, 'loan ของ suite หายจริงหลัง purge: 404', await api('GET', `/api/loans/${L.id}`), 404, { input: L.loanNumber });
  } catch (err) {
    check(CAT, 'suite 09 ต้องรันจนจบโดยไม่ throw', {
      input: 'run',
      expected: 'no exception',
      actual: `${err?.message ?? err}`,
      pass: false,
      note: String(err?.stack ?? '').slice(0, 400),
    });
    await purge().catch(() => {});
    throw err;
  }
}
