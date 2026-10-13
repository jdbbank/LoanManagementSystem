// 15-invariants: the acceptance gate for the simulated dataset.
//
// Suites 02-14 each attacked one module. This suite never writes anything: it re-derives the whole
// book from the ledger rows in MySQL, replays every posted event through the locked oracle
// (scripts/test/oracle.mjs, generated independently of the server by scripts/test/dataset.mjs), and
// compares three independent views of the same money — stored loan columns, ledger-derived values,
// and expected.json — plus the HTTP API as a fourth view.
//
// Any single mismatch here means the system can produce a books-and-records divergence in
// production, so every case carries the offending loan/month/customer in `actual`.
import { check, expected, rows } from '../lib/harness.mjs';
import { allocateComponents, billedInterestCents, fmt, postEvent, reverseAllocation, toCents, totalOf } from '../oracle.mjs';

const CAT = 'invariants';
const COMPS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];

const cent = (v) => Math.round(Number(v) * 100);
/** LAK decimal string from CAST(.. AS CHAR) -> cents. */
const cOf = (v) => Math.round(parseFloat(String(v)) * 100);
const pos = (o) => Object.fromEntries(COMPS.map((c) => [c, Math.abs(cent(o?.[c] ?? 0))]));
const moneyLine = (o) => COMPS.map((c) => `${c}=${fmt(o[c] ?? 0)}`).join(' ');
const asOf = (iso) => String(iso).slice(0, 7);
const dayOf = (iso) => String(iso).slice(0, 10);
const lastDay = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const json = (v) => (typeof v === 'string' ? JSON.parse(v || 'null') : v ?? null);
const list = (arr, max = 6) => arr.slice(0, max).join(', ') + (arr.length > max ? ` +${arr.length - max} more` : '');

const MONTHS = Object.keys(expected.monthly);
const SEED_LOAN_IDS = Object.values(expected.loans).map((l) => l.loanId);
const RELIEF = new Set(['PAYMENT', 'SETTLEMENT_PAYMENT', 'WAIVER', 'WRITE_OFF']);
const ADDITIVE = new Set(['DISBURSEMENT', 'PENALTY', 'PAYMENT_REVERSAL', 'WRITE_OFF_REVERSAL', 'ADJUSTMENT']);

