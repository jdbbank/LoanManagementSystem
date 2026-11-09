import { describe, expect, it } from 'vitest';
import { SettlementStatus } from '../entities/types';
import {
  assertEarlySettlementFeePosted,
  computeEarlySettlementFee,
  settlementTotalDue,
  validateSettlementPayment,
  validateSettlementShortfallWaiver,
} from './settlement.service';

const approved = {
  loanId: 'loan-1',
  status: SettlementStatus.APPROVED,
  agreedAmount: 700,
  earlySettlementFee: 0,
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

  it('raises the ceiling by the early-settlement fee the payoff carries', () => {
    const withFee = { ...approved, earlySettlementFee: 35 };
    expect(() => validateSettlementPayment(withFee, 'loan-1', 735)).not.toThrow();
    expect(() => validateSettlementPayment(withFee, 'loan-1', 735.01)).toThrow(/early-settlement fee/);
  });
});

describe('computeEarlySettlementFee', () => {
  it('is a percent of the principal still owed', () => {
    expect(computeEarlySettlementFee(1_000_000, 2, true)).toBe(20_000);
    expect(computeEarlySettlementFee(333_333.33, 1.5, true)).toBe(5_000);
  });

  it('is the kips the ledger stores, never more', () => {
    expect(computeEarlySettlementFee(1_000_000, 0.0001, true)).toBe(1);
    expect(computeEarlySettlementFee(100.005, 5, true)).toBe(5);
  });

  it('rounds the fraction of a kip the same way the ledger does', () => {
    expect(computeEarlySettlementFee(1_000_000, 0.00001, true)).toBe(0.1);
  });

  it('is nothing when the product charges nothing', () => {
    expect(computeEarlySettlementFee(1_000_000, 0, true)).toBe(0);
  });

  it('is nothing on a loan that has already run its term', () => {
    expect(computeEarlySettlementFee(1_000_000, 5, false)).toBe(0);
  });

  it('is nothing once the principal is gone', () => {
    expect(computeEarlySettlementFee(0, 5, true)).toBe(0);
  });
});

describe('settlementTotalDue', () => {
  it('is the agreed amount plus the fee', () => {
    expect(settlementTotalDue({ agreedAmount: 700, earlySettlementFee: 35.5 })).toBe(735.5);
  });

  it('is the agreed amount alone when no fee applies', () => {
    expect(settlementTotalDue({ agreedAmount: 700, earlySettlementFee: 0 })).toBe(700);
  });
});

describe('assertEarlySettlementFeePosted', () => {
  it('lets any payment through when the payoff carries no fee', () => {
    expect(() => assertEarlySettlementFeePosted({ agreedAmount: 700, earlySettlementFee: 0 }, 0)).not.toThrow();
  });

  it('refuses until the fee itself has been posted', () => {
    expect(() =>
      assertEarlySettlementFeePosted({ agreedAmount: 700, earlySettlementFee: 35 }, 34.99),
    ).toThrow(/must be approved and posted/);
  });

  it('accepts the payment once the fee covers what was agreed', () => {
    expect(() =>
      assertEarlySettlementFeePosted({ agreedAmount: 700, earlySettlementFee: 35 }, 35),
    ).not.toThrow();
  });
});

describe('validateSettlementShortfallWaiver', () => {
  it('allows waiver after posted settlement payments reach the agreement amount', () => {
    expect(() => validateSettlementShortfallWaiver(approved, 700, 0)).not.toThrow();
  });

  it('rejects waiver when posted settlement payments are still partial', () => {
    expect(() => validateSettlementShortfallWaiver(approved, 500, 0)).toThrow(/below what the agreement asks for/);
  });

  it('counts a reversal against what has been paid', () => {
    expect(() => validateSettlementShortfallWaiver(approved, 700, 0.01)).toThrow(/below what the agreement asks for/);
  });

  it('requires the fee to be paid too before anything is waived', () => {
    const withFee = { agreedAmount: 700, earlySettlementFee: 35 };
    expect(() => validateSettlementShortfallWaiver(withFee, 700, 0)).toThrow(/early-settlement fee/);
    expect(() => validateSettlementShortfallWaiver(withFee, 735, 0)).not.toThrow();
  });
});
