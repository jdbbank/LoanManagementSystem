import { PeriodUnit } from '../entities/types';
import { round2 } from './money';

/**
 * Time conventions for the whole system: 1 year = 12 months, 1 month = 30 days, 1 week = 7 days.
 * Every rate/term/penalty unit conversion goes through these two maps so there is one answer to
 * "how long is a month" — mixed units (e.g. %/month over a 90-day term) are otherwise ambiguous.
 */
export const MONTHS_PER_UNIT: Record<PeriodUnit, number> = {
  [PeriodUnit.DAY]: 1 / 30,
  [PeriodUnit.WEEK]: 7 / 30,
  [PeriodUnit.MONTH]: 1,
  [PeriodUnit.YEAR]: 12,
};

export const DAYS_PER_UNIT: Record<PeriodUnit, number> = {
  [PeriodUnit.DAY]: 1,
  [PeriodUnit.WEEK]: 7,
  [PeriodUnit.MONTH]: 30,
  [PeriodUnit.YEAR]: 365,
};

export const termInMonths = (termValue: number, termUnit: PeriodUnit): number =>
  termValue * MONTHS_PER_UNIT[termUnit];

/** Whole monthly repayment periods for a term — always at least one. */
export const periodCount = (termValue: number, termUnit: PeriodUnit): number =>
  Math.max(1, Math.round(termInMonths(termValue, termUnit)));

/** Product term in whole months, the canonical figure stored on loans/products. */
export const termMonthsOf = (termValue: number, termUnit: PeriodUnit): number =>
  Math.max(1, Math.round(termInMonths(termValue, termUnit)));

export const ratePercentPerMonth = (ratePercent: number, rateUnit: PeriodUnit): number =>
  ratePercent / MONTHS_PER_UNIT[rateUnit];

/**
 * Flat interest over the whole term. With rateUnit=YEAR and a monthly term this is
 * exactly the historic `principal × rate% × months/12`, so existing products are unchanged.
 */
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

/**
 * One repayment period of declining-balance interest: the principal still owed when the period
 * starts, times the monthly rate. Never prorated by day — a mid-period prepayment re-prices the
 * NEXT period only, which keeps the locked 1 month = 30 days convention free of day-level state.
 */
export function decliningPeriodInterest(
  outstandingPrincipal: number,
  ratePercent: number,
  rateUnit: PeriodUnit,
): number {
  const base = round2(outstandingPrincipal);
  if (base <= 0) return 0;
  return round2(base * (ratePercentPerMonth(ratePercent, rateUnit) / 100));
}

/**
 * Split an amount into `count` equal shares; the last share absorbs the rounding remainder
 * so the shares always add back up to the booked amount.
 */
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

const DAY_MS = 86_400_000;

/** Calendar month arithmetic, clamped to the last day of the target month (31 Jan + 1m = 28 Feb). */
export function addCalendarMonths(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const target = new Date(from.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target;
}

/** Key used to group a schedule row by calendar month (UTC, `YYYY-MM`). */
export const monthKey = (date: Date): string => date.toISOString().slice(0, 7);

export const elapsedDays = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
