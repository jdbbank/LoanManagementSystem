// Sanity check of the yardstick itself: every case below is a worked example copied out of
// loan_management_locked_requirements.md, not output produced by the server.
import assert from 'node:assert/strict';
import {
  allocateComponents,
  billedInterestCents,
  buildSchedule,
  emptyComponents,
  fmt,
  newLoanState,
  postEvent,
  reverseAllocation,
  toCents,
  totalOf,
  growth,
  accruedPenaltyCents,
} from './oracle.mjs';

const checks = [];
const ok = (name, fn) => {
  fn();
  checks.push(name);
};

ok('S5 partial payment walks penalty -> interest, stops before principal', () => {
  const r = allocateComponents(toCents(150000), {
    PENALTY: toCents(100000),
    PAST_INTEREST: toCents(800000),
    PAST_PRINCIPAL: toCents(1000000),
  });
  assert.equal(fmt(r.allocation.PENALTY), '100000.00');
  assert.equal(fmt(r.allocation.PAST_INTEREST), '50000.00');
  assert.equal(r.allocation.PAST_PRINCIPAL, 0);
  assert.equal(r.overpaymentCents, 0);
});

ok('S6 overpayment becomes credit, never early principal', () => {
  const state = newLoanState('L1', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(100000) }, toCents(100000));
  const r = postEvent(state, { type: 'PAYMENT', amountCents: toCents(102000), postedAtIso: '2026-01-15' });
  assert.equal(fmt(r.allocation.PAST_PRINCIPAL), '100000.00');
  assert.equal(fmt(r.creditAccruedCents), '2000.00');
  assert.equal(totalOf(state.components), 0);
  assert.equal(state.status, 'CLOSED');
});

ok('S10 partial reversal follows the original allocation order', () => {
  const r = reverseAllocation(
    { PENALTY: toCents(300000), PAST_INTEREST: toCents(200000), PAST_PRINCIPAL: toCents(200000) },
    toCents(100000),
  );
  assert.equal(fmt(r.reversed.PENALTY), '100000.00');
  assert.equal(r.reversed.PAST_INTEREST, 0);
  const deep = reverseAllocation(
    { PENALTY: toCents(300000), PAST_INTEREST: toCents(200000), PAST_PRINCIPAL: toCents(200000) },
    toCents(450000),
  );
  assert.equal(fmt(deep.reversed.PAST_INTEREST), '150000.00');
});

ok('S14+S15 closed loan reopens when a posted reversal creates outstanding', () => {
  const state = newLoanState('L2', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(500000) }, toCents(500000));
  postEvent(state, { type: 'PAYMENT', amountCents: toCents(500000), postedAtIso: '2026-02-01' });
  assert.equal(state.status, 'CLOSED');
  postEvent(state, {
    type: 'PAYMENT_REVERSAL',
    amountCents: toCents(200000),
    originalAllocation: { ...emptyComponents(), PAST_PRINCIPAL: toCents(500000) },
    postedAtIso: '2026-03-01',
  });
  assert.equal(state.status, 'ACTIVE');
  assert.equal(fmt(totalOf(state.components)), '200000.00');
});

ok('S18 write-off reversal that creates outstanding reopens the loan', () => {
  const state = newLoanState('L3', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(900000) }, toCents(900000));
  postEvent(state, { type: 'WRITE_OFF', amountCents: toCents(900000), postedAtIso: '2026-04-01' });
  assert.equal(state.status, 'WRITTEN_OFF');
  postEvent(state, {
    type: 'WRITE_OFF_REVERSAL',
    amountCents: toCents(900000),
    components: { ...emptyComponents(), PAST_PRINCIPAL: toCents(900000) },
    postedAtIso: '2026-05-01',
  });
  assert.equal(state.status, 'ACTIVE');
  assert.equal(fmt(totalOf(state.components)), '900000.00');
});

