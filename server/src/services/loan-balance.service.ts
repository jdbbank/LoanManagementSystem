import { AuditBalanceSnapshot } from '../entities/audit-log.entity';
import { Loan } from '../entities/loan.entity';
import { ComponentAmounts, LoanStatus, TransactionType } from '../entities/types';
import { EPS, num, round2 } from '../utils/money';

export function getBalances(loan: Loan): ComponentAmounts {
  return {
    PENALTY: num(loan.outstandingPenalty),
    PAST_INTEREST: num(loan.outstandingPastInterest),
    PAST_PRINCIPAL: num(loan.outstandingPastPrincipal),
  };
}

export function balanceSnapshot(loan: Loan): AuditBalanceSnapshot {
  const b = getBalances(loan);
  return { ...b, total: round2(b.PENALTY + b.PAST_INTEREST + b.PAST_PRINCIPAL) };
}

/** Applies signed component deltas to the operational loan balance. */
export function applyDeltas(loan: Loan, deltas: ComponentAmounts): void {
  loan.outstandingPenalty = round2(num(loan.outstandingPenalty) + num(deltas.PENALTY));
  loan.outstandingPastInterest = round2(num(loan.outstandingPastInterest) + num(deltas.PAST_INTEREST));
  loan.outstandingPastPrincipal = round2(num(loan.outstandingPastPrincipal) + num(deltas.PAST_PRINCIPAL));
  loan.currentOutstanding = round2(
    num(loan.outstandingPenalty) + num(loan.outstandingPastInterest) + num(loan.outstandingPastPrincipal),
  );
}

export const totalOutstanding = (b: ComponentAmounts): number =>
  round2(num(b.PENALTY) + num(b.PAST_INTEREST) + num(b.PAST_PRINCIPAL));

/**
 * Loan status after a POSTED transaction — driven by financial truth only (LOCKED sections 14, 15, 18, 19).
 *
 * - PAYMENT / SETTLEMENT_PAYMENT / WAIVER / ADJUSTMENT / PENALTY / PAYMENT_REVERSAL / DISBURSEMENT:
 *   all payable components zero -> CLOSED; any component > 0 -> ACTIVE.
 *   (Closed loan + posted reversal with outstanding > 0 reopens automatically; WRITTEN_OFF
 *   loans with zero outstanding keep their distinct status.)
 * - WRITE_OFF: outstanding fully zero -> WRITTEN_OFF (distinct status, never CLOSED); else ACTIVE.
 * - WRITE_OFF_REVERSAL: outstanding > 0 -> ACTIVE; still zero -> WRITTEN_OFF.
 */
export function computeLoanStatusAfterPosting(
  transactionType: TransactionType,
  balances: ComponentAmounts,
  currentStatus: LoanStatus,
): LoanStatus {
  const total = totalOutstanding(balances);
  switch (transactionType) {
    case TransactionType.WRITE_OFF:
      return total < EPS ? LoanStatus.WRITTEN_OFF : LoanStatus.ACTIVE;
    case TransactionType.WRITE_OFF_REVERSAL:
      return total > EPS ? LoanStatus.ACTIVE : LoanStatus.WRITTEN_OFF;
    default:
      if (total > EPS) return LoanStatus.ACTIVE;
      return currentStatus === LoanStatus.WRITTEN_OFF ? LoanStatus.WRITTEN_OFF : LoanStatus.CLOSED;
  }
}
