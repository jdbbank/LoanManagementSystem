import { describe, expect, it } from 'vitest';
import { DEFAULT_PENALTY_POLICY, PenaltyMode, PeriodUnit, SchedulePeriodStatus, type PenaltyPolicy } from '../entities/types';
import {
  capAccruedPenalties,
  penaltyForPeriod,
  periodStatus,
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