ok('S18 write-off reversal leaving zero outstanding keeps WRITTEN_OFF', () => {
  const state = newLoanState('L3b', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(900000) }, toCents(900000));
  postEvent(state, { type: 'WRITE_OFF', amountCents: toCents(900000), postedAtIso: '2026-04-01' });
  postEvent(state, { type: 'WRITE_OFF_REVERSAL', amountCents: 0, components: emptyComponents(), postedAtIso: '2026-05-01' });
  assert.equal(state.status, 'WRITTEN_OFF');
  assert.equal(totalOf(state.components), 0);
});

ok('S11 partial write-off reversal restores the original write-off order, not pro-rata', () => {
  const state = newLoanState('L3c', 'C1', { PENALTY: toCents(50000), PAST_INTEREST: toCents(102000), PAST_PRINCIPAL: toCents(98000) }, toCents(500000));
  postEvent(state, { type: 'WRITE_OFF', amountCents: toCents(250000), postedAtIso: '2026-04-01' });
  assert.equal(state.status, 'WRITTEN_OFF');
  const back = postEvent(state, {
    type: 'WRITE_OFF_REVERSAL',
    amountCents: toCents(120000),
    originalAllocation: { PENALTY: toCents(50000), PAST_INTEREST: toCents(102000), PAST_PRINCIPAL: toCents(98000) },
    postedAtIso: '2026-05-01',
  });
  assert.equal(fmt(back.allocation.PENALTY), '50000.00');
  assert.equal(fmt(back.allocation.PAST_INTEREST), '70000.00');
  assert.equal(fmt(back.allocation.PAST_PRINCIPAL), '0.00');
  assert.equal(fmt(totalOf(state.components)), '120000.00');
});

ok('S18 partial write-off leaves the loan ACTIVE (only a full write-off is WRITTEN_OFF)', () => {
  const state = newLoanState('L3a', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(900000) }, toCents(900000));
  postEvent(state, {
    type: 'WRITE_OFF',
    amountCents: toCents(400000),
    components: { ...emptyComponents(), PAST_PRINCIPAL: toCents(400000) },
    postedAtIso: '2026-04-01',
  });
  assert.equal(state.status, 'ACTIVE');
  assert.equal(fmt(totalOf(state.components)), '500000.00');
});

ok('S17 waiver reduces outstanding without touching the original penalty', () => {
  const state = newLoanState('L4', 'C1', emptyComponents(), toCents(1000000));
  postEvent(state, { type: 'PENALTY', amountCents: toCents(100000), postedAtIso: '2026-06-01' });
  postEvent(state, {
    type: 'WAIVER',
    amountCents: toCents(30000),
    components: { PENALTY: toCents(30000) },
    postedAtIso: '2026-06-02',
  });
  assert.equal(fmt(state.components.PENALTY), '70000.00');
  assert.equal(state.history[0].allocation.PENALTY, 0);
});

ok('S17 relief of more than what is outstanding is refused (waiver and write-off)', () => {
  const state = newLoanState(
    'L4b',
    'C1',
    { ...emptyComponents(), PAST_PRINCIPAL: toCents(1000000) },
    toCents(1000000),
  );
  postEvent(state, { type: 'PENALTY', amountCents: toCents(100000), postedAtIso: '2026-06-01' });
  postEvent(state, { type: 'PAYMENT', amountCents: toCents(100000), postedAtIso: '2026-06-05' });
  assert.equal(state.components.PENALTY, 0);
  assert.throws(
    () => postEvent(state, { type: 'WAIVER', amountCents: toCents(240000), components: { PENALTY: toCents(240000) }, postedAtIso: '2026-06-06' }),
    /exceeds outstanding/,
  );
  assert.throws(
    () =>
      postEvent(state, {
        type: 'WRITE_OFF',
        amountCents: toCents(2000000),
        components: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: toCents(2000000) },
        postedAtIso: '2026-06-07',
      }),
    /exceeds outstanding/,
  );
  assert.equal(fmt(totalOf(state.components)), '1000000.00');
});

