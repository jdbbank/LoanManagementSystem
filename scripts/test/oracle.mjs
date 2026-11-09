// Independent financial oracle for the pre-production test run.
// Deliberately does NOT import anything from server/src: the numbers below come from
// loan_management_locked_requirements.md so a wrong implementation is caught, not copied.
// All arithmetic runs on integer cents (1 LAK = 100 cents) to avoid float drift.

export const EPS_LAK = 0.005;

export const COMPONENTS = ['PENALTY', 'PAST_INTEREST', 'PAST_PRINCIPAL'];

export const toCents = (amount) => Math.round(Number(amount) * 100);
export const toLak = (cents) => Math.round(cents) / 100;
export const fmt = (cents) => (Math.round(cents) / 100).toFixed(2);

/** Half-up rounding to whole cents, symmetric for negative amounts. */
export const roundCents = (v) => Math.sign(v) * Math.floor(Math.abs(v) + 0.5);

export const MONTHS_PER_UNIT = { DAY: 1 / 30, WEEK: 7 / 30, MONTH: 1, YEAR: 12 };
export const DAYS_PER_UNIT = { DAY: 1, WEEK: 7, MONTH: 30, YEAR: 365 };

export const termInMonths = (termValue, termUnit) => termValue * MONTHS_PER_UNIT[termUnit];

