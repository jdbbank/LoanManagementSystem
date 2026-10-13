import { describe, expect, it } from 'vitest';
import { SettlementStatus } from '../entities/types';
import {
  validateSettlementPayment,
  validateSettlementShortfallWaiver,
} from './settlement.service';

const approved = {
  loanId: 'loan-1',
  status: SettlementStatus.APPROVED,
  agreedAmount: 700,
};

describe('validateSettlementPayment', () => {
  it('allows payments against an approved agreement for its loan within the agreed amount', () => {
    expect(() => validateSettlementPayment(approved, 'loan-1', 700)).not.toThrow();
  });

  it('rejects unapproved agreements', () => {
    expect(() =>
      validateSettlementPayment(
        { ...approved, status: SettlementStatus.PENDING_APPROVAL },
        'loan-1',
        100,
      ),
    ).toThrow(/must be APPROVED/);
  });

  it('rejects using an agreement for another loan', () => {
    expect(() => validateSettlementPayment(approved, 'loan-2', 100)).toThrow(/different loan/);
  });

  it('rejects payments above the agreed amount', () => {
    expect(() => validateSettlementPayment(approved, 'loan-1', 700.01)).toThrow(/exceeds the agreed amount/);
  });
});

describe('validateSettlementShortfallWaiver', () => {
  it('allows waiver after posted settlement payments reach the agreement amount', () => {
    expect(() => validateSettlementShortfallWaiver(700, 700, 0)).not.toThrow();
  });

  it('rejects waiver when posted settlement payments are still partial', () => {
    expect(() => validateSettlementShortfallWaiver(700, 500, 0)).toThrow(/must be fully paid/);
  });

  it('subtracts posted reversals before deciding whether the agreement is paid', () => {
    expect(() => validateSettlementShortfallWaiver(700, 800, 150)).toThrow(/must be fully paid/);
  });
});
