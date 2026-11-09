// 3.5 Loans: list/detail/aggregates, ตารางงวด, allocation preview, การสร้าง + บันทึกเงินออกกู้
// และ KYC gate — ทดสอบผ่าน HTTP จริงทั้งหมด
//
// loan ที่ suite นี้สร้างจะถูกลบออกตอนจบ suite (ดู `purge`) เพราะ suite รายงาน/invariant
// เทียบกับ expected.json ซึ่งอธิบายเฉพาะข้อมูล seed — ถ้าปล่อยแถวไว้ ตัวเลขจะเทียบไม่ได้
// การลบกระทบเฉพาะแถวที่ suite นี้สร้างเอง ไม่ได้แตะข้อมูล seed
import { errorMessage, expected, settle, statusCheck, check, USER_NAMES } from '../lib/harness.mjs';
import {
  MONTHS_PER_UNIT,
  addMonths,
  allocateComponents,
  billedInterestCents,
  fmt,
  toCents,
  toLak,
} from '../oracle.mjs';

const CAT = 'loans';

/** ตัวเลขต้องตรงถึงทศนิยม ไม่ใช่ "ใกล้เคียง" */
const sameMoney = (a, b) => Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
const dateOnly = (v) => String(v ?? '').slice(0, 10);
const sum = (list, pick) => list.reduce((acc, x) => acc + Number(pick(x)), 0);
const jwtId = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).id;