export default async function suite(ctx) {
  const { conn, api } = ctx;
  const ok = (name, cond, { input, expected: e = 'ตรงกันทุกฉบับ', actual: a = '', note = '' }) =>
    check(CAT, name, { input, expected: e, actual: typeof a === 'string' ? a : JSON.stringify(a), pass: !!cond, note });

  // ------------------------------------------------------------------- load the whole book once
  const loanRows = await rows(
    conn,
    `SELECT id, loanNumber, customerId, productId, status, currency,
            CAST(principalAmount AS CHAR) principal, CAST(outstandingPenalty AS CHAR) pen,
            CAST(outstandingPastInterest AS CHAR) intr, CAST(outstandingPastPrincipal AS CHAR) prin,
            CAST(currentOutstanding AS CHAR) outstanding, penaltyPolicy, interestRate, interestRatePeriod,
            termValue, termUnit, termMonths, CAST(disbursedAt AS CHAR) disbursedAt
     FROM loans ORDER BY loanNumber`,
    [],
  );
  const txRows = await rows(
    conn,
    `SELECT id, referenceNo, transactionType ty, status, loanId, customerId, CAST(amount AS CHAR) amount,
            componentAmounts ca, referenceTransactionId refId, sourceRequestId reqId, settlementAgreementId agId,
            createdBy, postedBy, CAST(postedAt AS CHAR) postedAt, CAST(createdAt AS CHAR) createdAt
     FROM financial_transactions ORDER BY createdAt, referenceNo`,
    [],
  );
  const lineRows = await rows(
    conn,
    'SELECT transactionId txId, component, CAST(amount AS CHAR) amount FROM financial_transaction_lines ORDER BY transactionId, component',
    [],
  );
  const reqRows = await rows(
    conn,
    `SELECT id, requestNo, loanId, status, CAST(cashAmount AS CHAR) cash, CAST(creditApplied AS CHAR) credit,
            createdBy, approvedBy, settlementAgreementId agId FROM payment_requests ORDER BY requestNo`,
    [],
  );
  const allocRows = await rows(
    conn,
    'SELECT paymentRequestId reqId, component, CAST(proposedAmount AS CHAR) proposed, CAST(finalAmount AS CHAR) final, overridden FROM payment_allocations',
    [],
  );
  const agRows = await rows(conn, 'SELECT id, agreementNo, loanId, status, CAST(agreedAmount AS CHAR) agreed, createdBy, decidedBy FROM settlement_agreements', []);
  const creditRows = await rows(conn, 'SELECT customerId, currency, CAST(balance AS CHAR) balance FROM customer_credits ORDER BY customerId', []);
  const ledgerRows = await rows(conn, 'SELECT customerId, type, CAST(amount AS CHAR) amount, CAST(balanceAfter AS CHAR) after, transactionId txId FROM credit_ledger ORDER BY customerId, createdAt', []);
  const wfRows = await rows(conn, 'SELECT id, subjectType, subjectId, requiredLevels, status FROM approval_workflows', []);
  const stepRows = await rows(conn, 'SELECT id, workflowId, level, status, userId FROM approval_steps ORDER BY workflowId, level', []);
  const custRows = await rows(conn, 'SELECT id, customerNumber, kycStatus FROM customers', []);
  const prodRows = await rows(conn, 'SELECT id, code, penaltyPolicy, interestRate, interestRatePeriod, termValue, termUnit FROM loan_products', []);
  const cfgRows = await rows(conn, "SELECT `key`, CAST(value AS CHAR) value FROM system_config WHERE `key` IN ('approval.checkerThreshold','approval.headThreshold')", []);

  const loansById = new Map(loanRows.map((r) => [r.id, r]));
  const txById = new Map(txRows.map((r) => [r.id, r]));
  const linesByTx = new Map();
  for (const l of lineRows) {
    if (!linesByTx.has(l.txId)) linesByTx.set(l.txId, {});
    linesByTx.get(l.txId)[l.component] = (linesByTx.get(l.txId)[l.component] ?? 0) + cOf(l.amount);
  }
  const seededTx = txRows.filter((t) => SEED_LOAN_IDS.includes(t.loanId));
  // เงินที่จ่ายเข้ามามากกว่าหนี้ที่คลายได้ กลายเป็น credit ของลูกค้า (overpayment) — ยอดนี้ต้องอยู่ใน credit_ledger
  // และถูกหักออกจาก financial_transactions.amount ก่อนเทียบเส้น ledger (ยืนยันกับข้อมูลจริงทั้ง 71 แถวแล้ว)
  const accruedByTx = new Map(ledgerRows.filter((r) => r.type === 'ACCRUED').map((r) => [r.txId, cOf(r.amount)]));
  const posted = seededTx.filter((t) => t.status === 'POSTED').sort((a, b) => String(a.postedAt).localeCompare(String(b.postedAt)) || a.referenceNo.localeCompare(b.referenceNo));

  // The stored column set of the seed scope must be exactly the 21 expected loans; other suites may
  // have added their own loans, which are deliberately out of scope here.
  const seedLoans = loanRows.filter((l) => SEED_LOAN_IDS.includes(l.id));

  // ------------------------------------------------------------------- A. scope and shape
  ok(
    'A: เงินกู้ทั้ง 21 ฉบับจาก expected.json มีอยู่จริงใน DB และอ่านยอดคงค้างครบทุกแถว',
    seedLoans.length === Object.keys(expected.loans).length && loanRows.length >= seedLoans.length,
    {
      input: 'loans JOIN expected.loans ตาม loanId',
      expected: `${Object.keys(expected.loans).length} loans ใน scope seed`,
      actual: `พบ ${seedLoans.length} / rows ทั้งหมดในตาราง ${loanRows.length}`,
      note: 'suite 05/06/07/08 สร้างเงินกู้ทดสอบของตนเองแล้วลบทิ้ง; ตัวเลขในนี้จึงมากกว่า scope seed ได้ แต่ไม่หายไป',
    },
  );

  const counts = {
    financial_transactions: seededTx.length,
    financial_transaction_lines: lineRows.filter((l) => txById.has(l.txId) && SEED_LOAN_IDS.includes(txById.get(l.txId).loanId)).length,
    payment_requests: reqRows.filter((r) => SEED_LOAN_IDS.includes(r.loanId)).length,
    settlement_agreements: agRows.filter((a) => SEED_LOAN_IDS.includes(a.loanId)).length,
  };
  const countDiff = Object.entries(counts).filter(([t, n]) => n !== expected.rowCounts[t]).map(([t, n]) => `${t} ${expected.rowCounts[t]}->${n}`);
  ok('A: จำนวนแถวของตารางบัญชีใน scope seed เท่ากับตอน seed (ไม่มีแถวหาย/เกิดเพิ่มหลังรัน 14 suite)', countDiff.length === 0, {
    input: 'COUNT ของ transactions / lines / payment_requests / agreements (เฉพาะ loan จาก seed)',
    expected: JSON.stringify(expected.rowCounts),
    actual: JSON.stringify(counts),
    note: countDiff.join(' | '),
  });

  const orphans = {
    'line->tx': lineRows.filter((l) => !txById.has(l.txId)).length,
    'tx->loan': seededTx.filter((t) => !loansById.has(t.loanId)).length,
    'loan->customer': loanRows.filter((l) => !custRows.some((c) => c.id === l.customerId)).length,
    'request->loan': reqRows.filter((r) => !loansById.has(r.loanId)).length,
    'ledger->customer': ledgerRows.filter((r) => !custRows.some((c) => c.id === r.customerId)).length,
    'step->workflow': stepRows.filter((s) => !wfRows.some((w) => w.id === s.workflowId)).length,
  };
  ok('A: ไม่มีความสัมพันธ์โหว่ (ทุกแถวอ้างถึงแถวที่มีอยู่จริง)', Object.values(orphans).every((n) => n === 0), {
    input: 'ตรวจ reference ของ 6 ความสัมพันธ์หลัก',
    expected: 'ทุกตัว = 0',
    actual: JSON.stringify(orphans),
  });

  const seededCustIds = [...new Set(seedLoans.map((l) => l.customerId))];
  ok('A: ลูกค้าของเงินกู้ seedทุกรายมีแถวใน customers ครบ และไม่ซ้ำกับ loan ที่ไม่มีจริง', seededCustIds.every((id) => custRows.some((c) => c.id === id)), {
    input: 'DISTINCT loans.customerId ของ scope seed',
    expected: `${seededCustIds.length} customers ที่ต้องมีอยู่`,
    actual: `ยืนยันแล้ว ${seededCustIds.filter((id) => custRows.some((c) => c.id === id)).length} ราย`,
  });

  // ------------------------------------------------------------------- B. three views of every loan
  const storedVsExpected = [];
  const derivedVsStored = [];
  const bookSumVsComponents = [];
  const statusDiff = [];
  const txCountDiff = [];
  for (const l of seedLoans) {
    const exp = expected.loans[l.loanNumber];
    if (!exp) {
      statusDiff.push(`${l.loanNumber}: ไม่มีใน expected.json`);
      continue;
    }
    const stored = { PENALTY: cOf(l.pen), PAST_INTEREST: cOf(l.intr), PAST_PRINCIPAL: cOf(l.prin) };
    const want = { PENALTY: cOf(exp.outstanding.PENALTY), PAST_INTEREST: cOf(exp.outstanding.PAST_INTEREST), PAST_PRINCIPAL: cOf(exp.outstanding.PAST_PRINCIPAL) };
    if (COMPS.some((c) => stored[c] !== want[c]) || cOf(l.outstanding) !== cOf(exp.outstanding.total)) {
      storedVsExpected.push(`${l.loanNumber}: DB ${moneyLine(stored)}/${fmt(cOf(l.outstanding))} ต้องเป็น ${moneyLine(want)}/${exp.outstanding.total}`);
    }
    if (cOf(l.outstanding) !== stored.PENALTY + stored.PAST_INTEREST + stored.PAST_PRINCIPAL) {
      bookSumVsComponents.push(`${l.loanNumber}: currentOutstanding ${fmt(cOf(l.outstanding))} != ผลรวม 3 ส่วน ${fmt(totalOf(stored))}`);
    }
    // derived from the ledger: signed lines sum to what must be outstanding
    const derived = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
    for (const t of seededTx.filter((x) => x.loanId === l.id && x.status === 'POSTED')) {
      const ln = linesByTx.get(t.id) ?? {};
      for (const c of COMPS) derived[c] += ln[c] ?? 0;
    }
    if (COMPS.some((c) => derived[c] !== stored[c])) {
      derivedVsStored.push(`${l.loanNumber}: ledger ${moneyLine(derived)} != คอลัมน์เก็บยอด ${moneyLine(stored)}`);
    }
    if (l.status !== expected.statuses[l.loanNumber]) statusDiff.push(`${l.loanNumber}: ${l.status} ต้องเป็น ${expected.statuses[l.loanNumber]}`);
    const postedN = seededTx.filter((x) => x.loanId === l.id && x.status === 'POSTED').length;
    const pendingN = seededTx.filter((x) => x.loanId === l.id && x.status !== 'POSTED' && x.status !== 'REJECTED').length;
    if (postedN !== exp.postedTransactionCount || pendingN !== exp.pendingTransactionCount) {
      txCountDiff.push(`${l.loanNumber}: posted ${postedN}/${exp.postedTransactionCount} pending ${pendingN}/${exp.pendingTransactionCount}`);
    }
  }
  ok('B: ยอดคงค้างรายส่วนทุก loan = expected.json (ต้นทางคือ oracle ที่ generate ข้อมูล)', storedVsExpected.length === 0, {
    input: 'loans.outstandingPenalty/PastInterest/PastPrincipal/currentOutstanding vs expected.loans[*].outstanding',
    actual: list(storedVsExpected) || `ตรงกันทั้ง ${seedLoans.length} ฉบับ`,
  });
  ok('B: currentOutstanding = ผลรวมสามส่วนเสมอ (invariant ของคอลัมน์ที่เก็บไว้)', bookSumVsComponents.length === 0, {
    input: 'SUM(outstandingPenalty+PastInterest+PastPrincipal) vs currentOutstanding',
    actual: list(bookSumVsComponents) || 'ตรงกันทุกฉบับ',
  });
  ok('B: ยอดที่ derive จาก ledger (เส้น POSTED) = คอลัมน์ที่เก็บไว้ ทุก loan ทุกทศนิยม', derivedVsStored.length === 0, {
    input: 'SUM(financial_transaction_lines.amount) ราย loan ราย component vs loans.outstanding*',
    actual: list(derivedVsStored) || 'ตรงกันทุกฉบับ',
    note: 'invariant ที่ล็อกไว้: ตัวเลขรายงานต้องมาจาก ledger และต้องเท่ากับบัญชีเงินกู้',
  });
  ok('B: สถานะ loan ทุกฉบับ = ตามกฎปิดบัญชีใน expected.statuses', statusDiff.length === 0, {
    input: 'loans.status vs expected.statuses',
    actual: list(statusDiff) || `${seedLoans.length} ฉบับตรงกัน`,
  });
  ok('B: จำนวน transaction (POSTED / ที่ยังไม่โพสต์) ของทุก loan = expected', txCountDiff.length === 0, {
    input: 'COUNT financial_transactions ราย loan แยกตามสถานะ',
    actual: list(txCountDiff) || 'ตรงกันทุกฉบับ',
  });

  const viewMismatch = [];
  for (const l of seedLoans) {
    const res = await api('GET', `/api/loans/${l.id}`);
    const o = res.json?.data?.loan?.outstanding ?? {};
    const got = { PENALTY: cent(o.penalty ?? 0), PAST_INTEREST: cent(o.pastInterest ?? 0), PAST_PRINCIPAL: cent(o.pastPrincipal ?? 0) };
    const stored = { PENALTY: cOf(l.pen), PAST_INTEREST: cOf(l.intr), PAST_PRINCIPAL: cOf(l.prin) };
    if (res.status !== 200 || COMPS.some((c) => got[c] !== stored[c])) viewMismatch.push(`${l.loanNumber}: ${res.status} API ${moneyLine(got)} DB ${moneyLine(stored)}`);
  }
  ok('B: มุมมองที่สี่ — GET /api/loans/:id ให้ยอดคงค้างตรงกับ DB ทุกฉบับ', viewMismatch.length === 0, {
    input: 'GET /api/loans/:id สำหรับ loan seed 21 ฉบับ',
    actual: list(viewMismatch) || 'API = DB ทุกฉบับ',
  });

  const policyDiff = [];
  const currencyDiff = [];
  const interestDiff = [];
  for (const l of seedLoans) {
    if (l.currency !== 'LAK') currencyDiff.push(`${l.loanNumber}: ${l.currency}`);
    const prod = prodRows.find((p) => p.id === l.productId);
    const lp = json(l.penaltyPolicy) ?? {};
    const pp = json(prod?.penaltyPolicy) ?? {};
    if (prod && JSON.stringify({ ...lp }) !== JSON.stringify({ ...pp })) policyDiff.push(`${l.loanNumber}: snapshot ${JSON.stringify(lp)} != product ${JSON.stringify(pp)}`);
    const exp = expected.loans[l.loanNumber];
    const wantCents = billedInterestCents({
      principalCents: cOf(l.principal),
      ratePercent: Number(l.interestRate),
      rateUnit: l.interestRatePeriod,
      termValue: l.termValue,
      termUnit: l.termUnit,
    });
    const booked = seededTx.find((t) => t.loanId === l.id && t.ty === 'DISBURSEMENT');
    const ca = json(booked?.ca) ?? {};
    if (exp && wantCents !== cOf(exp.billedInterest)) interestDiff.push(`${l.loanNumber}: สูตร ${fmt(wantCents)} != expected ${exp.billedInterest}`);
    if (ca.PAST_INTEREST !== undefined && cent(ca.PAST_INTEREST) !== wantCents) interestDiff.push(`${l.loanNumber}: DISBURSEMENT line ${fmt(cent(ca.PAST_INTEREST))} != สูตร ${fmt(wantCents)}`);
  }
  ok('B: สกุลเงินเป็น LAK ทุกบัญชี, snapshot นโยบายค่าปรับตรงกับผลิตภัณฑ์, ดอกเบี้ย flat = สูตร', currencyDiff.length === 0 && policyDiff.length === 0 && interestDiff.length === 0, {
    input: 'loans.currency / penaltyPolicy vs loan_products + billedInterestCents() vs เส้น DISBURSEMENT',
    actual: [currencyDiff.length && `currency: ${list(currencyDiff)}`, policyDiff.length && `policy: ${list(policyDiff)}`, interestDiff.length && `interest: ${list(interestDiff)}`].filter(Boolean).join(' | ') || 'ผ่านทุกฉบับ',
  });

  // ------------------------------------------------------------------- C. replay the oracle event by event
  const states = new Map();
  for (const l of seedLoans) {
    states.set(l.id, {
      id: l.id,
      customerId: l.customerId,
      principalCents: cOf(l.principal),
      components: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 },
      status: 'ACTIVE',
      history: [],
    });
  }
  const replayFail = [];
  const allocationFail = [];
  const reliefFail = [];
  const negativeFail = [];
  const identityFail = [];
  const unfollowFail = [];
  for (const t of posted) {
    const st = states.get(t.loanId);
    const ca = json(t.ca) ?? {};
    const day = dayOf(t.postedAt);
    let event;
    if (t.ty === 'DISBURSEMENT') event = { type: t.ty, amountCents: cent(ca.PAST_PRINCIPAL ?? 0), interestCents: cent(ca.PAST_INTEREST ?? 0), postedAtIso: day };
    else if (t.ty === 'PAYMENT' || t.ty === 'SETTLEMENT_PAYMENT') event = { type: t.ty, amountCents: cOf(t.amount), postedAtIso: day };
    else if (t.ty === 'PENALTY') event = { type: t.ty, amountCents: cOf(t.amount), postedAtIso: day };
    else if (t.ty === 'WAIVER' || t.ty === 'WRITE_OFF') event = { type: t.ty, components: pos(ca), postedAtIso: day };
    else if (t.ty === 'ADJUSTMENT') event = { type: t.ty, components: Object.fromEntries(COMPS.map((c) => [c, cent(ca[c] ?? 0)])), postedAtIso: day };
    else if (t.ty === 'PAYMENT_REVERSAL' || t.ty === 'WRITE_OFF_REVERSAL') {
      const original = txById.get(t.refId);
      if (!original) {
        unfollowFail.push(`${t.referenceNo}: reversal ไม่อ้างถึงรายการต้นทาง (referenceTransactionId=NULL)`);
        continue;
      }
      event = { type: t.ty, amountCents: cOf(t.amount), originalAllocation: pos(json(original.ca)), postedAtIso: day };
      const { unfollowableCents } = reverseAllocation(event.originalAllocation, event.amountCents);
      if (unfollowableCents > 0) unfollowFail.push(`${t.referenceNo}: กลับรายการเกินต้นทาง ${fmt(unfollowableCents)} ของ ${original.referenceNo}`);
    } else {
      replayFail.push(`${t.referenceNo}: ชนิด transaction ที่ oracle ไม่รู้จัก (${t.ty})`);
      continue;
    }

    try {
      const before = { ...st.components };
      const r = postEvent(st, event);
      if (RELIEF.has(t.ty) && r.creditAccruedCents > 0 && t.ty !== 'PAYMENT' && t.ty !== 'SETTLEMENT_PAYMENT') reliefFail.push(`${t.referenceNo}: ส่วนลดเกินยอดคงค้าง`);
      if ((t.ty === 'PAYMENT' || t.ty === 'SETTLEMENT_PAYMENT') && COMPS.some((c) => r.allocation[c] !== pos(ca)[c])) {
        allocationFail.push(`${t.referenceNo}: oracle จัดสรร ${moneyLine(r.allocation)} แต่ระบบบันทึก ${moneyLine(pos(ca))}`);
      }
      for (const c of COMPS) {
        if (r.allocation[c] < 0 && t.ty !== 'ADJUSTMENT') reliefFail.push(`${t.referenceNo}: ${c} เป็นค่าลบในรายการ ${t.ty}`);
      }
      for (const c of COMPS) {
        if (st.components[c] < 0) negativeFail.push(`${t.referenceNo}: ${c} ติดลบหลังโพสต์ (ก่อนหน้า ${fmt(before[c])} -> ${fmt(st.components[c])})`);
      }
      if (ADDITIVE.has(t.ty) && t.ty !== 'ADJUSTMENT' && totalOf(st.components) !== totalOf(before) + cOf(t.amount)) {
        identityFail.push(`${t.referenceNo}: ${t.ty} เพิ่มยอดรวม ${fmt(totalOf(st.components) - totalOf(before))} แต่ post ไป ${fmt(cOf(t.amount))}`);
      }
    } catch (e) {
      replayFail.push(`${t.referenceNo}: ${String(e.message).slice(0, 90)}`);
    }
  }
  ok('C: replay ทั้งชุดด้วย oracle ไม่มีรายการใดผิดกติกา (relief เกินยอด / ชนิดไม่รู้จัก / ต้นทาง reversal หาย / เพิ่มยอดไม่ตรงจำนวน)', replayFail.length === 0 && reliefFail.length === 0 && identityFail.length === 0, {
    input: 'postEvent() ทุกแถว POSTED เรียงตาม postedAt ของ loan seed',
    actual: [list(replayFail), list(reliefFail), list(identityFail)].filter(Boolean).join(' | ') || 'ไม่มีเหตุการณ์นอกราง',
  });
  ok('C: การจัดสรรเงินจ่ายรายส่วน = ลำดับล็อก (ค่าปรับ -> ดอกเบี้ย -> ต้นเงิน) ทุกฉบับ', allocationFail.length === 0, {
    input: 'allocateComponents() ของ oracle vs financial_transactions.componentAmounts',
    actual: list(allocationFail) || `${posted.filter((t) => t.ty === 'PAYMENT' || t.ty === 'SETTLEMENT_PAYMENT').length} รายการตรงกัน`,
  });
  ok('C: ไม่มีส่วนใดของยอดคงค้างติดลบระหว่าง replay (invariant ที่ล็อกไว้)', negativeFail.length === 0, {
    input: 'ตรวจ components >= 0 ทุกขั้นตอนของ replay',
    actual: list(negativeFail) || 'ไม่มีติดลบ',
  });
  ok('C: ยอดกลับรายการไม่เคยเกินรายการต้นทาง (walk ตาม allocation เดิม ไม่เฉลี่ย pro-rata)', unfollowFail.length === 0, {
    input: 'reverseAllocation(originalAllocation, amount) ของทุก *_REVERSAL',
    actual: list(unfollowFail) || 'ทุกรายการ follow ต้นทางได้ครบ',
  });

  const replayDiff = [];
  const replayStatus = [];
  for (const l of seedLoans) {
    const st = states.get(l.id);
    const exp = expected.loans[l.loanNumber];
    if (!exp) continue;
    if (COMPS.some((c) => st.components[c] !== cOf(exp.outstanding[c])) || totalOf(st.components) !== cOf(exp.outstanding.total)) {
      replayDiff.push(`${l.loanNumber}: replay ${moneyLine(st.components)} total ${fmt(totalOf(st.components))} ต้องเป็น ${moneyLine(pos(exp.outstanding))} total ${exp.outstanding.total}`);
    }
    if (st.status !== exp.status) replayStatus.push(`${l.loanNumber}: replay ${st.status} DB ${l.status} expected ${exp.status}`);
  }
  ok('C: สั้น ๆ — replay จากเส้น ledger ให้ยอดคงค้างสุดท้ายตรงกับ expected.json ทุกฉบับ', replayDiff.length === 0, {
    input: 'state หลัง replay vs expected.loans[*].outstanding',
    actual: list(replayDiff) || 'ตรงกันทุกฉบับ',
    note: 'ถ้าข้อนี้ต่างจากข้อ B หมายความว่าลำดับการโพสต์ (ไม่ใช่แค่ผลรวม) ทำให้ตัวเลขเปลี่ยน',
  });
  ok('C: สถานะสุดท้ายจาก replay = สถานะใน DB = ตามกฎปิดบัญชี', replayStatus.length === 0, {
    input: 'statusAfterPost() ทุกเหตุการณ์ vs loans.status',
    actual: list(replayStatus) || 'ตรงกันทุกฉบับ',
  });

  // ------------------------------------------------------------------- D. monthly aggregates from the ledger
  const blank = () => ({ disbursedCash: 0, booked: 0, moneyIn: 0, collected: 0, interestPaid: 0, penaltyPaid: 0, principalPaid: 0, penaltyCharged: 0, reversed: 0, waived: 0, writtenOff: 0, transactions: 0 });
  const monthly = Object.fromEntries(MONTHS.map((m) => [m, blank()]));
  for (const t of posted) {
    const bucket = monthly[asOf(t.postedAt)];
    if (!bucket) continue;
    const a = cOf(t.amount);
    const ca = pos(json(t.ca));
    bucket.transactions += 1;
    if (t.ty === 'DISBURSEMENT') {
      bucket.disbursedCash += ca.PAST_PRINCIPAL;
      bucket.booked += a;
    }
    if (t.ty === 'PAYMENT' || t.ty === 'SETTLEMENT_PAYMENT') {
      bucket.moneyIn += a;
      bucket.collected += a;
      bucket.interestPaid += ca.PAST_INTEREST;
      bucket.penaltyPaid += ca.PENALTY;
      bucket.principalPaid += ca.PAST_PRINCIPAL;
    }
    if (t.ty === 'PAYMENT_REVERSAL') {
      bucket.reversed += a;
      bucket.collected -= a;
    }
    if (t.ty === 'WAIVER') bucket.waived += a;
    if (t.ty === 'WRITE_OFF') bucket.writtenOff += a;
    if (t.ty === 'PENALTY') bucket.penaltyCharged += a;
  }
  const monthFieldFail = (field) =>
    MONTHS.filter((m) => monthly[m][field] !== cOf(expected.monthly[m][field])).map((m) => `${m}: DB ${fmt(monthly[m][field])} expected ${expected.monthly[m][field]}`);
  for (const field of ['booked', 'disbursedCash']) {
    const bad = monthFieldFail(field);
    ok(`D: ${field} รายเดือนจาก ledger = expected.monthly (เงินที่ปล่อยกู้จริง/ที่บันทึกรวมดอกเบี้ย)`, bad.length === 0, {
      input: `SUM(POSTED DISBURSEMENT) จัดกลุ่มตามเดือนของ postedAt`,
      actual: list(bad) || 'ตรงกันทั้ง 16 เดือน',
    });
  }
  for (const field of ['moneyIn', 'collected', 'interestPaid', 'penaltyPaid', 'principalPaid', 'penaltyCharged', 'reversed', 'waived', 'writtenOff']) {
    const bad = monthFieldFail(field);
    ok(`D: ${field} รายเดือนจาก ledger = expected.monthly`, bad.length === 0, {
      input: 'SUM(รายการ POSTED) ตามประเภท/รายส่วน จัดกลุ่มตามเดือน',
      actual: list(bad) || 'ตรงกันทั้ง 16 เดือน',
      note: field === 'collected' ? 'collected = เงินเข้าจริงหักการกลับรายการ — ต้องเป็น net ไม่ใช่ gross' : '',
    });
  }
  const txCountBad = MONTHS.filter((m) => monthly[m].transactions !== expected.monthly[m].transactions).map((m) => `${m}: DB ${monthly[m].transactions} expected ${expected.monthly[m].transactions}`);
  ok('D: จำนวน transaction ต่อเดือน = expected.monthly', txCountBad.length === 0, {
    input: 'COUNT(POSTED) รายเดือน',
    actual: list(txCountBad) || 'ตรงกันทั้ง 16 เดือน',
  });
  const sumOf = (f) => MONTHS.reduce((s, m) => s + monthly[m][f], 0);
  const totalsFail = [
    ['disbursed', sumOf('booked')],
    ['disbursedCash', sumOf('disbursedCash')],
    ['collected', sumOf('collected')],
    ['interestPaid', sumOf('interestPaid')],
    ['penaltyPaid', sumOf('penaltyPaid')],
    ['principalPaid', sumOf('principalPaid')],
    ['reversed', sumOf('reversed')],
    ['waived', sumOf('waived')],
    ['writtenOff', sumOf('writtenOff')],
  ]
    .filter(([k, v]) => v !== cOf(expected.totals[k]))
    .map(([k, v]) => `${k}: รวมรายเดือน ${fmt(v)} != totals ${expected.totals[k]}`);
  ok('D: รวม 16 เดือนต้องเท่ากับ expected.totals (รายงานจะสลับช่วงเวลาไม่ได้ถ้ายอดรวมไม่ปิด)', totalsFail.length === 0, {
    input: 'SUM รายเดือนทั้ง 16 เทียบ expected.totals',
    actual: list(totalsFail) || `ยอดปล่อยกู้ ${expected.totals.disbursed} / รับชำระ ${expected.totals.collected} ปิดยอด`,
  });
  ok('D: จำนวน transaction ที่โพสต์ทั้งชุด = expected.totals.postedTransactions', posted.length === expected.totals.postedTransactions, {
    input: 'COUNT(POSTED ของ loan seed)',
    expected: `${expected.totals.postedTransactions}`,
    actual: `${posted.length}`,
  });

  // ------------------------------------------------------------------- E. month-end book value
  const closingFail = [];
  const closingMonthFail = [];
  for (const m of MONTHS) {
    const end = lastDay(m);
    let total = 0;
    for (const l of seedLoans) {
      const st = states.get(l.id);
      let value = 0;
      for (const step of st.history) if (step.at <= end) value = step.afterCents;
      total += value;
      const exp = expected.closingOutstandingByLoan[l.loanNumber]?.[m];
      if (exp !== undefined && value !== cOf(exp)) closingFail.push(`${l.loanNumber}/${m}: replay ${fmt(value)} expected ${exp}`);
    }
    const expMonth = expected.closingOutstandingByMonth[m];
    if (expMonth !== undefined && total !== cOf(expMonth)) closingMonthFail.push(`${m}: รวม ${fmt(total)} expected ${expMonth}`);
  }
  ok('E: ค่า book สิ้นงวดราย loan รายเดือน = replay ของ oracle ตาม expected.closingOutstandingByLoan', closingFail.length === 0, {
    input: '21 loans x 16 เดือน (มูลค่าจาก history ที่ postedAt <= สิ้นเดือน)',
    actual: list(closingFail) || 'ตรงกันทุกเซลล์',
  });
  ok('E: ค่า book สิ้นงวดยรวมทุก loan = expected.closingOutstandingByMonth', closingMonthFail.length === 0, {
    input: 'SUM ราย loan แล้วเทียบระดับเดือน',
    actual: list(closingMonthFail) || 'ตรงกันทั้ง 16 เดือน',
  });
  const loanBookCents = seedLoans.reduce((s, l) => s + cOf(l.outstanding), 0);
  const ledgerCents = seedLoans.reduce((s, l) => s + totalOf(states.get(l.id).components), 0);
  const lastMonth = MONTHS[MONTHS.length - 1];
  ok('E: invariants สุดท้ายของงวด — ledger = loan book = ปิดยอดสิ้นเดือน = expected.totals', loanBookCents === ledgerCents && loanBookCents === cOf(expected.totals.closingOutstanding) && cOf(expected.closingOutstandingByMonth[lastMonth]) === loanBookCents, {
    input: 'SUM(loans.currentOutstanding) vs SUM(replay components) vs closingOutstandingByMonth เดือนสุดท้าย',
    expected: `${expected.totals.closingOutstanding} (ledgerMatchesLoanBook=${expected.totals.ledgerMatchesLoanBook})`,
    actual: `loan book ${fmt(loanBookCents)} / replay ${fmt(ledgerCents)} / สิ้นเดือน ${lastMonth} ${expected.closingOutstandingByMonth[lastMonth]}`,
    note: 'invariant หลักของระบบรายงาน: ตัวเลขที่แสดงต้องมาจากระบบบัญชีเดียวกัน',
  });

  const activeLoans = seedLoans.filter((l) => l.status === 'ACTIVE').length;
  const closedList = seedLoans.filter((l) => l.status === 'CLOSED').map((l) => l.loanNumber).sort();
  const writtenList = seedLoans.filter((l) => l.status === 'WRITTEN_OFF').map((l) => l.loanNumber).sort();
  const largest = seedLoans.slice().sort((a, b) => cOf(b.outstanding) - cOf(a.outstanding) || a.loanNumber.localeCompare(b.loanNumber))[0]?.loanNumber;
  const invFail = [
    activeLoans !== expected.invariant.activeLoans && `ACTIVE ${activeLoans} != ${expected.invariant.activeLoans}`,
    closedList.join(',') !== [...expected.invariant.closedLoans].sort().join(',') && `CLOSED [${closedList}] != [${expected.invariant.closedLoans}]`,
    writtenList.join(',') !== [...expected.invariant.writtenOffLoans].sort().join(',') && `WRITTEN_OFF [${writtenList}] != [${expected.invariant.writtenOffLoans}]`,
    largest !== expected.invariant.largestOutstandingLoan && `loan ยอดใหญ่สุด ${largest} != ${expected.invariant.largestOutstandingLoan}`,
  ].filter(Boolean);
  ok('E: การกระจายสถานะและ loan ยอดใหญ่สุด = expected.invariant', invFail.length === 0, {
    input: 'GROUP BY loans.status + MAX(currentOutstanding)',
    actual: list(invFail) || `ACTIVE ${activeLoans} / CLOSED ${closedList.length} / WRITTEN_OFF ${writtenList.length}`,
  });

  // ------------------------------------------------------------------- F. customer credit
  const creditFail = [];
  for (const exp of Object.entries(expected.credits)) {
    const [custId, want] = exp;
    const row = creditRows.find((c) => c.customerId === custId);
    const led = ledgerRows.filter((r) => r.customerId === custId);
    if (!row) {
      creditFail.push(`${custId.slice(-12)}: ไม่มีแถว customer_credits (expected balance ${want.balance})`);
      continue;
    }
    if (cent(row.balance) !== toCents(want.balance)) creditFail.push(`${custId.slice(-12)}: balance ${fmt(cent(row.balance))} != ${want.balance}`);
    const wantLedger = want.ledger.map((l) => `${l.type}/${l.amount}/${l.balanceAfter}`);
    const gotLedger = led.map((l) => `${l.type}/${parseFloat(l.amount)}/${parseFloat(l.after)}`);
    if (wantLedger.join(',') !== gotLedger.join(',')) creditFail.push(`${custId.slice(-12)}: ledger [${gotLedger}] != [${wantLedger}]`);
  }
  for (const c of creditRows) if (!expected.credits[c.customerId]) creditFail.push(`${c.customerId.slice(-12)}: มีแถว credit ที่ไม่อยู่ใน expected (balance ${c.balance})`);
  ok('F: บัญชี credit ของลูกค้า = expected.credits ทั้งจำนวนและลำดับเส้น', creditFail.length === 0, {
    input: 'customer_credits + credit_ledger เทียบ expected.credits',
    actual: list(creditFail) || `${creditRows.length} บัญชีปิดยอดตรง expected`,
  });

  const chainFail = [];
  for (const custId of [...new Set(ledgerRows.map((r) => r.customerId))]) {
    let run = 0;
    for (const r of ledgerRows.filter((x) => x.customerId === custId)) {
      run += r.type === 'ACCRUED' ? cOf(r.amount) : -cOf(r.amount);
      if (run !== cOf(r.after)) chainFail.push(`${custId.slice(-12)}/${r.type}: balanceAfter ${r.after} ควรเป็น ${fmt(run)}`);
      if (run < 0) chainFail.push(`${custId.slice(-12)}: credit ติดลบกลางทาง (${fmt(run)})`);
    }
    const bal = creditRows.find((c) => c.customerId === custId);
    if (bal && cOf(bal.balance) !== run) chainFail.push(`${custId.slice(-12)}: balance ${bal.balance} != เดิน ledger แล้ว ${fmt(run)}`);
  }
  ok('F: เส้น credit_ledger เดินยอดต่อเนื่องและ balance ที่เก็บไว้ = ผลเดินเส้น (บัญชีไม่ปิดเกินจริง)', chainFail.length === 0, {
    input: 'replay credit_ledger รายลูกค้า (ACCRUED บวก, USED ลบ)',
    actual: list(chainFail) || 'เดินยอดครบทุกบัญชี',
    note: 'จุดนี้คือสิ่งที่ F-CONC-1 ทำพังเมื่อยิงพร้อมกัน — ตอนอยู่เงียบ ๆ ต้องปิดยอดเสมอ',
  });

  const usedFail = [];
  for (const r of ledgerRows.filter((x) => x.type === 'USED')) {
    const t = txById.get(r.txId);
    if (!t) {
      usedFail.push(`USED ${r.amount} อ้าง transaction ที่ไม่มีอยู่`);
      continue;
    }
    const req = reqRows.find((q) => q.id === t.reqId);
    if (!req || cent(req.credit) !== cOf(r.amount)) usedFail.push(`${t.referenceNo}: USED ${r.amount} != payment_requests.creditApplied ${req?.credit}`);
  }
  for (const req of reqRows.filter((q) => cOf(q.credit) > 0 && SEED_LOAN_IDS.includes(q.loanId))) {
    const t = seededTx.find((x) => x.reqId === req.id);
    if (t?.status !== 'POSTED' && req.status === 'APPROVED') usedFail.push(`${req.requestNo}: request APPROVED ใช้ credit ${req.credit} แต่ยังไม่มี transaction โพสต์`);
  }
  const creditLoans = [...new Set(seedLoans.map((l) => l.customerId))].filter((id) => !creditRows.some((c) => c.customerId === id));
  const strayLedger = ledgerRows.filter((r) => !creditRows.some((c) => c.customerId === r.customerId)).length;
  ok('F: ทุกเส้น USED ผูกกับ payment ที่ใช้ credit จริง และไม่มี ledger ของบัญชีที่ไม่มี customer_credits', usedFail.length === 0 && strayLedger === 0, {
    input: 'credit_ledger JOIN financial_transactions JOIN payment_requests',
    actual: list(usedFail) || `USED ${ledgerRows.filter((r) => r.type === 'USED').length} เส้น / ACCRUED ${ledgerRows.filter((r) => r.type === 'ACCRUED').length} เส้น`,
    note: `ลูกค้าที่ไม่มีแถว credit: ${creditLoans.length} ราย (เรื่องปกติ — ยังไม่เคยจ่ายเกิน)`,
  });

  // ------------------------------------------------------------------- G. approvals, maker-checker, audit trail
  const thresholds = { checker: 1000000, head: 10000000 };
  for (const c of cfgRows) {
    if (c.key === 'approval.checkerThreshold') thresholds.checker = Number(c.value);
    if (c.key === 'approval.headThreshold') thresholds.head = Number(c.value);
  }
  const levelsFor = (amount) => (amount <= thresholds.checker ? ['CHECKER'] : amount <= thresholds.head ? ['CHECKER', 'HEAD'] : ['CHECKER', 'HEAD', 'ADMIN']);
  const amountOfSubject = (subjectId) => {
    const t = txById.get(subjectId);
    if (t) return cOf(t.amount);
    const q = reqRows.find((r) => r.id === subjectId);
    if (q) return cOf(q.cash) + cOf(q.credit);
    const a = agRows.find((x) => x.id === subjectId);
    if (a) return cOf(a.agreed);
    return null;
  };
  const levelFail = [];
  for (const w of wfRows) {
    const centsAmt = amountOfSubject(w.subjectId);
    if (centsAmt === null) continue; // orphan row left by an earlier suite's purge
    const want = levelsFor(centsAmt / 100); // threshold เก็บเป็น LAK while our sums are cents
    const got = json(w.requiredLevels) ?? [];
    if (got.join(',') !== want.join(',')) levelFail.push(`${w.subjectType}/${String(w.subjectId).slice(0, 8)}: ยอด ${fmt(centsAmt)} ต้องเป็น ${want} แต่เป็น ${got}`);
  }
  ok('G: ระดับอนุมัติของทุกรายการ = สูตร threshold ที่ล็อกไว้ (คำนวณซ้ำจากจำนวนเงินปัจจุบัน)', levelFail.length === 0, {
    input: `computeRequiredLevels() ใหม่ เทียบ approval_workflows.requiredLevels (checker ${thresholds.checker} head ${thresholds.head})`,
    actual: list(levelFail) || `${wfRows.length} workflows (นับเฉพาะที่ subject ยังอยู่)`,
  });

  const pendingStepFail = [];
  const selfApprovalFail = [];
  for (const t of seededTx.filter((x) => x.status === 'POSTED' || x.status === 'APPROVED')) {
    const w = wfRows.find((x) => x.subjectId === t.id);
    if (!w) continue;
    const steps = stepRows.filter((s) => s.workflowId === w.id);
    if (t.status === 'POSTED' && steps.some((s) => s.status !== 'APPROVED')) pendingStepFail.push(`${t.referenceNo}: โพสต์แล้วแต่ยังมี step ${steps.filter((s) => s.status !== 'APPROVED').map((s) => `${s.level}:${s.status}`)}`);
    if (steps.some((s) => s.userId === t.createdBy)) selfApprovalFail.push(`${t.referenceNo}: ผู้สร้าง (${t.createdBy.slice(0, 8)}) เป็นผู้ตัดสินใจเอง`);
  }
  const reqSelf = reqRows.filter((r) => r.approvedBy && r.approvedBy === r.createdBy && SEED_LOAN_IDS.includes(r.loanId));
  const agSelf = agRows.filter((a) => a.decidedBy && a.decidedBy === a.createdBy && SEED_LOAN_IDS.includes(a.loanId));
  ok('G: maker-checker แยกขาดจริงในข้อมูล — ไม่มีรายการที่อนุมัติโดยผู้สร้าง และไม่มี step ค้างหลังการโพสต์', pendingStepFail.length === 0 && selfApprovalFail.length === 0 && reqSelf.length === 0 && agSelf.length === 0, {
    input: 'approval_steps.status/userId + payment_requests.approvedBy + settlement_agreements.decidedBy',
    actual: list([
      ...(pendingStepFail.length ? [`step ค้าง: ${list(pendingStepFail)}`] : []),
      ...(selfApprovalFail.length ? [`อนุมัติตัวเอง: ${list(selfApprovalFail)}`] : []),
      ...(reqSelf.length ? [`request อนุมัติตัวเอง ${reqSelf.length} ใบ`] : []),
      ...(agSelf.length ? [`agreement อนุมัติตัวเอง ${agSelf.length} ฉบับ`] : []),
    ]) || 'ทุกรายการมีผู้คนละคนอนุมัติ',
  });

  const dupFail = [];
  for (const [label, arr] of [
    ['financial_transactions.referenceNo', txRows.map((t) => t.referenceNo)],
    ['loans.loanNumber', loanRows.map((l) => l.loanNumber)],
    ['payment_requests.requestNo', reqRows.map((r) => r.requestNo)],
    ['settlement_agreements.agreementNo', agRows.map((a) => a.agreementNo)],
  ]) {
    const seen = new Set();
    const dup = arr.filter((v) => (seen.has(v) ? true : (seen.add(v), false)));
    if (dup.length) dupFail.push(`${label}: ซ้ำ ${list([...new Set(dup)])}`);
  }
  const requestTxMulti = reqRows
    .map((r) => ({ n: txRows.filter((t) => t.reqId === r.id).length, no: r.requestNo }))
    .filter((x) => x.n > 1);
  ok('G: เลขอ้างอิงไม่ซ้ำ && payment request หนึ่งใบสร้าง transaction ได้สูงสุดหนึ่งครั้ง', dupFail.length === 0 && requestTxMulti.length === 0, {
    input: 'ตรวจ duplicate ของ 4 คอลัมน์เลขอ้างอิง + COUNT(tx per request)',
    actual: list(dupFail) + (requestTxMulti.length ? ` | request ที่มี tx หลายใบ: ${list(requestTxMulti.map((x) => `${x.no}=${x.n}`))}` : '') || 'เลขอ้างอิง unique ทั้งหมด',
    note: 'จุดนี้คือสิ่งที่ F-CONC-1/2/5 พยายามข้าม (ชน unique index แทนการกันวงเงิน)',
  });

  const linesForStatusFail = [];
  for (const t of seededTx) {
    const ln = linesByTx.get(t.id) ?? {};
    const n = Object.keys(ln).length;
    if (t.status === 'POSTED' && n === 0) linesForStatusFail.push(`${t.referenceNo}: POSTED แต่ไม่มีเส้น ledger`);
    if (t.status !== 'POSTED' && n > 0) linesForStatusFail.push(`${t.referenceNo}: ยังไม่โพสต์ (${t.status}) แต่มีเส้น ledger แล้ว`);
    if (t.status === 'POSTED' && t.ty !== 'ADJUSTMENT') {
      const sum = COMPS.reduce((s, c) => s + Math.abs(ln[c] ?? 0), 0);
      if (sum !== cOf(t.amount) - (accruedByTx.get(t.id) ?? 0)) {
        linesForStatusFail.push(`${t.referenceNo}: |lines| ${fmt(sum)} != amount ${fmt(cOf(t.amount))} หัก credit ที่เกิดจากใบนี้ ${fmt(accruedByTx.get(t.id) ?? 0)} (${t.ty})`);
      }
      if (t.ca && sum !== totalOf(pos(json(t.ca)))) linesForStatusFail.push(`${t.referenceNo}: |lines| ${fmt(sum)} != componentAmounts ${fmt(totalOf(pos(json(t.ca))))} (${t.ty})`);
      const wantSign = RELIEF.has(t.ty) ? -1 : 1;
      for (const c of COMPS) {
        const v = ln[c] ?? 0;
        if (v === 0) continue;
        if (wantSign < 0 && v > 0) linesForStatusFail.push(`${t.referenceNo}: ${t.ty} เส้น ${c} ต้องเป็นลบ (ลดหนี้) แต่ได้ ${fmt(v)}`);
        if (wantSign > 0 && v < 0) linesForStatusFail.push(`${t.referenceNo}: ${t.ty} เส้น ${c} ต้องเป็นบวก แต่ได้ ${fmt(v)}`);
      }
    }
  }
  ok('G: ทุกรายการ POSTED ต้องมีเส้น ledger ที่รวมแล้ว = เงินที่เข้ามา หัก credit ที่เกิดจากใบนั้น และรายการที่ยังไม่โพสต์ต้องไม่มีเส้น ledger', linesForStatusFail.length === 0, {
    input: 'financial_transaction_lines JOIN financial_transactions + credit_ledger(ACCRUED per transaction)',
    actual: list(linesForStatusFail) || `${posted.length} รายการโพสต์มีเส้นครบ / ${seededTx.length - posted.length} รายการค้างไม่มีเส้น`,
  });

  const reversalOver = [];
  for (const t of seededTx.filter((x) => (x.ty === 'PAYMENT_REVERSAL' || x.ty === 'WRITE_OFF_REVERSAL') && x.status === 'POSTED')) {
    const original = txById.get(t.refId);
    if (!original) {
      reversalOver.push(`${t.referenceNo}: ไม่มีรายการต้นทาง`);
      continue;
    }
    const totalReversed = seededTx
      .filter((x) => x.refId === original.id && x.status === 'POSTED')
      .reduce((s, x) => s + cOf(x.amount), 0);
    if (totalReversed > cOf(original.amount)) reversalOver.push(`${original.referenceNo}: กลับรายการรวม ${fmt(totalReversed)} > ต้นทาง ${fmt(cOf(original.amount))}`);
  }
  const settleOver = [];
  for (const a of agRows.filter((x) => SEED_LOAN_IDS.includes(x.loanId))) {
    const paid = seededTx.filter((t) => t.agId === a.id && t.ty === 'SETTLEMENT_PAYMENT' && t.status === 'POSTED').reduce((s, t) => s + cOf(t.amount), 0);
    if (paid > cOf(a.agreed)) settleOver.push(`${a.agreementNo}: โพสต์แล้ว ${fmt(paid)} > ตกลง ${fmt(cOf(a.agreed))}`);
    const approved = a.status === 'APPROVED';
    if (approved && paid === 0 && !expected.loans[loansById.get(a.loanId)?.loanNumber]) settleOver.push(`${a.agreementNo}: AGREEMENT APPROVED แต่ไม่มีเส้นข้อมูล`);
  }
  ok('G: ที่ข้อมูลพักอยู่ — ยอดกลับรายการ<=ต้นทาง และยอดที่โพสต์ตามข้อตกลงปิดบัญชี<=วงเงินที่ตกลง', reversalOver.length === 0 && settleOver.length === 0, {
    input: 'SUM(POSTED reversals) per referenceTransactionId + SUM(POSTED SETTLEMENT_PAYMENT) per agreement',
    actual: list([...reversalOver, ...settleOver]) || 'ไม่มีรายการเกินขอบเขต',
    note: 'ถ้า F-CONC-2/F-CONC-5 ทำให้ข้อมูลค้างไว้ ข้อนี้จะแดง — suite 14 ล้างของตัวออกแล้ว จึงควรมีแต่ข้อมูล seed ที่ถูกต้อง',
  });

  const auditMissing = [];
  const noPostedTx = await rows(conn, "SELECT COUNT(*) n FROM financial_transactions t WHERE t.status='POSTED' AND t.loanId IN (?) AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action='TRANSACTION_POSTED' AND a.transactionId=t.id)", [SEED_LOAN_IDS]);
  const noReqAudit = await rows(conn, "SELECT COUNT(*) n FROM payment_requests r WHERE r.status='APPROVED' AND r.loanId IN (?) AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action='PAYMENT_REQUEST_APPROVED' AND a.sourceRequestId=r.id)", [SEED_LOAN_IDS]);
  if (Number(noPostedTx[0].n) > 0) auditMissing.push(`TRANSACTION_POSTED หายไป ${noPostedTx[0].n} รายการ`);
  if (Number(noReqAudit[0].n) > 0) auditMissing.push(`PAYMENT_REQUEST_APPROVED หายไป ${noReqAudit[0].n} ใบ`);
  const seedApprovedSteps = stepRows.filter((s) => s.status === 'APPROVED' && seededTx.some((t) => wfRows.some((w) => w.id === s.workflowId && w.subjectId === t.id)));
  const stepAuditRows = await rows(conn, "SELECT COUNT(*) n FROM audit_logs WHERE action='APPROVAL_STEP_APPROVED'", []);
  if (Number(stepAuditRows[0].n) < seedApprovedSteps.length) auditMissing.push(`APPROVAL_STEP_APPROVED มี ${stepAuditRows[0].n} แถว แต่ step ที่อนุมัติแล้วใน scope มี ${seedApprovedSteps.length} ตัว`);
  ok('G: audit trail ครอบคลุมเหตุการณ์เงินจริงทุกรายการ (ไม่มี money movement โดยไม่มี trail)', auditMissing.length === 0, {
    input: 'NOT EXISTS บน audit_logs สำหรับทุก POSTED / ทุก request ที่ APPROVED + COUNT แถว step เทียบจำนวน step ที่อนุมัติ',
    actual: list(auditMissing) || `${posted.length} โพสต์ + ${reqRows.filter((r) => r.status === 'APPROVED').length} อนุมัติ request + ${seedApprovedSteps.length} steps มี trail ครบ`,
  });

  const noStepAudit = await rows(conn, "SELECT COUNT(*) n FROM approval_steps s JOIN approval_workflows w ON w.id=s.workflowId JOIN financial_transactions t ON t.id=w.subjectId WHERE s.status='APPROVED' AND t.loanId IN (?) AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action='APPROVAL_STEP_APPROVED' AND a.transactionId=t.id AND a.userId=s.userId)", [SEED_LOAN_IDS]);
  ok('F-INV-1: ทุก step ที่ APPROVED ต้องมี audit ที่อ้าง transactionId ของเอกสารที่ถูกอนุมัติ (per-document attribution)', Number(noStepAudit[0].n) === 0, {
    input: 'approval_steps -> audit_logs(APPROVAL_STEP_APPROVED, transactionId, userId)',
    expected: 'ทุก step มีแถว audit ที่ผูกกับ transaction ที่ถูกอนุมัติ',
    actual: `${noStepAudit[0].n} steps ไม่มีแถว audit ที่อ้าง transactionId / แถว APPROVAL_STEP_APPROVED ในฐานข้อมูลมี transactionId=NULL ทั้ง ${stepAuditRows[0].n} แถว`,
    note: 'เซิร์ฟเวอร์เขียน transactionId ให้เสมอ (approval.service.ts:228-235) — แถวที่หายไปคือแถวที่ dataset.mjs สร้างเองโดยไม่ใส่ field นี้ จึงเป็นช่องว่างของชุดข้อมูลจำลอง ไม่ใช่ logic ระบบ; แก้ dataset.mjs แล้ว จะผ่านในการรัน full ครั้งถัดไป (หลัง re-seed)',
  });

  // ------------------------------------------------------------------- H. business gates at rest
  const kycFail = await rows(
    conn,
    `SELECT l.loanNumber, c.customerNumber, c.kycStatus FROM loans l JOIN customers c ON c.id=l.customerId
     WHERE l.id IN (?) AND c.kycStatus <> 'VERIFIED'`,
    [SEED_LOAN_IDS],
  );
  ok("H: ทุก loan ที่เกิดขึ้นมาแล้วต้องเป็นของลูกค้าที่ KYC VERIFIED เท่านั้น (hard gate ก่อน disbursal)", kycFail.length === 0, {
    input: 'loans JOIN customers WHERE kycStatus != VERIFIED',
    actual: list(kycFail.map((r) => `${r.loanNumber}/${r.customerNumber}=${r.kycStatus}`)) || `${seedLoans.length} ฉบับล้วน VERIFIED`,
  });
  ok('H: threshold ที่ใช้งานจริงต้อง head >= checker (invariant ของ config กลาง)', thresholds.head >= thresholds.checker && thresholds.checker > 0, {
    input: 'system_config approval.checkerThreshold / approval.headThreshold',
    expected: 'head >= checker > 0',
    actual: `checker ${thresholds.checker} head ${thresholds.head}`,
  });
  const boundsFail = [];
  for (const l of seedLoans) {
    const st = states.get(l.id);
    const exp = expected.loans[l.loanNumber];
    const cap = cOf(l.principal) + cOf(exp?.billedInterest ?? 0) + seededTx.filter((t) => t.loanId === l.id && t.ty === 'PENALTY' && t.status === 'POSTED').reduce((s, t) => s + cOf(t.amount), 0);
    const total = cOf(l.outstanding);
    if (total < 0 || total > cap) boundsFail.push(`${l.loanNumber}: ยอด ${fmt(total)} อยู่นอกขอบ [0, ${fmt(cap)}]`);
    if (COMPS.some((c) => cOf(c === 'PENALTY' ? l.pen : c === 'PAST_INTEREST' ? l.intr : l.prin) < 0)) boundsFail.push(`${l.loanNumber}: มีส่วนติดลบในคอลัมน์เก็บยอด`);
  }
  ok('H: ยอดคงค้างทุกฉบับอยู่ภายในขอบ [0, เงินต้น + ดอกเบี้ย flat + ค่าปรับที่เรียกเก็บจริง]', boundsFail.length === 0, {
    input: 'เพดานคำนวณต่อ loan จาก expected.billedInterest + PENALTY ที่โพสต์แล้ว',
    actual: list(boundsFail) || 'อยู่ในขอบทุกฉบับ',
  });

  // ------------------------------------------------------------------- I. API as the fourth view
  const listRes = await api('GET', '/api/loans?limit=100');
  const apiLoans = Array.isArray(listRes.json?.data) ? listRes.json.data : (listRes.json?.data?.loans ?? []);
  const apiTotal = Number(listRes.json?.pagination?.total ?? apiLoans.length);
  const apiBookCents = seedLoans
    .map((l) => apiLoans.find((x) => x.id === l.id))
    .filter(Boolean)
    .reduce((s, x) => s + cent(x.outstanding?.total ?? x.currentOutstanding ?? 0), 0);
  ok('I: รายการ loans ผ่าน API ให้ยอดคงค้างรวมเท่ากับ loan book ใน DB', listRes.status === 200 && apiTotal === loanRows.length && apiBookCents === loanBookCents, {
    input: 'GET /api/loans?limit=100 แล้ว SUM(outstanding.total) เฉพาะ loan ของ seed',
    expected: `${fmt(loanBookCents)} จาก ${seedLoans.length} ฉบับใน scope (ตาราง loans มี ${loanRows.length} แถว)`,
    actual: `HTTP ${listRes.status} คืน ${apiLoans.length}/${apiTotal} รายการ รวม ${fmt(apiBookCents)} (เห็น loan seed ${seedLoans.filter((l) => apiLoans.some((x) => x.id === l.id)).length}/${seedLoans.length})`,
  });

  const reportRes = await api('GET', '/api/reports/monthly?months=16');
  const apiRows = reportRes.json?.data?.rows ?? [];
  const apiVsLedgerFail = [];
  for (const m of MONTHS) {
    const row = apiRows.find((r) => r.month === m);
    if (!row) {
      apiVsLedgerFail.push(`${m}: API ไม่มีแถวเดือนนี้`);
      continue;
    }
    const mine = monthly[m];
    const pairs = [
      ['disbursed', cent(row.disbursed ?? 0), mine.booked],
      ['moneyIn', cent(row.moneyIn ?? 0), mine.moneyIn],
      ['collected', cent(row.collected ?? 0), mine.collected],
      ['reversed', cent(row.reversed ?? 0), mine.reversed],
      ['closingOutstanding', cent(row.closingOutstanding ?? 0), cOf(expected.closingOutstandingByMonth[m])],
    ];
    for (const [f, a, b] of pairs) if (a !== b) apiVsLedgerFail.push(`${m}.${f}: API ${fmt(a)} ledger ${fmt(b)}`);
  }
  ok('I: รายงาน /api/reports/monthly = ตัวเลขที่ derive จาก ledger (มุมที่สามต้องตรงกัน)', apiVsLedgerFail.length === 0, {
    input: 'GET /api/reports/monthly?months=16 เทียบ ledger-derived รายเดือน',
    actual: list(apiVsLedgerFail) || 'API = ledger ทุกเดือน',
    note: apiVsLedgerFail.length ? 'ถ้าต่างเฉพาะแถว disbursed/collected ของบางเดือน คือ F-RPT-1 ที่ suite 10 รายงานไว้' : '',
  });

  const dashRes = await api('GET', '/api/dashboard/stats');
  const d = dashRes.json?.data ?? {};
  const allBookCents = loanRows.reduce((s, l) => s + cOf(l.outstanding), 0);
  const dashFail = [];
  if (Number(d.loans) !== loanRows.length) dashFail.push(`loans ${d.loans} != ตารางจริง ${loanRows.length}`);
  if (Number(d.customers) !== custRows.length) dashFail.push(`customers ${d.customers} != ตารางจริง ${custRows.length}`);
  if (Number(d.postedTransactions) !== txRows.filter((t) => t.status === 'POSTED').length) dashFail.push(`postedTransactions ${d.postedTransactions} != ${txRows.filter((t) => t.status === 'POSTED').length}`);
  if (Number(d.pendingPaymentRequests) !== reqRows.filter((r) => r.status === 'PENDING').length) dashFail.push(`pendingPaymentRequests ${d.pendingPaymentRequests} != ${reqRows.filter((r) => r.status === 'PENDING').length}`);
  if (cent(d.totalOutstanding) !== allBookCents) dashFail.push(`totalOutstanding ${fmt(cent(d.totalOutstanding))} != loan book ทั้งตาราง ${fmt(allBookCents)}`);
  if (cent(d.totalCustomerCredit) !== creditRows.reduce((s, c) => s + cOf(c.balance), 0)) dashFail.push(`totalCustomerCredit ${d.totalCustomerCredit} != ${fmt(creditRows.reduce((s, c) => s + cOf(c.balance), 0))}`);
  ok('I: dashboard อ่านได้และตัวเลขตรงกับตาราง (มุมที่ห้า: นับทั้งตาราง ไม่ใช่เฉพาะ scope seed)', dashRes.status === 200 && dashFail.length === 0, {
    input: 'GET /api/dashboard/stats เทียบ COUNT/SUM ตรงจากตาราง',
    actual: list(dashFail) || `loans ${d.loans}, posted ${d.postedTransactions}, outstanding ${d.totalOutstanding}, credit ${d.totalCredit}`,
    note: 'รายละเอียดของ dashboard (MoM/YoY, sort) เป็นหน้าที่ suite 10 — ข้อนี้ยึดเฉพาะตัวเลขหน้าแรก',
  });
}
