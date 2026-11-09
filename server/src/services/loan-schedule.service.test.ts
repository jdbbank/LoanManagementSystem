import { describe, expect, it } from 'vitest';
import { DEFAULT_PENALTY_POLICY, PenaltyMode, PeriodUnit, SchedulePeriodStatus, type PenaltyPolicy } from '../entities/types';
import {
  capAccruedPenalties,
  isPeriodArrived,
  penaltyForPeriod,
  periodStatus,
  placeInterestOnPeriods,
  spreadBilledPenalty,
  type LoanSchedulePeriod,
} from './loan-schedule.service';

const percent = (ratePercent: number, period = PeriodUnit.MONTH, graceDays = 0, cap = 0): PenaltyPolicy => ({
  ...DEFAULT_PENALTY_POLICY,
  mode: PenaltyMode.PERCENT_OF_OVERDUE,
  ratePercent,
  period,
  graceDays,
  maxPercentOfPrincipal: cap,
});

const fixed = (amount: number, period = PeriodUnit.MONTH): PenaltyPolicy => ({
  ...DEFAULT_PENALTY_POLICY,
  mode: PenaltyMode.FIXED_PER_PERIOD,
  amount,
  period,
});

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function period(overrides: Partial<LoanSchedulePeriod> = {}): LoanSchedulePeriod {
  return {
    index: 1,
    periodStart: day('2026-01-01'),
    dueDate: day('2026-02-01'),
    principalDue: 50_000,
    interestDue: 10_000,
    principalPaid: 0,
    interestPaid: 0,
    principalRelieved: 0,
    interestRelieved: 0,
    penaltyAccrued: 0,
    penaltyBilled: 0,
    due: 60_000,
    paid: 0,
    relieved: 0,
    outstanding: 60_000,
    overdueDays: 0,
    status: SchedulePeriodStatus.PENDING,
    ...overrides,
  };
}

describe('penaltyForPeriod', () => {
  it('charges nothing when the product has no penalty', () => {
    expect(penaltyForPeriod(DEFAULT_PENALTY_POLICY, 100_000, 90)).toBe(0);
  });

  it('charges nothing while the period is not overdue or nothing is unpaid', () => {
    expect(penaltyForPeriod(percent(1.5), 100_000, 0)).toBe(0);
    expect(penaltyForPeriod(percent(1.5), 0, 45)).toBe(0);
  });

  it('pro-rates a percent penalty over the penalty period', () => {
    expect(penaltyForPeriod(percent(1.5), 100_000, 45)).toBe(2_250);
    expect(penaltyForPeriod(percent(1.5, PeriodUnit.DAY), 100_000, 45)).toBe(67_500);
  });

  it('bills a fixed penalty per whole period of overdue time', () => {
    expect(penaltyForPeriod(fixed(5_000), 100_000, 1)).toBe(5_000);
    expect(penaltyForPeriod(fixed(5_000), 100_000, 61)).toBe(15_000);
  });
});

describe('capAccruedPenalties', () => {
  it('trims the newest periods down to the ceiling', () => {
    const periods = [period({ penaltyAccrued: 1_000 }), period({ penaltyAccrued: 1_000 }), period({ penaltyAccrued: 1_000 })];
    capAccruedPenalties(periods, percent(1.5, PeriodUnit.MONTH, 0, 20), 10_000);
    expect(periods.map((p) => p.penaltyAccrued)).toEqual([1_000, 1_000, 0]);
  });

  it('leaves the schedule untouched without a ceiling', () => {
    const periods = [period({ penaltyAccrued: 1_000 }), period({ penaltyAccrued: 1_000 })];
    capAccruedPenalties(periods, percent(1.5), 10_000);
    expect(periods.map((p) => p.penaltyAccrued)).toEqual([1_000, 1_000]);
  });
});

describe('spreadBilledPenalty', () => {
  it('fills the oldest accrued periods first', () => {
    const periods = [period({ penaltyAccrued: 500 }), period({ penaltyAccrued: 700 }), period({ penaltyAccrued: 0 })];
    spreadBilledPenalty(periods, 900);
    expect(periods.map((p) => p.penaltyBilled)).toEqual([500, 400, 0]);
  });

  it('keeps penalty billed on the ledger when it exceeds the accrued estimate', () => {
    const periods = [period({ penaltyAccrued: 100, outstanding: 0 }), period({ penaltyAccrued: 0, outstanding: 60_000 })];
    spreadBilledPenalty(periods, 500);
    expect(periods.map((p) => p.penaltyBilled)).toEqual([100, 400]);
  });
});

