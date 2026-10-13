import { describe, expect, it } from 'vitest';
import { LoanStatus, TransactionType, type ComponentAmounts } from '../entities/types';
import { computeLoanStatusAfterPosting, totalOutstanding } from './loan-balance.service';

describe('computeLoanStatusAfterPosting', () => {
  it('keeps a loan active while any payable component remains', () => {
    expect(
      computeLoanStatusAfterPosting(
        TransactionType.PAYMENT,
        { PENALTY: 0, PAST_INTEREST: 1, PAST_PRINCIPAL: 0 },
        LoanStatus.ACTIVE,
      ),
    ).toBe(LoanStatus.ACTIVE);
  });

  it('closes a loan only when all components are zero', () => {
    const zero: ComponentAmounts = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
    expect(computeLoanStatusAfterPosting(TransactionType.PAYMENT, zero, LoanStatus.ACTIVE)).toBe(
      LoanStatus.CLOSED,
    );
  });

  it('reopens a closed loan when a posted reversal restores outstanding', () => {
    expect(
      computeLoanStatusAfterPosting(
        TransactionType.PAYMENT_REVERSAL,
        { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 1 },
        LoanStatus.CLOSED,
      ),
    ).toBe(LoanStatus.ACTIVE);
  });

  it('preserves WRITTEN_OFF when a write-off reversal leaves no outstanding', () => {
    expect(
      computeLoanStatusAfterPosting(
        TransactionType.WRITE_OFF_REVERSAL,
        { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 },
        LoanStatus.WRITTEN_OFF,
      ),
    ).toBe(LoanStatus.WRITTEN_OFF);
  });

  it('keeps the operational total equal to all payable components', () => {
    expect(totalOutstanding({ PENALTY: 1.25, PAST_INTEREST: 2.5, PAST_PRINCIPAL: 3 })).toBe(6.75);
  });
});