export const addDays = (dateIso, days) => {
  const d = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (fromIso, toIso) =>
  Math.round(
    (Date.parse(`${toIso.slice(0, 10)}T00:00:00Z`) - Date.parse(`${fromIso.slice(0, 10)}T00:00:00Z`)) / 86400000,
  );

/** Calendar-true month addition with end-of-month clamp (31 Jan + 1 month = 28 Feb). */
export const addMonths = (dateIso, months) => {
  const base = new Date(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(base.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
};

export const monthKey = (dateIso) => dateIso.slice(0, 7);
export const monthKeys = (fromIso, toIso) => {
  const out = [];
  let cur = monthKey(fromIso);
  const last = monthKey(toIso);
  let guard = 0;
  while (cur <= last && guard++ < 600) {
    out.push(cur);
    cur = addMonths(`${cur}-01`, 1).slice(0, 7);
  }
  return out;
};

/** FLAT interest: the whole term billed in one lump at disbursement (historic behaviour, still the default). */
export function billedInterestCents({ principalCents, ratePercent, rateUnit, termValue, termUnit }) {
  const ratePerMonth = ratePercent / MONTHS_PER_UNIT[rateUnit];
  const months = termInMonths(termValue, termUnit);
  return roundCents((principalCents * ratePerMonth * months) / 100);
}

/**
 * DECLINING interest: one period charged on the principal still owed when that period starts,
 * never on the original amount and never prorated by day. ratePercent is read per `rateUnit`
 * through the locked month convention (1 month = 30 days), so the whole term is one charge per period.
 */
export function decliningPeriodInterestCents({ outstandingPrincipalCents, ratePercent, rateUnit }) {
  if (outstandingPrincipalCents <= 0) return 0;
  const ratePerMonth = ratePercent / MONTHS_PER_UNIT[rateUnit];
  return roundCents((outstandingPrincipalCents * ratePerMonth) / 100);
}

/**
 * DECLINING installments when the borrower settles every period on time: equal principal shares,
 * each carrying interest on the balance that share leaves behind, so the installment falls as the
 * loan ages. Interest is charged before principal, so paying the installment removes exactly one
 * principal share from the balance.
 */
export function decliningPeriods({ principalCents, ratePercent, rateUnit, termValue, termUnit, startIso }) {
  const count = periodCount(termValue, termUnit);
  const perPrincipal = Math.floor(principalCents / count);
  const periods = [];
  let balance = principalCents;
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    const principalShareCents = last ? balance : perPrincipal;
    const interestCents = decliningPeriodInterestCents({ outstandingPrincipalCents: balance, ratePercent, rateUnit });
    periods.push({
      index: i + 1,
      dueDate: addMonths(startIso, i + 1),
      openingBalanceCents: balance,
      principalCents: principalShareCents,
      interestCents,
      installmentCents: principalShareCents + interestCents,
    });
    balance -= principalShareCents;
  }
  return periods;
}

export function periodCount(termValue, termUnit) {
  return Math.max(1, Math.round(termInMonths(termValue, termUnit)));
}

/**
 * Early-settlement fee in cents: the loan's own frozen percent applied to the principal still owed,
 * charged only while an instalment has not come due yet (requirements: ค่าปรับปิดหนี้ก่อนครบสัญญา).
 * A loan running to term end, or a product with 0%, pays nothing.
 */
export function earlySettlementFeeCents({ principalOutstandingCents, feePercent, settledBeforeTermEnd }) {
  if (!settledBeforeTermEnd || !(Number(feePercent) > 0)) return 0;
  return roundCents((Math.max(0, principalOutstandingCents) * Number(feePercent)) / 100);
}

/**
 * Derived installment view for a FLAT loan: principal and the billed lump spread equally over the
 * term, the rounding remainder always landing on the final period so the parts sum exactly.
 * DECLINING loans do not use this — their interest sits on the period that billed it.
 */
export function buildSchedule({ startIso, principalCents, interestCents, termValue, termUnit }) {
  const count = periodCount(termValue, termUnit);
  const perPrincipal = Math.floor(principalCents / count);
  const perInterest = Math.floor(interestCents / count);
  const periods = [];
  for (let i = 0; i < count; i++) {
    const last = i === count - 1;
    periods.push({
      index: i + 1,
      dueDate: addMonths(startIso, i + 1),
      principalCents: last ? principalCents - perPrincipal * (count - 1) : perPrincipal,
      interestCents: last ? interestCents - perInterest * (count - 1) : perInterest,
    });
  }
  return periods;
}

export const emptyComponents = () => ({ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 });
export const totalOf = (c) => c.PENALTY + c.PAST_INTEREST + c.PAST_PRINCIPAL;

/** Locked allocation order: penalty first, then past interest, then past principal. */
export function allocateComponents(amountCents, outstanding) {
  let left = amountCents;
  const allocation = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
  for (const c of COMPONENTS) {
    const take = Math.max(0, Math.min(left, outstanding[c] ?? 0));
    allocation[c] = take;
    left -= take;
  }
  return { allocation, overpaymentCents: Math.max(0, left) };
}

/** Partial reversal walks the original allocation in the same order, never pro-rata. */
export function reverseAllocation(originalAllocation, amountCents) {
  let left = amountCents;
  const reversed = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
  for (const c of COMPONENTS) {
    const take = Math.max(0, Math.min(left, originalAllocation[c] ?? 0));
    reversed[c] = take;
    left -= take;
  }
  return { reversed, unfollowableCents: Math.max(0, left) };
}

export const DEFAULT_PENALTY_POLICY = {
  mode: 'NONE',
  ratePercent: 0,
  amount: 0,
  period: 'MONTH',
  graceDays: 0,
  maxPercentOfPrincipal: 0,
};

/**
 * Penalty owed as of `asOfIso` for one overdue period base.
 * PERCENT_OF_OVERDUE = rate% per period, FIXED_PER_PERIOD = flat amount per period,
 * both after graceDays and capped by maxPercentOfPrincipal of the loan principal.
 */
export function accruedPenaltyCents({ overdueBaseCents, principalCents, asOfIso, firstOverdueIso, policy }) {
  const p = { ...DEFAULT_PENALTY_POLICY, ...policy };
  if (p.mode === 'NONE') return 0;
  const late = daysBetween(firstOverdueIso, asOfIso);
  if (late <= 0) return 0;
  const effective = Math.max(0, late - p.graceDays);
  if (effective === 0) return 0;
  const periods = Math.ceil(effective / DAYS_PER_UNIT[p.period]);
  const per =
    p.mode === 'FIXED_PER_PERIOD' ? toCents(p.amount) : roundCents((overdueBaseCents * p.ratePercent) / 100);
  const raw = per * periods;
  if (!p.maxPercentOfPrincipal) return raw;
  return Math.min(raw, roundCents((principalCents * p.maxPercentOfPrincipal) / 100));
}

/** Financial truth of one loan, mutated only by posted events. */
export function newLoanState(id, customerId, components, principalCents) {
  return { id, customerId, principalCents, components: { ...components }, status: 'ACTIVE', history: [] };
}

const applyDelta = (state, delta) => {
  for (const c of COMPONENTS) state.components[c] -= delta[c] ?? 0;
};
const restoreDelta = (state, delta) => {
  for (const c of COMPONENTS) state.components[c] += delta[c] ?? 0;
};

/**
 * Relief can never push a component below zero — the same hard rule the posting engine applies
 * (waiver / write-off of more than what is outstanding is refused with 422).
 */
function assertReliefFits(state, target, label) {
  for (const c of COMPONENTS) {
    const value = target[c] ?? 0;
    if (value < 0 || value > state.components[c]) {
      throw new Error(
        `oracle: ${label} of ${c} ${fmt(value)} exceeds outstanding ${fmt(state.components[c])} on loan ${state.id}`,
      );
    }
  }
}

/**
 * Loan status after a posted event. Mirrors the locked rule (requirements section 18):
 * WRITE_OFF only reaches WRITTEN_OFF when every component is zero — a partial write-off
 * leaves the loan ACTIVE; a write-off reversal with nothing left restores WRITTEN_OFF.
 */
export function statusAfterPost(state, type) {
  const outstanding = totalOf(state.components);
  if (type === 'WRITE_OFF') return outstanding === 0 ? 'WRITTEN_OFF' : 'ACTIVE';
  if (type === 'WRITE_OFF_REVERSAL') return outstanding > 0 ? 'ACTIVE' : 'WRITTEN_OFF';
  if (outstanding === 0) return state.status === 'WRITTEN_OFF' ? 'WRITTEN_OFF' : 'CLOSED';
  return 'ACTIVE';
}

/**
 * Applies one posted event to the loan state and returns what the system must have done.
 * `amountCents` is the transaction amount, `creditAppliedCents` only for payments.
 */
export function postEvent(state, event) {
  const { type, amountCents = 0, components = null, creditAppliedCents = 0 } = event;
  const before = totalOf(state.components);
  const result = {
    type,
    beforeCents: before,
    allocation: { ...emptyComponents() },
    creditAccruedCents: 0,
    creditUsedCents: creditAppliedCents,
    afterCents: before,
    statusBefore: state.status,
    statusAfter: state.status,
  };

  switch (type) {
    case 'DISBURSEMENT': {
      state.components.PAST_PRINCIPAL += amountCents;
      state.components.PAST_INTEREST += event.interestCents ?? 0;
      break;
    }
    case 'PAYMENT':
    case 'SETTLEMENT_PAYMENT': {
      const paidTotal = amountCents + creditAppliedCents;
      const { allocation, overpaymentCents } = allocateComponents(paidTotal, state.components);
      result.allocation = allocation;
      result.creditAccruedCents = overpaymentCents;
      applyDelta(state, allocation);
      break;
    }
    case 'PAYMENT_REVERSAL': {
      const source = event.originalAllocation ?? event.components;
      const { reversed } = reverseAllocation(source, amountCents);
      result.allocation = reversed;
      restoreDelta(state, reversed);
      break;
    }
    case 'PENALTY': {
      state.components.PENALTY += amountCents;
      break;
    }
    case 'INTEREST_ACCRUAL': {
      // One declining-balance period. Interest on money nobody owes would reopen a settled loan,
      // so the charge only ever lands on a live one — the same rule the posting engine applies.
      if (amountCents <= 0) throw new Error('oracle: interest accrual must be a positive charge');
      if (state.status !== 'ACTIVE') throw new Error(`oracle: cannot accrue interest on a ${state.status} loan`);
      state.components.PAST_INTEREST += amountCents;
      break;
    }
    case 'WAIVER': {
      const target = components ?? { PENALTY: amountCents };
      assertReliefFits(state, target, 'waiver');
      applyDelta(state, target);
      result.allocation = target;
      break;
    }
    case 'WRITE_OFF': {
      const target = components ?? { ...state.components };
      assertReliefFits(state, target, 'write-off');
      applyDelta(state, target);
      result.allocation = target;
      break;
    }
    case 'WRITE_OFF_REVERSAL': {
      // Same locked rule as payment reversals: a partial reversal restores the original
      // write-off composition in order (penalty, interest, principal), never pro-rata.
      const source = event.originalAllocation ?? event.components;
      const target = event.originalAllocation ? reverseAllocation(source, amountCents).reversed : { ...emptyComponents(), ...source };
      restoreDelta(state, target);
      result.allocation = target;
      break;
    }
    case 'ADJUSTMENT': {
      // Adjustment carries signed component deltas (locked section 11): positive adds to
      // outstanding, negative corrects it down. No component may go below zero.
      const target = components ?? { ...emptyComponents() };
      for (const c of COMPONENTS) {
        if (state.components[c] + (target[c] ?? 0) < 0) {
          throw new Error(`oracle: adjustment would make ${c} negative on loan ${state.id}`);
        }
      }
      restoreDelta(state, target);
      result.allocation = target;
      break;
    }
    default:
      throw new Error(`oracle: unknown transaction type ${type}`);
    }

  result.afterCents = totalOf(state.components);
  state.status = statusAfterPost(state, type);
  result.statusAfter = state.status;
  state.history.push({ ...result, at: event.postedAtIso });
  return result;
}

/** Monthly report aggregates over POSTED transactions only. */
export function monthlyAggregates(postedTransactions, months) {
  const rows = Object.fromEntries(
    months.map((m) => [m, { disbursed: 0, collected: 0, interestPaid: 0, penaltyPaid: 0, principalPaid: 0, transactions: 0 }]),
  );
  for (const tx of postedTransactions) {
    const m = monthKey(tx.postedAtIso);
    const bucket = rows[m];
    if (!bucket) continue;
    bucket.transactions += 1;
    if (tx.transactionType === 'DISBURSEMENT') bucket.disbursed += tx.amountCents;
    if (tx.transactionType === 'PAYMENT' || tx.transactionType === 'SETTLEMENT_PAYMENT') {
      bucket.collected += tx.amountCents + (tx.creditAppliedCents ?? 0);
      bucket.interestPaid += tx.allocation?.PAST_INTEREST ?? 0;
      bucket.penaltyPaid += tx.allocation?.PENALTY ?? 0;
      bucket.principalPaid += tx.allocation?.PAST_PRINCIPAL ?? 0;
    }
  }
  return rows;
}

/** MoM/YoY: previous period of zero gives no percent (never divides by zero). */
export function growth(currentCents, previousCents) {
  const absolute = currentCents - previousCents;
  if (!previousCents) return { absolute, percent: null };
  return { absolute, percent: roundCents((absolute / Math.abs(previousCents)) * 10000) / 100 };
}

/** Cross-check: outstanding built from the ledger must equal the sum of loan books. */
export function ledgerVsLoanBook(states, loans) {
  const fromLedger = Object.values(states).reduce((sum, s) => sum + totalOf(s.components), 0);
  const fromLoanBook = loans.reduce((sum, l) => sum + toCents(l.currentOutstanding), 0);
  return { fromLedger, fromLoanBook, matched: fromLedger === fromLoanBook };
}

export const approxZero = (a, b) => Math.abs(Number(a) - Number(b)) < EPS_LAK;
