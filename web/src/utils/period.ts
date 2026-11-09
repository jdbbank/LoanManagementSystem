import { PeriodUnit } from '../api/types';

/**
 * Display-side mirror of `server/src/utils/period.ts` (1 year = 12 months, 1 month = 30 days,
 * 1 week = 7 days). The server stays the source of truth for postings; these helpers only power
 * previews and labels, so they must be kept in sync with the server copy.
 */
export const MONTHS_PER_UNIT: Record<PeriodUnit, number> = {
  [PeriodUnit.DAY]: 1 / 30,
  [PeriodUnit.WEEK]: 7 / 30,
  [PeriodUnit.MONTH]: 1,
  [PeriodUnit.YEAR]: 12,
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const termInMonths = (termValue: number, termUnit: PeriodUnit): number =>
  termValue * MONTHS_PER_UNIT[termUnit];

export const ratePercentPerMonth = (ratePercent: number, rateUnit: PeriodUnit): number =>
  ratePercent / MONTHS_PER_UNIT[rateUnit];

export function flatInterestTotal(input: {
  principal: number;
  ratePercent: number;
  rateUnit: PeriodUnit;
  termValue: number;
  termUnit: PeriodUnit;
}): number {
  const months = termInMonths(input.termValue, input.termUnit);
  return round2(input.principal * (ratePercentPerMonth(input.ratePercent, input.rateUnit) / 100) * months);
}

/** Whole monthly periods the term is billed over — the same count the server uses. */
export const periodCount = (termValue: number, termUnit: PeriodUnit): number =>
  Math.max(1, Math.round(termInMonths(termValue, termUnit)));

/** One period's interest on the principal still outstanding. */
export const decliningPeriodInterest = (
  outstandingPrincipal: number,
  ratePercent: number,
  rateUnit: PeriodUnit,
): number => {
  const base = round2(outstandingPrincipal);
  if (base <= 0) return 0;
  return round2(base * (ratePercentPerMonth(ratePercent, rateUnit) / 100));
};

/** Split into equal shares; the last one absorbs the rounding remainder. */
export function splitAcross(total: number, count: number): number[] {
  const safeCount = Math.max(1, Math.round(count));
  if (safeCount === 1) return [round2(total)];
  const share = round2(total / safeCount);
  const shares: number[] = [];
  let allocated = 0;
  for (let i = 0; i < safeCount; i += 1) {
    const last = i === safeCount - 1;
    const value = last ? round2(total - allocated) : share;
    shares.push(value);
    allocated = round2(allocated + value);
  }
  return shares;
}

/**
 * What a declining-balance loan costs: equal principal shares, each period priced on the balance
 * it starts with. Only the first period is booked at disbursement — the rest become one
 * INTEREST_ACCRUAL charge per period.
 */
export function decliningInterestPreview(input: {
  principal: number;
  ratePercent: number;
  rateUnit: PeriodUnit;
  termValue: number;
  termUnit: PeriodUnit;
}): { total: number; firstPeriod: number; periods: number } {
  const periods = periodCount(input.termValue, input.termUnit);
  const shares = splitAcross(input.principal, periods);
  let balance = round2(input.principal);
  let total = 0;
  let firstPeriod = 0;
  shares.forEach((share, index) => {
    const interest = decliningPeriodInterest(balance, input.ratePercent, input.rateUnit);
    if (index === 0) firstPeriod = interest;
    total = round2(total + interest);
    balance = round2(balance - share);
  });
  return { total, firstPeriod, periods };
}