ok('S2 settlement payment settles only what was paid, shortfall survives', () => {
  const state = newLoanState('L5', 'C1', { ...emptyComponents(), PAST_PRINCIPAL: toCents(1000000) }, toCents(1000000));
  postEvent(state, { type: 'SETTLEMENT_PAYMENT', amountCents: toCents(700000), postedAtIso: '2026-07-01' });
  assert.equal(fmt(totalOf(state.components)), '300000.00');
  assert.equal(state.status, 'ACTIVE');
});

ok('Interest is flat, billed once, in the unit the product declares', () => {
  assert.equal(
    fmt(billedInterestCents({ principalCents: toCents(1000000), ratePercent: 1.5, rateUnit: 'MONTH', termValue: 12, termUnit: 'MONTH' })),
    '180000.00',
  );
  assert.equal(
    fmt(billedInterestCents({ principalCents: toCents(1000000), ratePercent: 18, rateUnit: 'YEAR', termValue: 1, termUnit: 'YEAR' })),
    '180000.00',
  );
});

ok('Installments sum back to the exact principal and interest', () => {
  const periods = buildSchedule({
    startIso: '2025-10-31',
    principalCents: toCents(1000000),
    interestCents: toCents(180000),
    termValue: 7,
    termUnit: 'MONTH',
  });
  assert.equal(periods.length, 7);
  assert.equal(periods.reduce((s, p) => s + p.principalCents, 0), toCents(1000000));
  assert.equal(periods.reduce((s, p) => s + p.interestCents, 0), toCents(180000));
  assert.equal(periods[0].dueDate, '2025-11-30');
  assert.equal(periods[1].dueDate, '2025-12-31');
  assert.equal(periods[2].dueDate, '2026-01-31');
  assert.equal(periods[3].dueDate, '2026-02-28');
});

ok('Leap-year February clamp differs from a 30-day month count', () => {
  const periods = buildSchedule({
    startIso: '2028-01-31',
    principalCents: toCents(120000),
    interestCents: 0,
    termValue: 3,
    termUnit: 'MONTH',
  });
  assert.equal(periods[0].dueDate, '2028-02-29');
  assert.equal(periods[1].dueDate, '2028-03-31');
});

ok('Penalty modes and grace days', () => {
  const base = toCents(1000000);
  assert.equal(
    accruedPenaltyCents({
      overdueBaseCents: base,
      principalCents: base,
      asOfIso: '2026-03-01',
      firstOverdueIso: '2026-01-01',
      policy: { mode: 'PERCENT_OF_OVERDUE', ratePercent: 2, period: 'MONTH', graceDays: 0 },
    }),
    toCents(40000),
  );
  assert.equal(
    accruedPenaltyCents({
      overdueBaseCents: base,
      principalCents: base,
      asOfIso: '2026-03-01',
      firstOverdueIso: '2026-01-01',
      policy: { mode: 'FIXED_PER_PERIOD', amount: 5000, period: 'MONTH', graceDays: 60 },
    }),
    0,
  );
  assert.equal(
    accruedPenaltyCents({
      overdueBaseCents: base,
      principalCents: base,
      asOfIso: '2026-03-01',
      firstOverdueIso: '2026-01-01',
      policy: { mode: 'FIXED_PER_PERIOD', amount: 5000, period: 'MONTH', graceDays: 45 },
    }),
    toCents(5000),
  );
  assert.equal(
    accruedPenaltyCents({
      overdueBaseCents: base,
      principalCents: base,
      asOfIso: '2026-03-01',
      firstOverdueIso: '2026-01-01',
      policy: { mode: 'PERCENT_OF_OVERDUE', ratePercent: 20, period: 'MONTH', graceDays: 0, maxPercentOfPrincipal: 3 },
    }),
    toCents(30000),
  );
});

ok('MoM growth never divides by zero', () => {
  assert.deepEqual(growth(toCents(100), 0), { absolute: toCents(100), percent: null });
  assert.equal(growth(toCents(150), toCents(100)).percent, 50);
  assert.equal(growth(toCents(50), toCents(100)).percent, -50);
});

console.log(`oracle-selftest: ${checks.length} yardstick checks passed`);
for (const c of checks) console.log(`  PASS  ${c}`);
