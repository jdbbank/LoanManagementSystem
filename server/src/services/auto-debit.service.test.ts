import { describe, expect, it } from 'vitest';
import { SchedulePeriodStatus } from '../entities/types';
import type { PayableNow, PayablePeriod } from './payment-due.service';
import { decideAutoDebit } from './auto-debit.service';

type PayableSlice = Pick<PayableNow, 'duePeriods' | 'creditBalance' | 'maxPayable'>;

function period(index: number, collectable: number, dueInDays = 0): PayablePeriod {
  return {
    index,
    dueDate: new Date(Date.UTC(2026, 10, 1 + dueInDays)),
    outstanding: collectable,
    penaltyBilled: 0,
    collectable,
    status: dueInDays < 0 ? SchedulePeriodStatus.OVERDUE : SchedulePeriodStatus.DUE,
  };
}

function payable(periods: PayablePeriod[], creditBalance: number, maxPayable?: number): PayableSlice {
  return {
    duePeriods: periods,
    creditBalance,
    maxPayable: maxPayable ?? periods.reduce((total, p) => total + p.collectable, 0),
  };
}

describe('decideAutoDebit', () => {
  it('settles nothing when the window is empty', () => {
    const decision = decideAutoDebit(payable([], 100_000_000), new Set());
    expect(decision).toEqual({ kind: 'SKIP', reason: 'No instalment is inside the lead window yet' });
  });

  it('debits the oldest instalment inside the window, for its full collectable amount', () => {
    const decision = decideAutoDebit(payable([period(3, 13_000_000), period(4, 13_000_000)], 40_000_000), new Set());
    expect(decision).toEqual({
      kind: 'DEBIT',
      periodIndex: 3,
      dueDate: period(3, 0).dueDate,
      amount: 13_000_000,
    });
  });

  it('waits instead of taking a partial debit when the credit does not cover the oldest period', () => {
    const decision = decideAutoDebit(payable([period(3, 13_000_000), period(4, 13_000_000)], 12_999_999), new Set());
    if (decision.kind !== 'SKIP') throw new Error('expected a SKIP decision');
    expect(decision.reason).toContain('does not cover period 3');
  });

  it('does not skip forward to a cheaper period just because the oldest one is unaffordable', () => {
    // Period 3 needs 40M of credit, period 4 only 1M: taking 4 would leave 3 overdue and penalty-ripe.
    const decision = decideAutoDebit(payable([period(3, 40_000_000), period(4, 1_000_000)], 5_000_000), new Set());
    expect(decision.kind).toBe('SKIP');
  });

  it('takes the next instalment once the oldest one is already debited', () => {
    const decision = decideAutoDebit(payable([period(3, 13_000_000), period(4, 13_000_000)], 40_000_000), new Set([3]));
    expect(decision.kind === 'DEBIT' && decision.periodIndex).toBe(4);
  });

  it('does not re-debit a period whose debit is still awaiting posting', () => {
    const decision = decideAutoDebit(payable([period(3, 13_000_000)], 40_000_000), new Set([3]));
    expect(decision).toEqual({
      kind: 'SKIP',
      reason: 'Every instalment inside the lead window has already been debited',
    });
  });

  it('never bills more than the ledger ceiling', () => {
    const decision = decideAutoDebit(payable([period(5, 13_000_000)], 40_000_000, 4_000_000), new Set());
    expect(decision.kind === 'DEBIT' && decision.amount).toBe(4_000_000);
  });

  it('skips a period the ceiling reduces to nothing', () => {
    const decision = decideAutoDebit(payable([period(5, 13_000_000)], 40_000_000, 0), new Set());
    expect(decision).toEqual({ kind: 'SKIP', reason: 'Nothing is collectable on this loan right now' });
  });

  it('ignores a window row that carries no collectable amount', () => {
    const decision = decideAutoDebit(payable([period(3, 0), period(4, 13_000_000)], 40_000_000), new Set());
    expect(decision.kind === 'DEBIT' && decision.periodIndex).toBe(4);
  });
});
