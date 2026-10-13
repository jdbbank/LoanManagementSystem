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
