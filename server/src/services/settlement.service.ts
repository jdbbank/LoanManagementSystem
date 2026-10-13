import type { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { SettlementStatus } from '../entities/types';
import { notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';

export function validateSettlementPayment(
  agreement: Pick<SettlementAgreement, 'loanId' | 'status' | 'agreedAmount'> | null,
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
  if (num(paymentTotal) - num(agreement.agreedAmount) > EPS) {
    throw unprocessable(
      `Settlement payment (${num(paymentTotal)}) exceeds the agreed amount (${num(agreement.agreedAmount)})`,
    );
  }
}

export function validateSettlementShortfallWaiver(
  agreedAmount: number,
  postedPaymentAmount: number,
  postedReversalAmount: number,
): void {
  const netPaid = round2(num(postedPaymentAmount) - num(postedReversalAmount));
  if (netPaid + EPS < num(agreedAmount)) {
    throw unprocessable(
      `Settlement payments posted (${netPaid}) are below the agreed amount (${num(agreedAmount)}); the agreed amount must be fully paid before waiving the shortfall`,
    );
  }
}