export default async function suite(ctx) {
  const { tokens, conn, api } = ctx;
  const loansExp = expected.loans;
  const byNum = loansExp;
  const byId = Object.fromEntries(Object.entries(loansExp).map(([num, l]) => [l.loanId, { ...l, loanNumber: num }]));
  const seededIds = Object.values(loansExp).map((l) => l.loanId);
  const expAll = Object.values(loansExp);

  const products = (await api('GET', '/api/loan-products').then((r) => r.json.products)) ?? [];
  const product = (code) => products.find((p) => p.code === code);
  const verifiedCustomer = expAll[0].customerId;
  const pendingCustomer = '00000000-2000-4000-8000-000000000021';
  const notVerifiedCustomer = '00000000-2000-4000-8000-000000000024';
  const NIL = '00000000-7000-4000-8000-0000000000ff';

  const created = [];
  const purge = async () => {
    if (!created.length) return;
    for (const sql of [
      'DELETE FROM financial_transaction_lines WHERE transactionId IN (SELECT id FROM financial_transactions WHERE loanId IN (?))',
      'DELETE FROM financial_transactions WHERE loanId IN (?)',
      'DELETE FROM payment_requests WHERE loanId IN (?)',
      'DELETE FROM settlement_agreements WHERE loanId IN (?)',
      'DELETE FROM reconciliation_records WHERE loanId IN (?)',
      'DELETE FROM notification_outbox WHERE loanId IN (?)',
      'DELETE FROM audit_logs WHERE loanId IN (?)',
      'DELETE FROM loans WHERE id IN (?)',
    ]) {
      await conn.query(sql, [created]);
    }
  };

  try {
    // ================================================ A. list, filters, aggregates
    const baselineAgg = await api('GET', '/api/loans?limit=100');
    statusCheck(CAT, 'GET /api/loans ตอบกลับ 200', baselineAgg, 200, { input: 'limit=100' });
    const all = baselineAgg.json.data ?? [];
    check(CAT, 'list คืน loanครบทุกแถวที่ seed ไว้', {
      input: 'pagination.total',
      expected: expected.rowCounts.loans,
      actual: `${baselineAgg.json.pagination?.total} total, ${all.length} rows`,
      pass: baselineAgg.json.pagination?.total === expected.rowCounts.loans && all.length === expected.rowCounts.loans,
    });
    const shapeBad = all.filter(
      (l) =>
        !l.outstanding ||
        Object.keys(l.outstanding).length !== 4 ||
        !sameMoney(l.outstanding.penalty + l.outstanding.pastInterest + l.outstanding.pastPrincipal, l.outstanding.total) ||
        !sameMoney(l.outstanding.total, l.currentOutstanding),
    );
    check(CAT, 'ทุกรายการมี outstanding {penalty,pastInterest,pastPrincipal,total} และ total = ผลบวก 3 ส่วน = currentOutstanding', {
      input: `${all.length} rows`,
      expected: '0 inconsistent',
      actual: `${shapeBad.length} inconsistent${shapeBad.length ? ': ' + shapeBad.map((l) => l.loanNumber).join(',') : ''}`,
      pass: shapeBad.length === 0,
    });

    const agg = baselineAgg.json.aggregates ?? {};
    const aggExpect = {
      principalCharged: sum(expAll, (l) => l.principal),
      outstandingPrincipal: sum(expAll, (l) => l.outstanding.PAST_PRINCIPAL),
      outstandingInterest: sum(expAll, (l) => l.outstanding.PAST_INTEREST),
      outstandingPenalty: sum(expAll, (l) => l.outstanding.PENALTY),
      outstandingTotal: sum(expAll, (l) => l.outstanding.total),
    };
    for (const [key, want] of Object.entries(aggExpect)) {
      check(CAT, `aggregates.${key} = ผลรวมอิสระจากข้อมูล seed`, {
        input: 'GET /api/loans?limit=100 (no filter)',
        expected: fmt(toCents(want)),
        actual: fmt(toCents(agg[key] ?? NaN)),
        pass: sameMoney(agg[key], want),
      });
    }
    const closedExpected = Object.values(expected.statuses).filter((s) => s === 'CLOSED').length;
    check(CAT, 'aggregates.closedCount นับเฉพาะสถานะ CLOSED', {
      input: 'expected.statuses',
      expected: closedExpected,
      actual: agg.closedCount,
      pass: agg.closedCount === closedExpected,
    });

    for (const status of ['ACTIVE', 'CLOSED', 'WRITTEN_OFF']) {
      const subset = expAll.filter((l) => l.status === status);
      const res = await api('GET', `/api/loans?status=${status}&limit=100`);
      const rows_ = res.json.data ?? [];
      const subAgg = res.json.aggregates ?? {};
      check(CAT, `filter status=${status}: ทุกแถวเป็นสถานะนั้น จำนวนและตัวเลขรวมตรง expected`, {
        input: `status=${status}`,
        expected: `${subset.length} rows, principal ${fmt(toCents(sum(subset, (l) => l.principal)))}, outstanding ${fmt(toCents(sum(subset, (l) => l.outstanding.total)))}, penalty ${fmt(toCents(sum(subset, (l) => l.outstanding.PENALTY)))}`,
        actual: `${rows_.length} rows, principal ${fmt(toCents(subAgg.principalCharged ?? NaN))}, outstanding ${fmt(toCents(subAgg.outstandingTotal ?? NaN))}, penalty ${fmt(toCents(subAgg.outstandingPenalty ?? NaN))}, wrong-status ${rows_.filter((r) => r.status !== status).length}`,
        pass:
          rows_.length === subset.length &&
          rows_.every((r) => r.status === status) &&
          sameMoney(subAgg.principalCharged, sum(subset, (l) => l.principal)) &&
          sameMoney(subAgg.outstandingTotal, sum(subset, (l) => l.outstanding.total)) &&
          sameMoney(subAgg.outstandingPenalty, sum(subset, (l) => l.outstanding.PENALTY)),
      });
    }

    const bogusStatus = await api('GET', '/api/loans?status=NOT_A_STATUS');
    check(CAT, 'filter ด้วยสถานะที่ไม่มีใน enum: ต้องไม่ 500 (คืนชุดว่างหรือ 400)', {
      input: 'status=NOT_A_STATUS',
      expected: '200 + ชุดว่าง หรือ 400',
      actual: `HTTP ${bogusStatus.status} rows=${bogusStatus.json?.data?.length}`,
      pass:
        bogusStatus.status === 400 ||
        (bogusStatus.status === 200 && (bogusStatus.json.data ?? []).length === 0 && bogusStatus.json.aggregates.outstandingTotal === 0),
    });

    const oneCustomer = byNum['LN-TST-000003'].customerId;
    const byCustomer = await api('GET', `/api/loans?customerId=${oneCustomer}&limit=100`);
    const custLoans = expAll.filter((l) => l.customerId === oneCustomer);
    check(CAT, 'filter customerId คืนเฉพาะ loan ของลูกค้านั้น', {
      input: `customerId=${oneCustomer}`,
      expected: `${custLoans.length} rows of ${custLoans[0].customerNumber}`,
      actual: `${(byCustomer.json.data ?? []).length} rows of ${(byCustomer.json.data ?? []).map((r) => r.customer.customerNumber).join(',')}`,
      pass:
        (byCustomer.json.data ?? []).length === custLoans.length &&
        (byCustomer.json.data ?? []).every((r) => r.customerId === oneCustomer),
    });

    // ------------------------- สรุปผลิตภัณฑ์ที่ลูกค้ากู้ (คอลัมน์ใหม่ในหน้า Customers)
    // จุดนี้ต้องรันก่อนที่ suite จะสร้าง loan ใหม่ ตัวเลขถึงจะเทียบกับข้อมูล seed ล้วน ๆ
    const customersRes = await api('GET', '/api/customers');
    const customerRows = customersRes.json.customers ?? [];
    statusCheck(CAT, 'GET /api/customers: ตอบ 200 (ไม่มี parameter = คืนทุกแถว)', customersRes, 200, { input: 'no query' });
    const badBorrowingShape = customerRows.filter(
      (c) =>
        typeof c.activeLoanCount !== 'number' ||
        !Array.isArray(c.borrowings) ||
        c.borrowings.some(
          (b) =>
            typeof b.productId !== 'string' ||
            typeof b.productName !== 'string' ||
            typeof b.loanCount !== 'number' ||
            typeof b.activeCount !== 'number' ||
            typeof b.outstanding !== 'number',
        ),
    );
    check(CAT, 'ทุกรายการมี activeLoanCount + borrowings[{productId,productName,loanCount,activeCount,outstanding}]', {
      input: `${customerRows.length} rows`,
      expected: '0 แถวที่ขาด field ใหม่',
      actual: `${badBorrowingShape.length} แถวที่ไม่ครบ${badBorrowingShape.length ? ': ' + badBorrowingShape.map((c) => c.customerNumber).join(',') : ''}`,
      pass: customerRows.length > 0 && badBorrowingShape.length === 0,
    });

    const productCodeById = new Map(products.map((p) => [p.id, p.code]));
    const productCodeId = (code) => products.find((p) => p.code === code)?.id ?? code;
    /** สร้างสรุปผลิตภัณฑ์ต่อลูกค้าจาก expected.json (แหล่งข้อมูลอิสระจาก API) */
    const wantBorrowings = (customerId) => {
      const rows = new Map();
      for (const l of expAll.filter((x) => x.customerId === customerId)) {
        const row = rows.get(l.product) ?? {
          productCode: l.product,
          productId: productCodeId(l.product),
          loanCount: 0,
          activeCount: 0,
          outstanding: 0,
        };
        row.loanCount += 1;
        if (l.status === 'ACTIVE') {
          row.activeCount += 1;
          row.outstanding += Number(l.outstanding.total);
        }
        rows.set(l.product, row);
      }
      return [...rows.values()];
    };
    const borrowingDiffs = (customerId) => {
      const got = (customerRows.find((c) => c.id === customerId)?.borrowings ?? []).slice();
      const want = wantBorrowings(customerId);
      const diffs = [];
      for (const w of want) {
        const g = got.find((x) => productCodeById.get(x.productId) === w.productCode);
        if (!g) {
          diffs.push(`${w.productCode}: ไม่มีใน response`);
          continue;
        }
        if (g.loanCount !== w.loanCount || g.activeCount !== w.activeCount || !sameMoney(g.outstanding, w.outstanding)) {
          diffs.push(`${w.productCode}: ได้ ${g.loanCount}/${g.activeCount}/${g.outstanding} ต้องการ ${w.loanCount}/${w.activeCount}/${w.outstanding}`);
        }
      }
      if (got.length !== want.length) diffs.push(`จำนวนผลิตภัณฑ์: ได้ ${got.length} ต้องการ ${want.length}`);
      return diffs;
    };

    const multiCustomerRow = customerRows.find((c) => c.id === oneCustomer);
    check(CAT, 'ลูกค้าที่มีหลายสัญญา: borrowings รวมตามผลิตภัณฑ์ + loanCount = ผลบวกทุกผลิตภัณฑ์', {
      input: `customerId=${oneCustomer} (${custLoans[0].customerNumber}, ${custLoans.length} loans)`,
      expected: `0 ส่วนต่าง, loanCount ${custLoans.length}`,
      actual: `${borrowingDiffs(oneCustomer).join(' | ') || 'ตรงทุกฟิลด์'}, loanCount=${multiCustomerRow?.loanCount}, ผลบวกผลิตภัณฑ์=${(multiCustomerRow?.borrowings ?? []).reduce((a, b) => a + b.loanCount, 0)}`,
      pass:
        borrowingDiffs(oneCustomer).length === 0 &&
        multiCustomerRow?.loanCount === custLoans.length &&
        (multiCustomerRow?.borrowings ?? []).reduce((a, b) => a + b.loanCount, 0) === custLoans.length,
    });

    const activeCountBad = customerRows.filter((c) => {
      const fromBorrowings = (c.borrowings ?? []).reduce((a, b) => a + b.activeCount, 0);
      return fromBorrowings !== c.activeLoanCount;
    });
    check(CAT, 'activeLoanCount = ผลรวม activeCount ของทุกผลิตภัณฑ์ (ทุกแถว)', {
      input: `${customerRows.length} rows`,
      expected: '0 แถวที่ไม่ตรง',
      actual: `${activeCountBad.length} แถวที่ไม่ตรง${activeCountBad.length ? ': ' + activeCountBad.map((c) => c.customerNumber).join(',') : ''}`,
      pass: activeCountBad.length === 0,
    });

    const activeFirstBad = customerRows.filter((c) => {
      const list = c.borrowings ?? [];
      return list.some((b, i) => b.activeCount === 0 && list.slice(i + 1).some((n) => n.activeCount > 0));
    });
    check(CAT, 'เรียงผลิตภัณฑ์: ที่มีหนี้ค้างอยู่ต้องขึ้นก่อนที่เคยกู้เสร็จไปแล้ว', {
      input: `${customerRows.length} rows`,
      expected: '0 แถวที่เรียงผิด',
      actual: `${activeFirstBad.length} แถว${activeFirstBad.length ? ': ' + activeFirstBad.map((c) => c.customerNumber).join(',') : ''}`,
      pass: activeFirstBad.length === 0,
    });

    const closedCustomers = expAll.filter((l) => l.status !== 'ACTIVE');
    const closedOnly = [];
    for (const l of closedCustomers) {
      if (!expAll.some((x) => x.customerId === l.customerId && x.status === 'ACTIVE')) closedOnly.push(l);
    }
    const historyOnlyBad = closedOnly
      .map((l) => {
        const row = customerRows.find((c) => c.id === l.customerId);
        const b = (row?.borrowings ?? []).find((x) => productCodeById.get(x.productId) === l.product);
        return b && (b.activeCount !== 0 || b.outstanding !== 0) ? `${l.customerNumber}:${l.product}` : null;
      })
      .filter(Boolean);
    check(CAT, 'ประวัติเคยกู้ (loan ปิด/ตัดจำหน่ายแล้ว): activeCount=0 และ outstanding=0 แต่ยังแสดงชื่อผลิตภัณฑ์', {
      input: `${closedOnly.length} สัญญาที่ลูกค้าไม่มีหนี้ ACTIVE`,
      expected: '0 รายการที่ตัวเลขผิด',
      actual: `${historyOnlyBad.length} ผิด${historyOnlyBad.length ? ': ' + historyOnlyBad.join(',') : ''}`,
      pass: closedOnly.length > 0 && historyOnlyBad.length === 0,
    });

    const borrowOutstandingSum = customerRows.reduce(
      (acc, c) => acc + (c.borrowings ?? []).reduce((a, b) => a + Number(b.outstanding), 0),
      0,
    );
    const liveOutstandingSum = sum(all, (l) => l.currentOutstanding);
    check(CAT, 'ผลรวม outstanding ใน borrowings ของลูกค้าทุกคน = ยอดคงค้าง ACTIVE รวมจากหน้า loans', {
      input: `GET /api/customers เทียบ GET /api/loans?limit=100 (${all.length} แถว)`,
      expected: fmt(toCents(liveOutstandingSum)),
      actual: fmt(toCents(borrowOutstandingSum)),
      pass: sameMoney(borrowOutstandingSum, liveOutstandingSum),
    });

    const qNumber = await api('GET', '/api/loans?q=LN-TST-000003');
    check(CAT, 'ค้นหาด้วยเลข loan (q) เจอ 1 รายการ', {
      input: 'q=LN-TST-000003',
      expected: '1 row LN-TST-000003',
      actual: `${(qNumber.json.data ?? []).length} row ${qNumber.json.data?.[0]?.loanNumber}`,
      pass: (qNumber.json.data ?? []).length === 1 && qNumber.json.data[0].loanNumber === 'LN-TST-000003',
    });
    const laoCustomer = loansExp['LN-TST-000001'].customerNumber;
    const qName = await api('GET', `/api/loans?q=${encodeURIComponent('ຄຳໜີ')}&limit=100`);
    check(CAT, 'ค้นหาด้วยชื่อภาษาลาว: ต้องเจอและคืนเฉพาะloan ของลูกค้าคนนั้น', {
      input: 'q=<Lao name fragment>',
      expected: `rows only for ${laoCustomer}`,
      actual: `${(qName.json.data ?? []).length} row(s): ${(qName.json.data ?? []).map((r) => r.customer.customerNumber).join(',')}`,
      pass: (qName.json.data ?? []).length > 0 && (qName.json.data ?? []).every((r) => r.customer.customerNumber === laoCustomer),
    });
    const natId = (await api('GET', `/api/loans?customerId=${oneCustomer}&limit=1`).then((r) => r.json.data[0]?.customer?.nationalId)) ?? '';
    const qNat = await api('GET', `/api/loans?q=${natId}`);
    check(CAT, `ค้นหาด้วยเลขบัตรประชาชน (${natId})`, {
      input: 'q=nationalId',
      expected: '>=1 row of that customer',
      actual: `${(qNat.json.data ?? []).length} row`,
      pass: (qNat.json.data ?? []).length >= 1 && (qNat.json.data ?? []).every((r) => r.customerId === oneCustomer),
    });

    const clampLow = await api('GET', '/api/loans?limit=0');
    const clampHigh = await api('GET', '/api/loans?limit=5000');
    const clampJunk = await api('GET', '/api/loans?limit=abc');
    check(CAT, 'limit ที่ไม่สมเหตุสมผลต้องถูกกำกับ: 0/abc -> ค่า default 20, 5000 -> 100', {
      input: 'limit=0 / limit=abc / limit=5000',
      expected: 'echoed limit 20, 20 and 100',
      actual: `${clampLow.json.pagination?.limit} / ${clampJunk.json.pagination?.limit} / ${clampHigh.json.pagination?.limit}`,
      pass:
        clampLow.json.pagination?.limit === 20 && clampJunk.json.pagination?.limit === 20 && clampHigh.json.pagination?.limit === 100,
    });
    const farPage = await api('GET', '/api/loans?page=999&limit=10');
    check(CAT, 'page ที่เกินจำนวน: data ว่าง แต่ total คงเดิม', {
      input: 'page=999',
      expected: '0 rows, total 21',
      actual: `${(farPage.json.data ?? []).length} rows, total ${farPage.json.pagination?.total}`,
      pass: (farPage.json.data ?? []).length === 0 && farPage.json.pagination?.total === 21,
    });
    const pages = [];
    for (let p = 1; p <= 5; p++) pages.push((await api('GET', `/api/loans?page=${p}&limit=5`)).json.data ?? []);
    const flat = pages.flat().map((r) => r.id);
    check(CAT, 'แบ่งหน้าไม่ซ้ำและไม่ตกหล่น (5 หน้าที่ limit=5 ครอบคลุม 21 รายการ)', {
      input: 'page 1..5, limit 5',
      expected: '21 unique ids',
      actual: `${flat.length} rows, ${new Set(flat).size} unique`,
      pass: flat.length === 21 && new Set(flat).size === 21,
    });
    const sortedDesc = all.every((l, i) => i === 0 || Date.parse(all[i - 1].createdAt) >= Date.parse(l.createdAt));
    check(CAT, 'เรียงลำดับตาม createdAt ใหม่สุดก่อน', {
      input: 'GET /api/loans?limit=100',
      expected: 'non-increasing createdAt',
      actual: sortedDesc ? 'sorted' : 'out of order',
      pass: sortedDesc,
    });
    const viewerList = await api('GET', '/api/loans', { token: tokens.viewer });
    statusCheck(CAT, 'VIEWER อ่าน list loan ได้ (สิทธิ์อ่าน)', viewerList, 200, { input: USER_NAMES.viewer });

    // ================================================ B. detail
    const detailBad = await api('GET', `/api/loans/${NIL}`);
    statusCheck(CAT, 'loan ที่ไม่มีอยู่: 404', detailBad, 404, { input: NIL });
    check(CAT, 'ข้อความ error ของ 404 ต้องอ่านรู้เรื่อง (เช่น "Loan not found")', {
      input: 'GET /api/loans/<unknown>',
      expected: 'message contains "not found"',
      actual: `message = ${JSON.stringify(errorMessage(detailBad))}`,
      pass: /not found/i.test(errorMessage(detailBad)),
      note: 'notFound("Loan") ส่งเฉพาะชื่อ entity กลับไป frontend ไม่มีข้อความใช้ได้เลย',
    });

    const details = {};
    for (const id of seededIds) details[id] = (await api('GET', `/api/loans/${id}?limit=100`)).json.data;
    const firstDetail = details[seededIds[0]];
    check(CAT, 'detail มี loan + transactions + transactionPagination + credit + settlements', {
      input: 'GET /api/loans/:id',
      expected: ['loan', 'transactions', 'transactionPagination', 'credit', 'settlements'],
      actual: Object.keys(firstDetail ?? {}),
      pass: ['loan', 'transactions', 'transactionPagination', 'credit', 'settlements'].every((k) => k in (firstDetail ?? {})),
    });

    const osMismatch = seededIds.filter((id) => {
      const o = details[id]?.loan?.outstanding ?? {};
      const e = byId[id].outstanding;
      return !(
        sameMoney(o.penalty, e.PENALTY) &&
        sameMoney(o.pastInterest, e.PAST_INTEREST) &&
        sameMoney(o.pastPrincipal, e.PAST_PRINCIPAL) &&
        sameMoney(o.total, e.total)
      );
    });
    check(CAT, `ยอดคงค้าง ${seededIds.length} loan ตรง expected.json เป๊ะถึงทศนิยม`, {
      input: 'GET /api/loans/:id outstanding vs expected.loans',
      expected: 'all equal',
      actual: osMismatch.length ? `${osMismatch.length} mismatch: ${osMismatch.map((i) => byId[i].loanNumber).join(',')}` : 'all equal',
      pass: osMismatch.length === 0,
    });
    const statusMismatch = seededIds.filter((id) => details[id]?.loan?.status !== byId[id].status);
    check(CAT, 'สถานะ loan ทุกตัวตรงกับ expected.json (ACTIVE/CLOSED/WRITTEN_OFF)', {
      input: 'loan.status',
      expected: 'all equal',
      actual: statusMismatch.length ? statusMismatch.map((i) => `${byId[i].loanNumber}=${details[i]?.loan?.status}`).join(',') : 'all equal',
      pass: statusMismatch.length === 0,
    });
    const countMismatch = seededIds.filter((id) => {
      const txs = details[id]?.transactions ?? [];
      return (
        txs.filter((t) => t.status === 'POSTED').length !== byId[id].postedTransactionCount ||
        txs.filter((t) => t.status === 'PENDING_APPROVAL').length !== byId[id].pendingTransactionCount
      );
    });
    check(CAT, 'จำนวน transaction POSTED/PENDING ต่อ loan ตรงกับ expected.json', {
      input: 'detail.transactions grouped by status',
      expected: 'all equal',
      actual: countMismatch.length
        ? countMismatch
            .map((i) => `${byId[i].loanNumber}: ${details[i].transactions.filter((t) => t.status === 'POSTED').length}/${details[i].transactions.filter((t) => t.status === 'PENDING_APPROVAL').length}`)
            .join(',')
        : 'all equal',
      pass: countMismatch.length === 0,
    });

    // line = ยอดรายส่วนของ loan เดียว; หนี้เพิ่มเป็นบวก, การชำระ/ลดหนี้เป็นลบ (LOCKED: ต้นฉบับห้ามแก้)
    // payment 1 ใบ = เงินสด (PR.cashAmount) + credit ที่ใช้ (PR.creditApplied); ส่วนที่เกินยอดค้างกลายเป็น credit ใหม่ (credit_ledger ACCRUED)
    const CHARGE_TYPES = ['DISBURSEMENT', 'PENALTY', 'ADJUSTMENT', 'WRITE_OFF_REVERSAL', 'PAYMENT_REVERSAL'];
    const lineSums = (
      await conn.query(
        `SELECT tx.id, tx.loanId, tx.sourceRequestId, tx.referenceNo, tx.transactionType, tx.amount,
                COALESCE(SUM(line.amount),0) lineSum,
                COALESCE(pr.cashAmount,0) cashAmount, COALESCE(pr.creditApplied,0) creditApplied,
                COALESCE(cl.clCreditApplied,0) creditAppliedLedger,
                COALESCE(cl.clOverpay,0) overpayAccrued
           FROM financial_transactions tx
           LEFT JOIN financial_transaction_lines line ON line.transactionId = tx.id
           LEFT JOIN payment_requests pr ON pr.id = tx.sourceRequestId
           LEFT JOIN (
             SELECT transactionId,
                    SUM(CASE WHEN type='USED' THEN amount ELSE 0 END) clCreditApplied,
                    SUM(CASE WHEN type='ACCRUED' THEN amount ELSE 0 END) clOverpay
               FROM credit_ledger GROUP BY transactionId
           ) cl ON cl.transactionId = tx.id
          WHERE tx.loanId IN (?) AND tx.status = 'POSTED'
          GROUP BY tx.id, tx.loanId, tx.sourceRequestId, tx.referenceNo, tx.transactionType, tx.amount,
                   pr.cashAmount, pr.creditApplied, cl.clCreditApplied, cl.clOverpay`,
        [seededIds],
      )
    )[0];
    const unbalanced = lineSums.filter((r) => {
      const applied = Number(r.amount) - Number(r.overpayAccrued);
      // ADJUSTMENT มีได้สองทาง (เพิ่ม/ลดหนี้) — ตรวจด้วยขนาดยอด ส่วนเครื่องหมายต้องตรงกับ line รายส่วน
      if (r.transactionType === 'ADJUSTMENT') return !sameMoney(Math.abs(r.lineSum), r.amount);
      return CHARGE_TYPES.includes(r.transactionType) ? !sameMoney(r.lineSum, r.amount) : !sameMoney(r.lineSum, -applied);
    });
    check(CAT, `ทุก transaction ที่ POSTED (${lineSums.length} แถว): ผลรวม line รายส่วน = ยอดที่ตัดกับ loan จริง (หนี้+/ชำระ-, ไม่นับส่วนที่กลายเป็น credit)`, {
      input: 'financial_transaction_lines vs financial_transactions.amount - credit_ledger.ACCRUED',
      expected: 'all balanced',
      actual: unbalanced.length
        ? unbalanced.map((r) => `${r.referenceNo} type=${r.transactionType} amt=${r.amount} lines=${r.lineSum} overpay=${r.overpayAccrued}`).join(',')
        : 'all balanced',
      pass: unbalanced.length === 0,
    });
    const paymentRows = lineSums.filter((r) => r.sourceRequestId !== null);
    const creditMismatch = paymentRows.filter(
      (r) =>
        !sameMoney(Number(r.cashAmount) + Number(r.creditApplied), r.amount) ||
        !sameMoney(r.creditApplied, r.creditAppliedLedger),
    );
    check(CAT, `payment/settlement ที่ POSTED (${paymentRows.length} ใบ): tx.amount = เงินสด + credit ที่ใช้ และทุกการใช้ credit มี แถว USED ใน credit_ledger`, {
      input: 'payment_requests.cashAmount/creditApplied vs financial_transactions.amount + credit_ledger USED',
      expected: 'all consistent',
      actual: creditMismatch.length
        ? creditMismatch.map((r) => `${r.referenceNo} amt=${r.amount} cash=${r.cashAmount} credit=${r.creditApplied}/ledger ${r.creditAppliedLedger}`).join(',')
        : `${paymentRows.length} ใบ consistent`,
      pass: paymentRows.length > 0 && creditMismatch.length === 0,
    });
    const negativeCash = lineSums.filter((r) => Number(r.cashAmount) < 0);
    check(CAT, 'ไม่มี payment request ทิ่มียอดเงินสดติดลบ (ข้อมูลทดสอบต้องสมเหตุสมผลก่อนใช้ตรวจยอดคงค้าง)', {
      input: 'payment_requests.cashAmount of posted payments',
      expected: 'all >= 0',
      actual: negativeCash.length ? negativeCash.map((r) => `${r.referenceNo}=${r.cashAmount}`).join(',') : 'all >= 0',
      pass: negativeCash.length === 0,
      note: 'เคยพบบั๊กใน dataset ของเราเอง (useCredit > ยอดชำระ ทำให้เงินสดติดลบ) — แก้ใน dataset.mjs แล้ว',
    });

    const disbursedLines = (
      await conn.query(
        `SELECT tx.loanId, l.component, SUM(l.amount) s
           FROM financial_transactions tx
           JOIN financial_transaction_lines l ON l.transactionId = tx.id
          WHERE tx.loanId IN (?) AND tx.status='POSTED' AND tx.transactionType='DISBURSEMENT'
          GROUP BY tx.loanId, l.component`,
        [seededIds],
      )
    )[0];
    const disbursedBad = seededIds.filter((id) => {
      const e = byId[id];
      const p = Number(disbursedLines.find((r) => r.loanId === id && r.component === 'PAST_PRINCIPAL')?.s ?? NaN);
      const i = Number(disbursedLines.find((r) => r.loanId === id && r.component === 'PAST_INTEREST')?.s ?? 0);
      return !(sameMoney(p, e.principal) && sameMoney(i, e.billedInterest));
    });
    check(CAT, 'line ของ DISBURSEMENT ทุก loan = เงินต้น + ดอกเบี้ย flat ตาม expected.json (คำนวณจาก ledger)', {
      input: 'DISBURSEMENT component lines vs expected.principal/billedInterest',
      expected: 'all equal',
      actual: disbursedBad.length ? disbursedBad.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: disbursedBad.length === 0,
    });

    const l5 = byNum['LN-TST-000005'];
    check(CAT, 'ตัวอย่าง LN-TST-000005 (ค้างทั้งดอกเบี้ยและเงินต้น): แยกยอดคงค้างถูกต้อง', {
      input: l5.loanId,
      expected: `interest ${l5.outstanding.PAST_INTEREST} + principal ${l5.outstanding.PAST_PRINCIPAL}`,
      actual: JSON.stringify(details[l5.loanId].loan.outstanding),
      pass:
        sameMoney(details[l5.loanId].loan.outstanding.pastInterest, l5.outstanding.PAST_INTEREST) &&
        sameMoney(details[l5.loanId].loan.outstanding.pastPrincipal, l5.outstanding.PAST_PRINCIPAL),
    });
    const credCustomer = '00000000-2000-4000-8000-000000000020';
    const loanWithCredit = seededIds.find((id) => byId[id].customerId === credCustomer);
    check(CAT, 'detail ของ loan ที่ลูกค้ามีเงินรอใช้ (credit) แสดงยอดตาม expected.json', {
      input: byId[loanWithCredit].loanNumber,
      expected: expected.credits[credCustomer].balance,
      actual: details[loanWithCredit]?.credit?.balance,
      pass: sameMoney(details[loanWithCredit]?.credit?.balance, expected.credits[credCustomer].balance),
    });
    const paged = await api('GET', `/api/loans/${byNum['LN-TST-000001'].loanId}?limit=3&page=2`);
    check(CAT, 'pagination ของ transactions ใน detail ใช้ได้จริง', {
      input: 'limit=3&page=2',
      expected: '3 rows, total 7',
      actual: `${(paged.json.data.transactions ?? []).length} rows, total ${paged.json.data.transactionPagination?.total}`,
      pass: (paged.json.data.transactions ?? []).length === 3 && paged.json.data.transactionPagination?.total === 7,
    });

    // ================================================ C. schedule
    const schedules = {};
    for (const id of seededIds) {
      schedules[id] = (await api('GET', `/api/loans/${id}/schedule?asOf=${encodeURIComponent('2026-10-13T09:30:00.000Z')}`)).json.data;
    }
    check(CAT, 'GET /api/loans/:id/schedule ตอบกลับ 200 พร้อม data ครบทุก loan', {
      input: `${seededIds.length} loans`,
      expected: '200 + totals/periods on every loan',
      actual: `${seededIds.filter((id) => schedules[id]?.periods?.length && schedules[id].totals).length} usable`,
      pass: seededIds.every((id) => schedules[id]?.periods?.length && schedules[id].totals),
    });
    const perMismatch = seededIds.filter((id) => schedules[id]?.periodCount !== byId[id].periodCount);
    check(CAT, 'จำนวนงวด (periodCount) ตรงกับ expected.json ทุก loan', {
      input: 'schedule.periodCount',
      expected: 'all equal',
      actual: perMismatch.length ? perMismatch.map((i) => `${byId[i].loanNumber}=${schedules[i]?.periodCount}/${byId[i].periodCount}`).join(',') : 'all equal',
      pass: perMismatch.length === 0,
    });
    const dueMismatch = seededIds.filter(
      (id) => (schedules[id]?.periods ?? []).map((p) => dateOnly(p.dueDate)).join(',') !== byId[id].scheduleDueDates.join(','),
    );
    check(CAT, 'วันครบกำหนดรายงวดตรง expected.json ทุก loan (รวมกรณีปลายเดือน 31 -> 30 วัน)', {
      input: 'schedule.periods[].dueDate vs expected.scheduleDueDates',
      expected: 'all equal',
      actual: dueMismatch.length ? dueMismatch.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: dueMismatch.length === 0,
    });
    // ยอดที่ตารางงวดถือว่า "เรียกเก็บ" = line ประเภทหนี้ (PAYMENT_REVERSAL ไม่นับ เพราะคือการถอนเงินที่จ่ายไปแล้ว
    // และ WRITE_OFF_REVERSAL ก็ไม่นับเป็นหนี้ใหม่ เพราะมันแค่ยกเลิกการตัดหนี้ที่ค้างอยู่ในฝั่ง relief)
    const SCHEDULE_CHARGE_TYPES = ['DISBURSEMENT', 'PENALTY', 'ADJUSTMENT'];
    const SCHEDULE_RELIEF_TYPES = ['WAIVER', 'WRITE_OFF', 'WRITE_OFF_REVERSAL'];
    const chargeLines = (
      await conn.query(
        `SELECT tx.loanId, line.component, SUM(line.amount) s
           FROM financial_transactions tx
           JOIN financial_transaction_lines line ON line.transactionId = tx.id
          WHERE tx.loanId IN (?) AND tx.status='POSTED' AND tx.transactionType IN (?)
          GROUP BY tx.loanId, line.component`,
        [seededIds, SCHEDULE_CHARGE_TYPES],
      )
    )[0];
    const reliefLines = (
      await conn.query(
        `SELECT tx.loanId, line.component, SUM(line.amount) s
           FROM financial_transactions tx
           JOIN financial_transaction_lines line ON line.transactionId = tx.id
          WHERE tx.loanId IN (?) AND tx.status='POSTED' AND tx.transactionType IN (?)
          GROUP BY tx.loanId, line.component`,
        [seededIds, SCHEDULE_RELIEF_TYPES],
      )
    )[0];
    const chargedOf = (id, comp) =>
      Number(chargeLines.find((r) => String(r.loanId) === String(id) && r.component === comp)?.s ?? 0);
    const relievedOf = (id, comp) =>
      -Number(reliefLines.find((r) => String(r.loanId) === String(id) && r.component === comp)?.s ?? 0);
    const shareMismatch = seededIds.filter((id) => {
      const s = schedules[id];
      return !(
        sameMoney(sum(s.periods, (p) => p.principalDue), s.totals.principalCharged) &&
        sameMoney(sum(s.periods, (p) => p.interestDue), s.totals.interestCharged) &&
        sameMoney(s.totals.principalCharged, chargedOf(id, 'PAST_PRINCIPAL')) &&
        sameMoney(s.totals.interestCharged, chargedOf(id, 'PAST_INTEREST')) &&
        sameMoney(s.totals.relieved.PAST_PRINCIPAL, relievedOf(id, 'PAST_PRINCIPAL')) &&
        sameMoney(s.totals.relieved.PAST_INTEREST, relievedOf(id, 'PAST_INTEREST')) &&
        sameMoney(s.totals.relieved.PENALTY, relievedOf(id, 'PENALTY')) &&
        sameMoney(sum(s.periods, (p) => p.relieved), s.totals.relieved.PAST_PRINCIPAL + s.totals.relieved.PAST_INTEREST)
      );
    });
    check(CAT, 'ค่างวดรายงวดรวมกัน = totals.principalCharged/interestCharged และ = ผลรวม line ประเภทหนี้ใน ledger (เศษตกงวดสุดท้าย)', {
      input: 'Σ period.*Due vs totals.*Charged vs Σ ledger charge lines',
      expected: 'all equal',
      actual: shareMismatch.length
        ? shareMismatch
            .map(
              (i) =>
                `${byId[i].loanNumber}: due ${sum(schedules[i].periods, (p) => p.principalDue)}/${sum(schedules[i].periods, (p) => p.interestDue)} charged ${schedules[i].totals.principalCharged}/${schedules[i].totals.interestCharged} ledger ${chargedOf(i, 'PAST_PRINCIPAL')}/${chargedOf(i, 'PAST_INTEREST')}`,
            )
            .join(' ; ')
        : 'all equal',
      pass: shareMismatch.length === 0,
    });
    // loan ที่ไม่มี ADJUSTMENT / WRITE_OFF_REVERSAL: ยอดที่เรียกเก็บ = เงินต้น+ดอกเบี้ยตอนเบิกจ่ายตาม expected.json เป๊ะ
    const touchedByCharge = new Set(
      lineSums.filter((r) => r.transactionType === 'ADJUSTMENT' || r.transactionType === 'WRITE_OFF_REVERSAL').map((r) => String(r.loanId)),
    );
    const bookedMismatch = seededIds.filter((id) => {
      if (touchedByCharge.has(String(id))) return false;
      const s = schedules[id];
      const e = byId[id];
      return !(sameMoney(s.totals.principalCharged, e.principal) && sameMoney(s.totals.interestCharged, e.billedInterest));
    });
    check(CAT, `loan ที่ไม่มีการปรับยอด/กลับรายการ write-off (${seededIds.length - touchedByCharge.size} ตัว): ยอดเรียกเก็บ = principal + billedInterest ตาม expected.json`, {
      input: 'schedule totals vs expected.principal/billedInterest',
      expected: 'all equal',
      actual: bookedMismatch.length ? bookedMismatch.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: bookedMismatch.length === 0,
    });
    const uneven = seededIds.filter((id) => new Set(schedules[id].periods.slice(0, -1).map((p) => p.principalDue)).size > 1);
    check(CAT, 'ค่างต้นแต่ละงวดเท่ากัน ยกเว้นงวดสุดท้ายที่รับเศษ', {
      input: 'principalDue across periods 1..n-1',
      expected: 'one distinct value per loan',
      actual: uneven.length ? uneven.map((i) => byId[i].loanNumber).join(',') : 'one distinct value per loan',
      pass: uneven.length === 0,
    });
    const outMismatch = seededIds.filter((id) => {
      const t = schedules[id].totals;
      const e = byId[id].outstanding;
      return !(
        sameMoney(t.outstanding.PENALTY, e.PENALTY) &&
        sameMoney(t.outstanding.PAST_INTEREST, e.PAST_INTEREST) &&
        sameMoney(t.outstanding.PAST_PRINCIPAL, e.PAST_PRINCIPAL) &&
        sameMoney(t.totalOutstanding, e.total)
      );
    });
    check(CAT, 'schedule.totals.outstanding = ยอดคงค้างของบัญชี loan (สองมุมมองต้องตรงกัน)', {
      input: 'schedule totals vs loan outstanding',
      expected: 'all equal',
      actual: outMismatch.length ? outMismatch.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: outMismatch.length === 0,
    });
    const periodSumMismatch = seededIds.filter(
      (id) =>
        !sameMoney(
          sum(schedules[id].periods, (p) => p.outstanding),
          Number(byId[id].outstanding.PAST_INTEREST) + Number(byId[id].outstanding.PAST_PRINCIPAL),
        ),
    );
    check(CAT, 'Σ outstanding รายงวด = คงค้างส่วนดอกเบี้ย+เงินต้น (ค่าปรับไม่อยู่ในงวด)', {
      input: 'Σ period.outstanding',
      expected: 'all equal',
      actual: periodSumMismatch.length ? periodSumMismatch.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: periodSumMismatch.length === 0,
    });
    const agingMismatch = seededIds.filter(
      (id) => dateOnly(schedules[id].aging.maturityDate) !== byId[id].scheduleDueDates[byId[id].scheduleDueDates.length - 1],
    );
    check(CAT, 'aging.maturityDate = วันครบกำหนดงวดสุดท้ายเสมอ', {
      input: 'aging.maturityDate',
      expected: 'all equal',
      actual: agingMismatch.length ? agingMismatch.map((i) => byId[i].loanNumber).join(',') : 'all equal',
      pass: agingMismatch.length === 0,
    });
    const closedIds = seededIds.filter((id) => byId[id].status === 'CLOSED');
    const closedBad = closedIds.filter((id) => schedules[id].periods.some((p) => p.status !== 'PAID' || Number(p.outstanding) !== 0));
    check(CAT, `loan ที่ CLOSED (${closedIds.length} รายการ) งวดต้องปิดครบ PAID และหมด`, {
      input: 'status CLOSED',
      expected: 'all periods PAID with outstanding 0',
      actual: closedBad.length ? closedBad.map((i) => byId[i].loanNumber).join(',') : 'all periods PAID',
      pass: closedBad.length === 0,
    });
    const suggestedNegative = seededIds.filter((id) => (schedules[id].totals.penaltySuggested ?? -1) < 0);
    check(CAT, 'penaltySuggested (ค่าปรับที่ระบบเสนอให้เรียกเก็บ) ต้องไม่ติดลบ', {
      input: 'totals.penaltySuggested',
      expected: '>= 0 on every loan',
      actual: suggestedNegative.length ? suggestedNegative.map((i) => byId[i].loanNumber).join(',') : 'all >= 0',
      pass: suggestedNegative.length === 0,
    });
    const negComp = seededIds.filter((id) => Object.values(schedules[id].totals.outstanding).some((v) => Number(v) < 0));
    check(CAT, 'ไม่มีส่วนใดของยอดคงค้างติดลบ (ห้ามชำระ/ยกเว้นค่าปรับเกินยอดที่เรียกเก็บ)', {
      input: 'totals.outstanding components',
      expected: 'all >= 0',
      actual: negComp.length
        ? `${negComp.map((i) => `${byId[i].loanNumber} = ${JSON.stringify(schedules[i].totals.outstanding)}`).join(' ; ')} — Σ งวด (${fmt(toCents(sum(schedules[negComp[0]].periods, (p) => p.outstanding)))}) != totalOutstanding (${fmt(toCents(schedules[negComp[0]].totals.totalOutstanding))})`
        : 'all >= 0',
      pass: negComp.length === 0,
      note: 'ข้อมูลชุดนี้แก้แล้ว: waiver ต้องไม่เกินยอดที่เรียกเก็บจริง (oracle ยืนยันกฎเดียวกัน)',
    });

    // loan ที่ค้างทั้งงวด (ไม่มีงวด partial) เท่านั้นที่ทำให้เห็น aging เปลี่ยนตาม asOf
    const overdueLoan = byNum['LN-TST-000015'];
    const asOfEarly = await api('GET', `/api/loans/${overdueLoan.loanId}/schedule?asOf=2026-01-05T09:30:00.000Z`);
    const asOfLate = await api('GET', `/api/loans/${overdueLoan.loanId}/schedule?asOf=2026-03-05T09:30:00.000Z`);
    check(CAT, 'asOf คนละเวลา: จำนวนงวดค้าง/วันค้างต้องมากขึ้นตามเวลา ณ ตอนนั้น', {
      input: `asOf 2026-01-05 vs 2026-03-05 on ${overdueLoan.loanNumber} (ค้างครบทุกงวด)`,
      expected: 'later asOf => more overduePeriods and larger maxOverdueDays',
      actual: `overdue ${asOfEarly.json.data.aging.overduePeriods}->${asOfLate.json.data.aging.overduePeriods}, maxDays ${asOfEarly.json.data.aging.maxOverdueDays}->${asOfLate.json.data.aging.maxOverdueDays}`,
      pass:
        asOfLate.json.data.aging.maxOverdueDays > asOfEarly.json.data.aging.maxOverdueDays &&
        asOfLate.json.data.aging.overduePeriods >= asOfEarly.json.data.aging.overduePeriods,
    });
    statusCheck(CAT, 'schedule ด้วย asOf ที่ไม่ใช่วันที่: 400', await api('GET', `/api/loans/${overdueLoan.loanId}/schedule?asOf=not-a-date`), 400, {
      input: 'asOf=not-a-date',
      messageIncludes: 'asOf must be a valid date',
    });
    statusCheck(CAT, 'schedule แบบไม่ส่ง asOf (ใช้เวลาระบบ): 200', await api('GET', `/api/loans/${overdueLoan.loanId}/schedule`), 200, { input: 'no asOf' });
    statusCheck(CAT, 'schedule ของ loan ที่ไม่มีอยู่: 404', await api('GET', `/api/loans/${NIL}/schedule`), 404, { input: NIL });

    // ---- ข้อสังเกต (ยังไม่แก้โค้ดระบบ): periodStatus คืน PARTIAL ก่อน OVERDUE งวดที่ค้างจริงแต่มีเงินเข้าบางส่วนจึงหลุดจาก aging
    const partialOverdue = seededIds.filter(
      (id) =>
        schedules[id].periods.some((p) => p.status === 'PARTIAL' && p.outstanding > 0 && dateOnly(p.dueDate) < '2026-10-13') &&
        schedules[id].aging.overduePeriods === 0,
    );
    check(CAT, '[F-SCH-1] งวดที่เลยกำหนดมากับมีชำระบางส่วน: aging ต้องนับว่าค้างด้วย', {
      input: 'aging.overduePeriods vs count(PARTIAL periods past dueDate)',
      expected: 'overduePeriods >= number of PARTIAL periods already past their due date',
      actual: partialOverdue
        .map((i) => `${byId[i].loanNumber}: PARTIAL overdue=${schedules[i].periods.filter((p) => p.status === 'PARTIAL' && dateOnly(p.dueDate) < '2026-10-13').length} แต่ aging.overduePeriods=${schedules[i].aging.overduePeriods}, maxOverdueDays=${schedules[i].aging.maxOverdueDays}`)
        .join(' ; '),
      pass: partialOverdue.length === 0,
      note: 'sur finding, still reported only (no system code changed)',
    });

    // ---- WRITE_OFF / WAIVER / WRITE_OFF_REVERSAL ถูกตีความเป็น "ลูกค้าจ่ายแล้ว" ในตารางงวด
    const l20 = schedules[byNum['LN-TST-000020'].loanId];
    const l20tx = details[byNum['LN-TST-000020'].loanId].transactions;
    const l20paid = sum(l20.periods, (p) => p.paid);
    check(CAT, '[F-SCH-2] loan ที่ไม่เคยมี payment (write-off แล้วกลับรายการ): งวดต้องไม่แสดงว่าชำระแล้ว', {
      input: 'LN-TST-000020 periods.paid vs its transactions',
      expected: `paid 0 (no PAYMENT/SETTLEMENT in ledger, only DISBURSEMENT+WRITE_OFF+WRITE_OFF_REVERSAL)`,
      actual: `periods.paid sum = ${fmt(toCents(l20paid))}, loan paid totals = ${JSON.stringify(l20.totals.paid)}, payments in ledger = ${l20tx.filter((t) => t.transactionType === 'PAYMENT').length}`,
      pass: l20paid === 0,
      note: 'ตารางงวดหักเฉพาะค่าปรับที่ยกเว้นออกจากยอดเรียกเก็บ แต่ไม่หัก write-off/waiver ของดอกเบี้ย+เงินต้น',
    });
    const l19 = schedules[byNum['LN-TST-000019'].loanId];
    check(CAT, '[F-SCH-2] loan ที่ write-off บางส่วน: ยอด write-off ต้องไม่โผล่เป็นงวดที่ชำระแล้ว', {
      input: 'LN-TST-000019 (write-off 5,000,000 of principal)',
      expected: 'paid.PAST_PRINCIPAL = 1120000 (the only real payment to principal)',
      actual: `paid.PAST_PRINCIPAL = ${l19.totals.paid.PAST_PRINCIPAL}`,
      pass: sameMoney(l19.totals.paid.PAST_PRINCIPAL, 1120000),
    });

    // ================================================ D. allocation preview
    const preview = (id, amount) => api('GET', `/api/loans/${id}/allocation-preview?amount=${amount}`);
    const orderRes = await preview(l5.loanId, 4000000);
    check(CAT, 'การกระจายเงินชำระ (loan ค้างดอกเบี้ย+เงินต้น): เรียง PENALTY -> PAST_INTEREST -> PAST_PRINCIPAL', {
      input: 'amount 4,000,000 on LN-TST-000005',
      expected: { PENALTY: 0, PAST_INTEREST: 3120000, PAST_PRINCIPAL: 880000 },
      actual: orderRes.json.data.allocation,
      pass:
        sameMoney(orderRes.json.data.allocation.PAST_INTEREST, 3120000) &&
        sameMoney(orderRes.json.data.allocation.PAST_PRINCIPAL, 880000) &&
        sameMoney(orderRes.json.data.allocation.PENALTY, 0),
    });
    const overRes = await preview(l5.loanId, 20000000);
    check(CAT, 'ชำระเกินยอดคงค้าง: ส่วนเกินออกมาเป็น excess (จะกลายเป็นเงินรอใช้ของลูกค้า)', {
      input: 'amount 20,000,000 on outstanding 18,120,000',
      expected: { excess: 1880000, allocation: { PENALTY: 0, PAST_INTEREST: 3120000, PAST_PRINCIPAL: 15000000 } },
      actual: { excess: overRes.json.data.excess, allocation: overRes.json.data.allocation },
      pass:
        sameMoney(overRes.json.data.excess, 1880000) &&
        sameMoney(overRes.json.data.allocation.PAST_INTEREST, 3120000) &&
        sameMoney(overRes.json.data.allocation.PAST_PRINCIPAL, 15000000),
    });
    const tinyRes = await preview(l5.loanId, 1);
    check(CAT, 'เงินก้อนเล็กมาก (1 LAK) ต้องตัดที่ส่วนแรกที่ยังค้าง = ดอกเบี้ย', {
      input: 'amount 1',
      expected: { PAST_INTEREST: 1, PAST_PRINCIPAL: 0 },
      actual: { PAST_INTEREST: tinyRes.json.data.allocation.PAST_INTEREST, PAST_PRINCIPAL: tinyRes.json.data.allocation.PAST_PRINCIPAL },
      pass: sameMoney(tinyRes.json.data.allocation.PAST_INTEREST, 1) && sameMoney(tinyRes.json.data.allocation.PAST_PRINCIPAL, 0),
    });
    const l17 = byNum['LN-TST-000017'];
    const negRes = await preview(l17.loanId, 600000);
    const l17negAlloc = negRes.json.data.allocation;
    check(CAT, 'ค่าปรับเป็น 0 (ห้ามติดลบเป็นฐานกระจายเงิน): ตัดเงินต้นค้างครบ ที่เหลือเกินเป็น excess', {
      input: 'amount 600,000 on LN-TST-000017 (PENALTY 0, PAST_PRINCIPAL 312,000)',
      expected: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 312000, excess: 288000 },
      actual: { PENALTY: l17negAlloc.PENALTY, PAST_INTEREST: l17negAlloc.PAST_INTEREST, PAST_PRINCIPAL: l17negAlloc.PAST_PRINCIPAL, excess: negRes.json.data.excess },
      pass:
        sameMoney(l17negAlloc.PENALTY, 0) &&
        sameMoney(l17negAlloc.PAST_INTEREST, 0) &&
        sameMoney(l17negAlloc.PAST_PRINCIPAL, 312000) &&
        sameMoney(negRes.json.data.excess, 288000) &&
        Object.values(l17negAlloc).every((v) => Number(v) >= 0),
      note: 'ข้อมูลชุดนี้แก้ไขให้ waive ยอดที่ยังค้างอยู่จริงแล้ว (เดิม waiver เกินยอดจนค่าปรับติดลบ)',
    });
    const closedPreview = await preview(byNum['LN-TST-000002'].loanId, 1000);
    check(CAT, 'loan ที่ปิดแล้ว: allocation เป็น 0 ทั้งหมด และ excess = จำนวนเงิน', {
      input: 'amount 1,000 on CLOSED LN-TST-000002',
      expected: { allocation: 'all zero', excess: 1000 },
      actual: { allocation: closedPreview.json.data.allocation, excess: closedPreview.json.data.excess },
      pass:
        closedPreview.json.data.allocation.PENALTY === 0 &&
        closedPreview.json.data.allocation.PAST_INTEREST === 0 &&
        closedPreview.json.data.allocation.PAST_PRINCIPAL === 0 &&
        sameMoney(closedPreview.json.data.excess, 1000),
    });

    const previewCases = [];
    for (const id of [l5.loanId, byNum['LN-TST-000012'].loanId, l17.loanId, byNum['LN-TST-000013'].loanId, byNum['LN-TST-000010'].loanId]) {
      for (const amount of [1000, 216000, 3120000, 8850000, 60000000]) previewCases.push({ id, amount });
    }
    const previewMismatch = [];
    for (const c of previewCases) {
      const res = await preview(c.id, c.amount);
      const { allocation, overpaymentCents } = allocateComponents(toCents(c.amount), {
        PENALTY: toCents(Math.max(0, Number(byId[c.id].outstanding.PENALTY))),
        PAST_INTEREST: toCents(byId[c.id].outstanding.PAST_INTEREST),
        PAST_PRINCIPAL: toCents(byId[c.id].outstanding.PAST_PRINCIPAL),
      });
      const d = res.json.data ?? {};
      const ok =
        sameMoney(d.allocation?.PENALTY, toLak(allocation.PENALTY)) &&
        sameMoney(d.allocation?.PAST_INTEREST, toLak(allocation.PAST_INTEREST)) &&
        sameMoney(d.allocation?.PAST_PRINCIPAL, toLak(allocation.PAST_PRINCIPAL)) &&
        sameMoney(d.excess, toLak(overpaymentCents));
      if (!ok) previewMismatch.push(`${byId[c.id].loanNumber}/${c.amount}: api=${JSON.stringify(d)} oracle=${JSON.stringify({ ...allocation, excess: overpaymentCents })}`);
    }
    check(CAT, `preview ตรงกับ oracle ที่คำนวณอิสระทุกกรณี (${previewCases.length} ชุดยอด x loan)`, {
      input: 'oracle.allocateComponents vs API',
      expected: 'all equal',
      actual: previewMismatch.length ? previewMismatch.join(',') : 'all equal',
      pass: previewMismatch.length === 0,
    });
    for (const bad of ['0', '-5', 'abc', '']) {
      statusCheck(CAT, `preview ด้วย amount="${bad}": 400`, await preview(l5.loanId, bad), 400, {
        input: `amount=${bad}`,
        messageIncludes: 'amount must be > 0',
      });
    }
    statusCheck(CAT, 'preview ของ loan ที่ไม่มีอยู่: 404', await preview(NIL, 1000), 404, { input: NIL });

    // ================================================ E. create: validation + gates
    const M12 = product('TST-FLAT-M12');
    const post = (body, token = tokens.admin) => api('POST', '/api/loans', { token, body });
    const record = async (body, token) => {
      const res = await post(body, token);
      if (res.status === 201) created.push(res.json.data.loan.id);
      return res;
    };

    statusCheck(CAT, 'VIEWER สร้าง loan ไม่ได้: 403', await post({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000000 }, tokens.viewer), 403, {
      input: USER_NAMES.viewer,
      messageIncludes: 'Requires role',
    });
    for (const [key, role] of [
      ['op1', 'MAKER'],
      ['checker1', 'CHECKER'],
      ['head', 'HEAD_APPROVER'],
    ]) {
      const res = await record({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000000 }, tokens[key]);
      statusCheck(CAT, `${role} สร้าง loan + บันทึกจ่ายกู้ได้: 201`, res, 201, { input: USER_NAMES[key] });
      const audit = (
        await conn.query('SELECT userId, amount, newStatus FROM audit_logs WHERE action=? AND loanId=?', ['LOAN_DISBURSED', res.json.data.loan.id])
      )[0];
      check(CAT, `audit LOAN_DISBURSED ของ ${role} อ้างถึงผู้ใช้ที่สร้างจริงและลงสถานะ ACTIVE`, {
        input: `${USER_NAMES[key]} (id ${jwtId(tokens[key]).slice(0, 8)}...)`,
        expected: `1 row, userId = actor, amount = 1000000.00`,
        actual: audit.length ? `${audit.length} row, userId ${audit[0].userId}, amount ${audit[0].amount}, status ${audit[0].newStatus}` : 'no audit row',
        pass: audit.length === 1 && audit[0].userId === jwtId(tokens[key]) && sameMoney(audit[0].amount, 1000000) && audit[0].newStatus === 'ACTIVE',
      });
    }

    const gatePending = await post({ customerId: pendingCustomer, productId: M12.id, principalAmount: 1000000 });
    statusCheck(CAT, 'ลูกค้า KYC ยัง PENDING: ห้ามจ่ายเงินกู้ 422', gatePending, 422, {
      input: 'CUST-TST-0021 (PENDING)',
      messageIncludes: 'disbursement requires VERIFIED KYC',
    });
    statusCheck(CAT, 'ลูกค้า KYC NOT_VERIFIED: 422 พร้อมระบุรหัสลูกค้า', await post({ customerId: notVerifiedCustomer, productId: M12.id, principalAmount: 1000000 }), 422, {
      input: 'CUST-TST-0024',
      messageIncludes: 'CUST-TST-0024',
    });
    const loanCountNow = (await conn.query('SELECT COUNT(*) n FROM loans').then((r) => r[0][0].n)) ?? 0;
    check(CAT, 'KYC gate ต้องไม่เหลือแถว loan/transaction ไว้', {
      input: 'POST rejected by KYC gate',
      expected: `loans = 21 + ${created.length} created`,
      actual: `loans = ${loanCountNow}`,
      pass: loanCountNow === 21 + created.length,
    });

    statusCheck(CAT, 'ลูกค้า UUID ที่ไม่มีอยู่ในระบบ: 400 Customer not found', await post({ customerId: '00000000-2000-4000-8000-000000000099', productId: M12.id, principalAmount: 1000000 }), 400, {
      input: 'valid UUID that is not in customers',
      messageIncludes: 'Customer not found',
    });
    statusCheck(CAT, 'ลูกค้า id ไม่ใช่ UUID: 400 validation', await post({ customerId: '00000000-2000-4000-8000-00000099', productId: M12.id, principalAmount: 1000000 }), 400, {
      input: 'malformed customerId',
      messageIncludes: 'Validation failed',
    });
    statusCheck(CAT, 'ผลิตภัณฑ์ที่ปิดใช้แล้ว (TST-INACTIVE): 400', await post({ customerId: verifiedCustomer, productId: product('TST-INACTIVE').id, principalAmount: 1000000 }), 400, {
      messageIncludes: 'Loan product not found or inactive',
    });
    statusCheck(CAT, 'ผลิตภัณฑ์ที่ไม่มีอยู่: 400', await post({ customerId: verifiedCustomer, productId: NIL, principalAmount: 1000000 }), 400, {
      messageIncludes: 'Loan product not found or inactive',
    });

    const validationCases = [
      ['body ว่าง', {}],
      ['customerId ไม่ใช่ uuid', { customerId: 'abc', productId: M12.id, principalAmount: 1000 }],
      ['principal เป็น string', { customerId: verifiedCustomer, productId: M12.id, principalAmount: '1000' }],
      ['principal = 0', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 0 }],
      ['principal ติดลบ', { customerId: verifiedCustomer, productId: M12.id, principalAmount: -500000 }],
      ['termValue ไม่มี termUnit', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, termValue: 5 }],
      ['termValue = 0', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, termValue: 0, termUnit: 'MONTH' }],
      ['termValue เกิน 7300', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, termValue: 7301, termUnit: 'DAY' }],
      ['termUnit ไม่อยู่ใน enum', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, termValue: 3, termUnit: 'FORTNIGHT' }],
      ['disbursedAt ไม่ใช่ ISO datetime', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, disbursedAt: '2026-13-45' }],
      ['note ยาวเกิน 1000 ตัว', { customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000, note: 'x'.repeat(1001) }],
      ['productId ไม่ใช่ uuid', { customerId: verifiedCustomer, productId: 'nope', principalAmount: 1000 }],
    ];
    for (const [label, body] of validationCases) {
      statusCheck(CAT, `validation: ${label} -> 400`, await post(body), 400, { input: label, messageIncludes: 'Validation failed' });
    }

    // ================================================ F. create: financial truth
    const variants = [
      { label: 'ผลิตภัณฑ์ 1.5%/เดือน 12 เดือน (ใช้ term จากผลิตภัณฑ์)', productCode: 'TST-FLAT-M12', principal: 5000000 },
      { label: 'ส่ง termMonths=6 ทับ term ของผลิตภัณฑ์', productCode: 'TST-FLAT-M12', principal: 5000000, termMonths: 6 },
      { label: 'อัตรา 0.4%/สัปดาห์ 26 สัปดาห์', productCode: 'TST-WEEK-TERM', principal: 1234567 },
      { label: 'อัตรา 0.05%/วัน 90 วัน (เงินต้นที่มีเศษเซนต์)', productCode: 'TST-DAY-RATE', principal: 999999.99 },
      { label: 'อัตรา 18%/ปี 2 ปี', productCode: 'TST-YEAR-TERM', principal: 10000000 },
      { label: 'ผลิตภัณฑ์ดอกเบี้ย 0% (ค่างวด = เงินต้นล้วน)', productCode: 'TST-NOPEN-ZERO', principal: 100 },
      { label: 'termValue=7 + termUnit=DAY บนผลิตภัณฑ์รายเดือน (หน่วยผสม)', productCode: 'TST-FLAT-M12', principal: 1000000, termValue: 7, termUnit: 'DAY' },
      { label: 'termMonths=3 + termUnit=YEAR (3 ปี)', productCode: 'TST-FLAT-M6', principal: 2000000, termMonths: 3, termUnit: 'YEAR' },
      { label: 'เงินต้นมาก 200,000,000', productCode: 'TST-FLAT-M12', principal: 200000000 },
      { label: 'วันออกกู้ย้อนหลังปลายเดือน 2026-09-30', productCode: 'TST-FLAT-M12', principal: 3000000, disbursedAt: '2026-09-30T09:00:00.000Z' },
      { label: 'วันออกกู้ข้ามปี 2024-12-31', productCode: 'TST-FLAT-M6', principal: 3000000, disbursedAt: '2024-12-31T09:00:00.000Z' },
    ];

    for (const v of variants) {
      const p = product(v.productCode);
      const termValue = v.termValue ?? v.termMonths ?? p.termValue;
      const termUnit = v.termUnit ?? (v.termMonths !== undefined ? 'MONTH' : p.termUnit);
      const interest = toLak(
        billedInterestCents({ principalCents: toCents(v.principal), ratePercent: p.interestRate, rateUnit: p.interestRatePeriod, termValue, termUnit }),
      );
      const expectPeriods = Math.max(1, Math.round(termValue * MONTHS_PER_UNIT[termUnit]));
      const body = { customerId: verifiedCustomer, productId: p.id, principalAmount: v.principal, note: `E2E ${v.label}` };
      if (v.termValue !== undefined) {
        body.termValue = v.termValue;
        body.termUnit = v.termUnit;
      }
      if (v.termMonths !== undefined) {
        body.termMonths = v.termMonths;
        if (v.termUnit) body.termUnit = v.termUnit;
      }
      if (v.disbursedAt) body.disbursedAt = v.disbursedAt;

      const res = await record(body);
      const loan = res.json.data?.loan;
      const tx = res.json.data?.disbursementTransaction;
      statusCheck(CAT, `สร้าง loan (${v.label}): 201`, res, 201, { input: `${v.productCode} principal ${v.principal}` });
      check(CAT, `ดอกเบี้ยที่บันทึกตอนออกกู้ (${v.label}) = สูตร flat ตาม oracle เป๊ะถึงเซนต์`, {
        input: `P=${v.principal} rate=${p.interestRate}/${p.interestRatePeriod} term=${termValue}${termUnit}`,
        expected: fmt(toCents(interest)),
        actual: fmt(toCents(loan?.outstanding?.pastInterest ?? NaN)),
        pass: sameMoney(loan?.outstanding?.pastInterest, interest),
      });
      check(CAT, `ยอดคงค้างรวม = เงินต้น + ดอกเบี้ย flat ที่บันทึกทั้งก้อน (${v.label})`, {
        input: 'loan.outstanding / currentOutstanding',
        expected: { principal: fmt(toCents(v.principal)), total: fmt(toCents(v.principal + interest)) },
        actual: {
          principal: fmt(toCents(loan?.outstanding?.pastPrincipal ?? NaN)),
          total: fmt(toCents(loan?.outstanding?.total ?? NaN)),
          currentOutstanding: fmt(toCents(loan?.currentOutstanding ?? NaN)),
        },
        pass:
          sameMoney(loan?.outstanding?.pastPrincipal, v.principal) &&
          sameMoney(loan?.outstanding?.total, v.principal + interest) &&
          sameMoney(loan?.currentOutstanding, v.principal + interest),
      });
      check(CAT, `transaction DISBURSEMENT ถูกโพสต์ทันที (POSTED) และแยกรายส่วนครบ (${v.label})`, {
        input: 'disbursementTransaction',
        expected: {
          transactionType: 'DISBURSEMENT',
          status: 'POSTED',
          amount: fmt(toCents(v.principal + interest)),
          components: { PENALTY: 0, PAST_INTEREST: fmt(toCents(interest)), PAST_PRINCIPAL: fmt(toCents(v.principal)) },
        },
        actual: tx && {
          transactionType: tx.transactionType,
          status: tx.status,
          amount: fmt(toCents(tx.amount)),
          components: {
            PENALTY: fmt(toCents(tx.componentAmounts?.PENALTY)),
            PAST_INTEREST: fmt(toCents(tx.componentAmounts?.PAST_INTEREST)),
            PAST_PRINCIPAL: fmt(toCents(tx.componentAmounts?.PAST_PRINCIPAL)),
          },
        },
        pass:
          tx?.transactionType === 'DISBURSEMENT' &&
          tx?.status === 'POSTED' &&
          sameMoney(tx?.amount, v.principal + interest) &&
          sameMoney(tx?.componentAmounts?.PAST_PRINCIPAL, v.principal) &&
          sameMoney(tx?.componentAmounts?.PAST_INTEREST, interest) &&
          sameMoney(tx?.componentAmounts?.PENALTY, 0),
      });
      const term = await api('GET', `/api/loans/${loan.id}/schedule?asOf=2026-10-13T09:30:00.000Z`);
      const sched = term.json.data ?? {};
      check(CAT, `schedule ของ loan ใหม่: จำนวนงวด/เงินต้น/ดอกเบี้ย ตรงกับที่บันทึก (${v.label})`, {
        input: 'GET /api/loans/:id/schedule',
        expected: { periodCount: expectPeriods, principalCharged: fmt(toCents(v.principal)), interestCharged: fmt(toCents(interest)) },
        actual: {
          periodCount: sched.periodCount,
          principalCharged: fmt(toCents(sched.totals?.principalCharged ?? NaN)),
          interestCharged: fmt(toCents(sched.totals?.interestCharged ?? NaN)),
        },
        pass:
          sched.periodCount === expectPeriods &&
          sameMoney(sched.totals?.principalCharged, v.principal) &&
          sameMoney(sched.totals?.interestCharged, interest),
      });
      const previewNew = await api('GET', `/api/loans/${loan.id}/allocation-preview?amount=${v.principal + interest}`);
      check(CAT, `preview ยอดเต็มของ loan ใหม่: กระจายครบทุกส่วน ไม่มีเงินเกิน (${v.label})`, {
        input: `amount ${v.principal + interest}`,
        expected: { PAST_INTEREST: fmt(toCents(interest)), PAST_PRINCIPAL: fmt(toCents(v.principal)), excess: 0 },
        actual: previewNew.json.data?.allocation && {
          PAST_INTEREST: fmt(toCents(previewNew.json.data.allocation.PAST_INTEREST)),
          PAST_PRINCIPAL: fmt(toCents(previewNew.json.data.allocation.PAST_PRINCIPAL)),
          excess: previewNew.json.data.excess,
        },
        pass:
          sameMoney(previewNew.json.data?.allocation?.PAST_INTEREST, interest) &&
          sameMoney(previewNew.json.data?.allocation?.PAST_PRINCIPAL, v.principal) &&
          sameMoney(previewNew.json.data?.excess, 0),
      });
    }

    // ------------------------------------------- created rows: DB-side truth
    const createdIds = [...created];
    const lines = (
      await conn.query(
        `SELECT tx.id, tx.referenceNo, tx.amount, COALESCE(SUM(line.amount),0) lineSum, COUNT(line.id) n
           FROM financial_transactions tx
           LEFT JOIN financial_transaction_lines line ON line.transactionId = tx.id
          WHERE tx.loanId IN (?)
          GROUP BY tx.id, tx.referenceNo, tx.amount`,
        [createdIds],
      )
    )[0];
    check(CAT, 'transaction ใหม่ทุกแถวมี 2 line (เงินต้น + ดอกเบี้ย) และผลรวม line = ยอด tx', {
      input: `${lines.length} created transactions`,
      expected: '2 lines each, balanced',
      actual: lines.map((r) => `${r.referenceNo}:${r.n}`).join(','),
      pass: lines.length === createdIds.length && lines.every((r) => r.n === 2 && sameMoney(r.amount, r.lineSum)),
    });
    const auditRows = (
      await conn.query(`SELECT loanId, action FROM audit_logs WHERE loanId IN (?) AND action IN ('LOAN_DISBURSED','TRANSACTION_POSTED')`, [createdIds])
    )[0];
    check(CAT, 'ทุกการออกกู้มี audit LOAN_DISBURSED + TRANSACTION_POSTED ครบคู่', {
      input: `${createdIds.length} loans`,
      expected: `${createdIds.length * 2} audit rows`,
      actual: `${auditRows.length} audit rows`,
      pass: auditRows.length === createdIds.length * 2,
    });
    const auditAmount = (
      await conn.query(
        `SELECT COUNT(*) n FROM audit_logs a JOIN loans l ON l.id = a.loanId
          WHERE a.action='LOAN_DISBURSED' AND l.id IN (?) AND a.amount <> l.principalAmount`,
        [createdIds],
      )
    )[0][0].n;
    check(CAT, 'audit LOAN_DISBURSED บันทึกจำนวนเงิน = เงินต้นที่กู้', {
      input: 'audit_logs LOAN_DISBURSED.amount vs loans.principalAmount',
      expected: '0 mismatched',
      actual: `${auditAmount} mismatched`,
      pass: auditAmount === 0,
    });
    const postedAmount = (
      await conn.query(
        `SELECT COUNT(*) n FROM audit_logs a JOIN financial_transactions t ON t.id = a.transactionId
          WHERE a.action='TRANSACTION_POSTED' AND t.loanId IN (?) AND a.amount <> t.amount`,
        [createdIds],
      )
    )[0][0].n;
    check(CAT, 'audit TRANSACTION_POSTED บันทึกเงิน = ยอด transaction (เงินต้น+ดอกเบี้ย)', {
      input: 'audit_logs TRANSACTION_POSTED.amount vs transaction.amount',
      expected: '0 mismatched',
      actual: `${postedAmount} mismatched`,
      pass: postedAmount === 0,
    });
    const outRows = (await conn.query('SELECT loanId, type, recipientEmail FROM notification_outbox WHERE loanId IN (?)', [createdIds]))[0];
    check(CAT, 'ออกกู้แล้วมี event LOAN_APPLICATION_SUBMITTED ส่งถึงอีเมลลูกค้า @test.local', {
      input: `${createdIds.length} loans`,
      expected: 'one event per created loan, recipient @test.local',
      actual: `${outRows.length} rows, ${[...new Set(outRows.map((r) => r.loanId))].size} loans, domains ${[...new Set(outRows.map((r) => r.recipientEmail.split('@')[1]))].join(',')}`,
      pass: outRows.length >= 1 && outRows.every((r) => r.type === 'LOAN_APPLICATION_SUBMITTED' && r.recipientEmail.endsWith('@test.local')),
    });
    const workflowRows = (
      await conn.query(
        `SELECT COUNT(*) n FROM approval_workflows WHERE subjectId IN (SELECT id FROM financial_transactions WHERE loanId IN (?)) OR subjectId IN (?)`,
        [createdIds, createdIds],
      )
    )[0][0].n;
    check(CAT, 'การบันทึกเงินออกกู้โพสต์ตรง ไม่ค้าง approval workflow ให้ต้องอนุมัติซ้ำ', {
      input: 'approval_workflows referencing created loans/transactions',
      expected: 0,
      actual: workflowRows,
      pass: workflowRows === 0,
    });
    const createdLoans = (await conn.query('SELECT id, loanNumber, penaltyPolicy, currency, status, interestRate, interestRatePeriod, termValue, termUnit FROM loans WHERE id IN (?)', [createdIds]))[0];
    check(CAT, 'loan ใหม่ทุกตัว: สถานะ ACTIVE, สกุลเงิน LAK และมี snapshot นโยบายค่าปรับจากผลิตภัณฑ์', {
      input: `${createdLoans.length} loans`,
      expected: 'ACTIVE + policy snapshot + currency present',
      actual: createdLoans.filter((l) => l.status !== 'ACTIVE' || !l.penaltyPolicy || !l.currency).map((l) => l.loanNumber).join(',') || 'all ok',
      pass: createdLoans.every((l) => l.status === 'ACTIVE' && l.penaltyPolicy && l.currency === 'LAK'),
    });
    const numbers = createdLoans.map((l) => l.loanNumber);
    check(CAT, 'เลข loan ตั้ง auto เป็น LN-###### และไม่ซ้ำกัน', {
      input: numbers.join(','),
      expected: 'unique LN-\\d{6}',
      actual: `${new Set(numbers).size} unique of ${numbers.length}`,
      pass: new Set(numbers).size === numbers.length && numbers.every((n) => /^LN-\d{6}$/.test(n)),
    });
    const refNos = (await conn.query('SELECT referenceNo FROM financial_transactions WHERE loanId IN (?)', [createdIds]))[0].map((r) => r.referenceNo);
    const refCollisions = (
      await conn.query(
        `SELECT COUNT(*) n FROM financial_transactions WHERE referenceNo IN (?) AND (loanId IS NULL OR loanId NOT IN (?))`,
        [refNos, createdIds],
      )
    )[0][0].n;
    check(CAT, 'เลขอ้างอิง transaction (FT-######) ไม่ชนกับแถวอื่นที่มีอยู่ก่อน', {
      input: `${refNos.length} new reference numbers`,
      expected: 'unique and 0 collisions',
      actual: `${new Set(refNos).size} unique, ${refCollisions} colliding rows`,
      pass: new Set(refNos).size === refNos.length && refNos.every((r) => /^FT-\d{6}$/.test(r)) && refCollisions === 0,
    });

    // ------------------------------------------- disbursedAt round-trip / date abuse
    const rt = await record({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000000, disbursedAt: '2026-06-15T02:00:00.000Z' });
    const rtLoan = rt.json.data.loan;
    const rtRaw = (await conn.query('SELECT CAST(disbursedAt AS CHAR) d FROM loans WHERE id=?', [rtLoan.id]).then((r) => r[0][0].d)) ?? '';
    const rtTxRaw = (await conn.query('SELECT CAST(postedAt AS CHAR) d FROM financial_transactions WHERE id=?', [rt.json.data.disbursementTransaction.id]).then((r) => r[0][0].d)) ?? '';
    check(CAT, 'disbursedAt ที่ส่งไป = ค่าที่เก็บและค่าที่อ่านกลับ (ไม่เลื่อนวัน/เดือน)', {
      input: 'sent 2026-06-15T02:00:00.000Z',
      expected: { api: '2026-06-15T02:00:00.000Z', stored: '2026-06-15 02:00:00' },
      actual: { api: rtLoan.disbursedAt, stored: rtRaw, txStored: rtTxRaw },
      pass: rtLoan.disbursedAt === '2026-06-15T02:00:00.000Z' && rtRaw.startsWith('2026-06-15 02:00:00') && rtTxRaw.startsWith('2026-06-15 02:00:00'),
    });
    const rtMonth = await api('GET', `/api/loans/${rtLoan.id}/schedule`);
    check(CAT, 'งวดแรกนับจากวันออกกู้จริง (2026-06-15 -> due 2026-07-15)', {
      input: 'schedule of the back-dated loan',
      expected: addMonths('2026-06-15', 1),
      actual: dateOnly(rtMonth.json.data.periods[0].dueDate),
      pass: dateOnly(rtMonth.json.data.periods[0].dueDate) === addMonths('2026-06-15', 1),
    });
    const future = await record({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000000, disbursedAt: '2031-01-31T09:00:00.000Z' });
    check(CAT, 'วันที่ออกกู้เป็นอนาคต: ต้องปฏิเสธ (422) มิฉะนั้น ledger จะมีเงินในเดือนที่ยังไม่ถึง', {
      input: 'disbursedAt=2031-01-31',
      expected: 422,
      actual: `HTTP ${future.status} postedAt=${future.json?.data?.disbursementTransaction?.postedAt}`,
      pass: future.status === 422,
      note: 'ระบบรับและโพสต์ transaction ลงเดือน 2031 ทันที รายงานรายเดือนจะนับเงินที่ยังไม่ได้เกิดขึ้นจริง',
    });
    const backdated = await record({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 1000000, disbursedAt: '2015-01-05T09:00:00.000Z' });
    check(CAT, 'วันที่ออกกู้ย้อนหลังไกล (2015) ควรถูกจำกัด (ห้ามลง ledger ก่อนระบบมีข้อมูล)', {
      input: 'disbursedAt=2015-01-05',
      expected: '>=400 (rejected or window-limited)',
      actual: `HTTP ${backdated.status} postedAt=${backdated.json?.data?.disbursementTransaction?.postedAt}`,
      pass: backdated.status >= 400,
    });

    const dup = await record({ customerId: verifiedCustomer, productId: M12.id, principalAmount: 7000000 });
    check(CAT, 'ลูกค้าหนึ่งรายมี loan หลายรายการได้ และเลขไม่ซ้ำกัน', {
      input: 'two loans, same customer/product',
      expected: '201 + distinct loanNumber',
      actual: `HTTP ${dup.status} ${dup.json?.data?.loan?.loanNumber} vs ${rtLoan.loanNumber}`,
      pass: dup.status === 201 && dup.json.data.loan.id !== rtLoan.id && dup.json.data.loan.loanNumber !== rtLoan.loanNumber,
    });

    const grew = await api('GET', '/api/loans?limit=100');
    check(CAT, 'หลังสร้าง loan: list และ aggregate รวมรายการใหม่ด้วย', {
      input: 'GET /api/loans?limit=100',
      expected: `total ${21 + created.length}`,
      actual: `total ${grew.json.pagination.total}, principal ${fmt(toCents(grew.json.aggregates.principalCharged))}`,
      pass: grew.json.pagination.total === 21 + created.length,
    });
    const newDetail = await api('GET', `/api/loans/${dup.json.data.loan.id}`);
    check(CAT, 'อ่าน detail ของ loan ที่สร้างใหม่ได้ทันที (มี transaction เดียวคือ DISBURSEMENT/POSTED)', {
      input: dup.json.data.loan.loanNumber,
      expected: '1 transaction POSTED DISBURSEMENT',
      actual: `${newDetail.json.data.transactions.length} tx ${newDetail.json.data.transactions.map((t) => `${t.transactionType}/${t.status}`).join(',')}`,
      pass:
        newDetail.json.data.transactions.length === 1 &&
        newDetail.json.data.transactions[0].transactionType === 'DISBURSEMENT' &&
        newDetail.json.data.transactions[0].status === 'POSTED',
    });

    // ================================================ G. cleanup + restoration
    await settle();
    await purge();
    const afterCleanup = await api('GET', '/api/loans?limit=100');
    check(CAT, 'ล้างข้อมูลทดสอบแล้ว: จำนวน loan กลับเป็นค่า seed และ aggregates ตรงกับก่อนทดสอบ', {
      input: 'GET /api/loans?limit=100 after purge',
      expected: `total ${expected.rowCounts.loans}, principal ${fmt(toCents(baselineAgg.json.aggregates.principalCharged))}, outstanding ${fmt(toCents(baselineAgg.json.aggregates.outstandingTotal))}`,
      actual: `total ${afterCleanup.json.pagination.total}, principal ${fmt(toCents(afterCleanup.json.aggregates.principalCharged))}, outstanding ${fmt(toCents(afterCleanup.json.aggregates.outstandingTotal))}`,
      pass:
        afterCleanup.json.pagination.total === expected.rowCounts.loans &&
        sameMoney(afterCleanup.json.aggregates.principalCharged, baselineAgg.json.aggregates.principalCharged) &&
        sameMoney(afterCleanup.json.aggregates.outstandingTotal, baselineAgg.json.aggregates.outstandingTotal),
    });
    const gone = await api('GET', `/api/loans/${createdIds[0]}`);
    statusCheck(CAT, 'loan ที่ล้างออกแล้ว: detail 404', gone, 404, { input: createdIds[0] });
    const orphans = (
      await conn.query(
        `SELECT (SELECT COUNT(*) FROM financial_transactions WHERE loanId IN (?)) tx,
                (SELECT COUNT(*) FROM audit_logs WHERE loanId IN (?)) audit,
                (SELECT COUNT(*) FROM notification_outbox WHERE loanId IN (?)) outbox,
                (SELECT COUNT(*) FROM financial_transaction_lines WHERE transactionId IN (SELECT id FROM financial_transactions WHERE loanId IN (?))) lineRows`,
        [createdIds, createdIds, createdIds, createdIds],
      )
    )[0][0];
    check(CAT, 'ล้างแล้วไม่มีแถวค้างในตารางอื่น (no orphan rows)', {
      input: 'counts for created loan ids',
      expected: { tx: 0, audit: 0, outbox: 0, lineRows: 0 },
      actual: orphans,
      pass: orphans.tx === 0 && orphans.audit === 0 && orphans.outbox === 0 && orphans.lineRows === 0,
    });
    const rowCount = (await conn.query('SELECT COUNT(*) n FROM loans').then((r) => r[0][0].n)) ?? 0;
    check(CAT, 'ตาราง loans มีแถว = rowCounts ใน manifest หลัง cleanup', {
      input: 'SELECT COUNT(*) FROM loans',
      expected: expected.rowCounts.loans,
      actual: rowCount,
      pass: rowCount === expected.rowCounts.loans,
    });
  } finally {
    await purge();
  }
}