describe('periodStatus', () => {
  const asOf = day('2026-02-20');

  it('reads PAID only when the whole scheduled amount is settled', () => {
    expect(periodStatus(period({ paid: 60_000 }), 0, asOf)).toBe(SchedulePeriodStatus.PAID);
  });

  it('reads PARTIAL while some but not all is paid', () => {
    expect(periodStatus(period({ paid: 20_000 }), 0, asOf)).toBe(SchedulePeriodStatus.PARTIAL);
  });

  it('treats relief as settled while keeping it out of the paid figure', () => {
    expect(periodStatus(period({ paid: 0, relieved: 60_000 }), 0, asOf)).toBe(SchedulePeriodStatus.PAID);
  });

  it('reads OVERDUE rather than PARTIAL when a partly paid period is past its due date', () => {
    expect(periodStatus(period({ paid: 20_000, outstanding: 40_000, overdueDays: 12 }), 0, asOf)).toBe(
      SchedulePeriodStatus.OVERDUE,
    );
  });

  it('reads OVERDUE past the due date and DUE once the grace period has run out', () => {
    expect(periodStatus(period({ overdueDays: 19 }), 0, asOf)).toBe(SchedulePeriodStatus.OVERDUE);
    expect(periodStatus(period({ dueDate: day('2026-02-25') }), 7, asOf)).toBe(SchedulePeriodStatus.DUE);
  });

  it('reads PENDING before the due date', () => {
    expect(periodStatus(period({ dueDate: day('2026-03-01') }), 0, asOf)).toBe(SchedulePeriodStatus.PENDING);
  });
});

describe('isPeriodArrived', () => {
  const asOf = day('2026-02-20');

  it('opens a period exactly on the grace window that turns it DUE', () => {
    expect(isPeriodArrived(period({ dueDate: day('2026-02-25') }), 7, asOf)).toBe(true);
    expect(isPeriodArrived(period({ dueDate: day('2026-02-28') }), 7, asOf)).toBe(false);
  });

  it('counts past-due and due-on-the-day periods as arrived', () => {
    expect(isPeriodArrived(period({ dueDate: day('2026-01-05') }), 0, asOf)).toBe(true);
    expect(isPeriodArrived(period({ dueDate: asOf }), 0, asOf)).toBe(true);
  });

  it('keeps a far-ahead instalment closed even under a long grace window', () => {
    const far = period({ dueDate: day('2026-04-01') });
    expect(isPeriodArrived(far, 3, asOf)).toBe(false);
    expect(isPeriodArrived(far, 15, asOf)).toBe(false);
  });
});

describe('placeInterestOnPeriods', () => {
  it('puts every booked charge on the period the ledger says it belongs to', () => {
    const byPeriod = new Map([
      [1, 120_000],
      [2, 115_000],
      [3, 110_000],
    ]);
    expect(placeInterestOnPeriods(byPeriod, 345_000, 6)).toEqual([120_000, 115_000, 110_000, 0, 0, 0]);
  });

  it('spreads interest booked without a period (a lump sum or a correction) over the term', () => {
    const byPeriod = new Map([[1, 50_000]]);
    const shares = placeInterestOnPeriods(byPeriod, 50_000 + 30, 3);
    expect(shares).toEqual([50_010, 10, 10]);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(50_030, 2);
  });

  it('never loses a charge whose period number is outside the term', () => {
    const shares = placeInterestOnPeriods(new Map([[9, 10_000]]), 10_000, 3);
    expect(shares).toHaveLength(3);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('keeps booked periods in place while an extra correction is spread around them', () => {
    const byPeriod = new Map([
      [1, 120_000],
      [2, 115_000],
    ]);
    const shares = placeInterestOnPeriods(byPeriod, 240_000, 4);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(240_000);
    expect(shares[0]).toBeGreaterThan(120_000);
    expect(shares[1]).toBeGreaterThan(115_000);
  });
});
