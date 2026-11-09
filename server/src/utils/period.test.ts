import { describe, expect, it } from 'vitest';
import { PeriodUnit } from '../entities/types';
import {
  addCalendarMonths,
  decliningPeriodInterest,
  elapsedDays,
  flatInterestTotal,
  periodCount,
  ratePercentPerMonth,
  splitAcross,
  termInMonths,
  termMonthsOf,
} from './period';

const P = 1_000_000;

describe('flatInterestTotal', () => {
  it('reproduces the historic principal x rate% x months/12 for a yearly rate and monthly term', () => {
    expect(flatInterestTotal({ principal: P, ratePercent: 12, rateUnit: PeriodUnit.YEAR, termValue: 12, termUnit: PeriodUnit.MONTH })).toBe(120_000);
    expect(flatInterestTotal({ principal: P, ratePercent: 18, rateUnit: PeriodUnit.YEAR, termValue: 24, termUnit: PeriodUnit.MONTH })).toBe(360_000);
  });

  it('treats 1% per month over 12 months as the same money as 12% per year', () => {
    expect(flatInterestTotal({ principal: P, ratePercent: 1, rateUnit: PeriodUnit.MONTH, termValue: 12, termUnit: PeriodUnit.MONTH })).toBe(
      flatInterestTotal({ principal: P, ratePercent: 12, rateUnit: PeriodUnit.YEAR, termValue: 12, termUnit: PeriodUnit.MONTH }),
    );
  });

  it('converts days and weeks through the 30-day month convention', () => {
    expect(flatInterestTotal({ principal: P, ratePercent: 0.05, rateUnit: PeriodUnit.DAY, termValue: 90, termUnit: PeriodUnit.DAY })).toBe(45_000);
    expect(flatInterestTotal({ principal: P, ratePercent: 1, rateUnit: PeriodUnit.WEEK, termValue: 2, termUnit: PeriodUnit.WEEK })).toBe(20_000);
  });

  it('charges one whole period even when the term rounds below a month', () => {
    expect(periodCount(1, PeriodUnit.WEEK)).toBe(1);
    expect(termMonthsOf(1, PeriodUnit.WEEK)).toBe(1);
  });
});

describe('decliningPeriodInterest', () => {
  it('prices one period on the principal still owed, not on the original loan', () => {
    expect(decliningPeriodInterest(10_000_000, 1.2, PeriodUnit.MONTH)).toBe(120_000);
    // After one installment of equal principal the next period is cheaper.
    expect(decliningPeriodInterest(10_000_000 - 416_666.67, 1.2, PeriodUnit.MONTH)).toBe(115_000);
  });

  it('converts a yearly rate onto the monthly period through the same convention as flat interest', () => {
    expect(decliningPeriodInterest(P, 18, PeriodUnit.YEAR)).toBe(15_000);
    expect(decliningPeriodInterest(P, 1.5, PeriodUnit.MONTH)).toBe(15_000);
  });

  it('charges nothing once the principal is gone', () => {
    expect(decliningPeriodInterest(0, 1.2, PeriodUnit.MONTH)).toBe(0);
    expect(decliningPeriodInterest(-5, 1.2, PeriodUnit.MONTH)).toBe(0);
  });
});

describe('unit conversions', () => {
  it('maps every unit onto the month timeline', () => {
    expect(termInMonths(1, PeriodUnit.YEAR)).toBe(12);
    expect(termInMonths(1, PeriodUnit.MONTH)).toBe(1);
    expect(ratePercentPerMonth(12, PeriodUnit.YEAR)).toBe(1);
    expect(ratePercentPerMonth(1, PeriodUnit.MONTH)).toBe(1);
  });
});

describe('splitAcross', () => {
  it('splits evenly and lets the last share absorb the remainder', () => {
    expect(splitAcross(100, 3)).toEqual([33.33, 33.33, 33.34]);
  });

  it('always adds back up to the booked total', () => {
    for (const count of [1, 2, 3, 7, 12, 24]) {
      const shares = splitAcross(5_000_000.37, count);
      expect(shares).toHaveLength(count);
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(5_000_000.37, 2);
    }
  });
});

describe('calendar helpers', () => {
  it('clamps month-end dates', () => {
    expect(addCalendarMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
    expect(addCalendarMonths(new Date(Date.UTC(2026, 0, 15)), 12).toISOString().slice(0, 10)).toBe('2027-01-15');
  });

  it('counts whole days and never goes negative', () => {
    expect(elapsedDays(new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 2, 1)))).toBe(59);
    expect(elapsedDays(new Date(Date.UTC(2026, 0, 5)), new Date(Date.UTC(2026, 0, 1)))).toBe(0);
  });
});
