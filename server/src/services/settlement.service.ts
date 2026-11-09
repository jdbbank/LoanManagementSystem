import type { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { SettlementStatus } from '../entities/types';
import { notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';

/**
 * The price of ending a loan before its last instalment falls due: the loan's own fee percent applied
 * to the principal still owed. A loan that has run its term, or a product with no fee configured,
 * pays nothing — the fee is what early is, not what settling is.
 */
export function computeEarlySettlementFee(
  principalOutstanding: number,
  feePercent: number,
  settledBeforeTermEnd: boolean,
): number {
  if (!settledBeforeTermEnd || num(feePercent) <= 0) return 0;
  return round2(Math.max(0, num(principalOutstanding)) * (num(feePercent) / 100));
}

/** Everything the customer has to hand over to close the loan under this agreement. */
export function settlementTotalDue(
  agreement: Pick<SettlementAgreement, 'agreedAmount' | 'earlySettlementFee'>,
): number {
  return round2(num(agreement.agreedAmount) + num(agreement.earlySettlementFee));
}

export function validateSettlementPayment(
  agreement: Pick<SettlementAgreement, 'loanId' | 'status' | 'agreedAmount' | 'earlySettlementFee'> | null,
  loanId: string,
  paymentTotal: number,
): void {
  if (!agreement) throw notFound('Settlement agreement');
  if (agreement.status !== SettlementStatus.APPROVED) {
    throw unprocessable(`Settlement agreement is ${agreement.status} — must be APPROVED first`);
  }
  if (agreement.loanId !== loanId) {
    throw unprocessable('Settlement agreement belongs to a different loan');
  }
  const totalDue = settlementTotalDue(agreement);
  if (num(paymentTotal) - totalDue > EPS) {
    throw unprocessable(
      `Settlement payment (${num(paymentTotal)}) exceeds the agreed amount (${num(agreement.agreedAmount)}) ` +
        `plus its early-settlement fee (${num(agreement.earlySettlementFee)})`,
    );
  }
}

/**
 * The fee is debt like any other penalty, so it has to be billed and posted before the settlement
 * payment settles the book. Posted first means it is in the outstanding the payment allocates against;
 * posted later would mean the payment overpays into credit and the shortfall waiver hands the fee back.
 */
export function assertEarlySettlementFeePosted(
  agreement: Pick<SettlementAgreement, 'agreedAmount' | 'earlySettlementFee'>,
  postedFeeAmount: number,
): void {
  const fee = num(agreement.earlySettlementFee);
  if (fee <= EPS) return;
  if (postedFeeAmount + EPS < fee) {
    throw unprocessable(
      `Early-settlement fee of ${fee} must be approved and posted before the settlement payment — ` +
        `${round2(num(postedFeeAmount))} posted so far`,
    );
  }
}

export function validateSettlementShortfallWaiver(
  agreement: Pick<SettlementAgreement, 'agreedAmount' | 'earlySettlementFee'>,
  postedPaymentAmount: number,
  postedReversalAmount: number,
): void {
  const netPaid = round2(num(postedPaymentAmount) - num(postedReversalAmount));
  const totalDue = settlementTotalDue(agreement);
  if (netPaid + EPS < totalDue) {
    throw unprocessable(
      `Settlement payments posted (${netPaid}) are below what the agreement asks for (${totalDue}: ` +
        `${num(agreement.agreedAmount)} agreed plus ${num(agreement.earlySettlementFee)} early-settlement fee); ` +
        `the full amount must be paid before waiving the shortfall`,
    );
  }
}
