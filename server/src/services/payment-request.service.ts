import { EntityManager } from 'typeorm';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { Loan } from '../entities/loan.entity';
import { PaymentAllocation } from '../entities/payment-allocation.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ComponentAmounts,
  ComponentType,
  LoanStatus,
  PaymentRequestPurpose,
  PaymentRequestStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { AuthUser } from '../middleware/auth';
import { badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { allocateSequentially, validateAllocationOverride, zeroComponents } from './allocation.service';
import { writeAudit } from './audit.service';
import { getBalances } from './loan-balance.service';
import { assertPaymentWithinDueScope } from './payment-due.service';
import { validateSettlementPayment } from './settlement.service';
import { nextRequestNo, nextTransactionNo } from './reference.service';

/**
 * The payment request lifecycle, outside any router.
 *
 * Staff reach it through POST /payment-requests and /:id/approve; the settlement flow creates the
 * agreement's payment draft with the same call; the auto-debit job runs the identical create ->
 * approve -> post sequence a checker and an operator would. Keeping one implementation is what
 * guarantees a machine settlement cannot dodge a rule a human one is held to.
 */

export interface CreatePaymentRequestParams {
  loanId: string;
  cashAmount: number;
  creditApplied: number;
  settlementAgreementId: string | null;
  note: string | null;
  previousRequestId: string | null;
  purpose?: PaymentRequestPurpose;
  user: AuthUser;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Collectable window used for the due-scope gate, in days before an instalment's due date.
   * Defaults to the product's grace window; the auto-debit job passes its configured lead.
   */
  collectLeadDays?: number;
}

export async function createPaymentRequestRecord(em: EntityManager, params: CreatePaymentRequestParams) {
  const loan = await em.findOne(Loan, { where: { id: params.loanId } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — payments require an ACTIVE loan`);
  }

  const purpose = params.purpose ?? PaymentRequestPurpose.PAY_DEBT;
  const isDeposit = purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT;
  if (isDeposit) {
    if (params.settlementAgreementId) {
      throw unprocessable('A deposit to credit cannot be tied to a settlement agreement');
    }
    if (params.creditApplied > EPS) {
      throw unprocessable('A deposit to credit is cash received only — it cannot also spend customer credit');
    }
  }

  const paymentTotal = round2(params.cashAmount + params.creditApplied);
  if (paymentTotal <= EPS) throw badRequest('Payment amount must be greater than zero');

  if (params.settlementAgreementId) {
    const agreement = await em.findOne(SettlementAgreement, {
      where: { id: params.settlementAgreementId },
    });
    validateSettlementPayment(agreement, loan.id, paymentTotal);
  } else if (!isDeposit) {
    // An ordinary payment may only settle instalments that have arrived. Money brought early is a
    // deposit against the customer's credit, which the auto-debit job draws on when the period falls due.
    await assertPaymentWithinDueScope(em, loan, paymentTotal, new Date(), {
      collectLeadDays: params.collectLeadDays,
    });
  }

  if (params.creditApplied > EPS) {
    const credit = await em.findOne(CustomerCredit, {
      where: { customerId: loan.customerId, currency: 'LAK' },
    });
    const available = credit ? num(credit.balance) : 0;
    if (available + EPS < params.creditApplied) {
      throw unprocessable(`Insufficient customer credit: available ${available}, requested ${params.creditApplied}`);
    }
  }

  const outstanding = getBalances(loan);
  // A deposit buys no debt: the proposal is deliberately empty so the whole amount lands in credit.
  const proposed = isDeposit
    ? { allocation: zeroComponents(), excess: paymentTotal }
    : allocateSequentially(paymentTotal, outstanding);

  const request = em.create(PaymentRequest, {
    requestNo: await nextRequestNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    cashAmount: round2(params.cashAmount),
    creditApplied: round2(params.creditApplied),
    status: PaymentRequestStatus.PENDING,
    purpose,
    previousRequestId: params.previousRequestId,
    settlementAgreementId: params.settlementAgreementId,
    note: params.note,
    createdBy: params.user.id,
  });
  await em.save(PaymentRequest, request);

  // System-proposed sequential allocation snapshot (locked section 7).
  const allocations: PaymentAllocation[] = [];
  for (const component of Object.values(ComponentType)) {
    const row = em.create(PaymentAllocation, {
      paymentRequestId: request.id,
      component,
      proposedAmount: proposed.allocation[component],
      finalAmount: 0,
    });
    await em.save(PaymentAllocation, row);
    allocations.push(row);
  }

  await writeAudit(em, {
    action: params.previousRequestId ? 'PAYMENT_REQUEST_RESUBMITTED' : 'PAYMENT_REQUEST_CREATED',
    loanId: loan.id,
    customerId: loan.customerId,
    userId: params.user.id,
    amount: paymentTotal,
    currency: 'LAK',
    newStatus: PaymentRequestStatus.PENDING,
    reason: params.note,
    relatedTransactionId: null,
    sourceRequestId: request.id,
    referenceTransactionId: params.previousRequestId,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return { request, loan, proposed: proposed.allocation, allocations };
}

export interface ApprovePaymentParams {
  requestId: string;
  user: AuthUser;
  overrideAllocation?: { PENALTY?: number; PAST_INTEREST?: number; PAST_PRINCIPAL?: number } | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Repayment period a debit belongs to. Only the auto-debit job sets it, and it is what makes that
   * job idempotent: a period with a live debit on it is never debited twice.
   */
  periodIndex?: number | null;
  /**
   * Maker-checker separation exists so one person cannot both claim cash received and release the
   * debt. A system auto-debit claims no cash: it spends credit the customer themselves deposited,
   * one instalment at a time, under a switch only an ADMIN can turn on. It therefore approves as its
   * own maker, and every audit row names the machine account.
   */
  systemAutoDebit?: boolean;
}

/**
 * Verify a pending request and create the APPROVED transaction an operator then posts.
 * Runs inside the caller's transaction so the loan lock and the request lock are held together.
 */
export async function approvePaymentRequest(em: EntityManager, params: ApprovePaymentParams) {
  const request = await em.findOne(PaymentRequest, {
    where: { id: params.requestId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!request) throw notFound('Payment request');
  if (request.status !== PaymentRequestStatus.PENDING) {
    throw unprocessable(`Request is already ${request.status}`);
  }
  if (!params.systemAutoDebit && request.createdBy === params.user.id) {
    throw unprocessable('Maker cannot verify their own payment request (maker-checker separation)');
  }

  const loan = await em.findOne(Loan, { where: { id: request.loanId }, lock: { mode: 'pessimistic_write' } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — cannot approve payment`);
  }

  const paymentTotal = round2(num(request.cashAmount) + num(request.creditApplied));
  const outstanding = getBalances(loan);
  const isDeposit = request.purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT;
  const proposed = isDeposit ? zeroComponents() : allocateSequentially(paymentTotal, outstanding).allocation;

  let allocation: ComponentAmounts = proposed;
  if (params.overrideAllocation) {
    if (isDeposit) {
      throw unprocessable('A deposit to credit has no debt allocation to override');
    }
    allocation = {
      PENALTY: num(params.overrideAllocation.PENALTY),
      PAST_INTEREST: num(params.overrideAllocation.PAST_INTEREST),
      PAST_PRINCIPAL: num(params.overrideAllocation.PAST_PRINCIPAL),
    };
    // HARD validation — reject immediately, no warning mode, no bypass (locked section 7).
    validateAllocationOverride(allocation, paymentTotal, outstanding);
  }

  request.status = PaymentRequestStatus.APPROVED;
  request.approvedBy = params.user.id;
  request.approvedAt = new Date();
  await em.save(PaymentRequest, request);

  const allocations = await em.find(PaymentAllocation, { where: { paymentRequestId: request.id } });
  for (const row of allocations) {
    row.finalAmount = allocation[row.component];
    row.overridden = params.overrideAllocation !== undefined;
    await em.save(PaymentAllocation, row);
  }

  const tx = em.create(FinancialTransaction, {
    referenceNo: await nextTransactionNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    transactionType: request.settlementAgreementId ? TransactionType.SETTLEMENT_PAYMENT : TransactionType.PAYMENT,
    status: TransactionStatus.APPROVED,
    amount: paymentTotal,
    currency: 'LAK',
    componentAmounts: allocation,
    sourceRequestId: request.id,
    settlementAgreementId: request.settlementAgreementId,
    periodIndex: params.periodIndex ?? null,
    reason: params.reason ?? `Payment for request ${request.requestNo}`,
    createdBy: request.createdBy,
    approvedAt: new Date(),
  });
  await em.save(FinancialTransaction, tx);

  await writeAudit(em, {
    action: 'PAYMENT_REQUEST_APPROVED',
    transactionId: tx.id,
    transactionType: TransactionType.PAYMENT,
    loanId: loan.id,
    customerId: loan.customerId,
    userId: params.user.id,
    previousStatus: PaymentRequestStatus.PENDING,
    newStatus: PaymentRequestStatus.APPROVED,
    amount: paymentTotal,
    currency: 'LAK',
    makerUserId: request.createdBy,
    checkerUserId: params.user.id,
    reason: params.reason ?? null,
    sourceRequestId: request.id,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return { request, transaction: tx, allocation, proposed };
}

/** Create and verify in one transaction — the shape the auto-debit job uses. */
export async function createAndApprovePaymentRequest(
  em: EntityManager,
  params: CreatePaymentRequestParams & { periodIndex?: number | null; systemAutoDebit?: boolean },
) {
  const created = await createPaymentRequestRecord(em, params);
  const approved = await approvePaymentRequest(em, {
    requestId: created.request.id,
    user: params.user,
    reason: params.note,
    ip: params.ip,
    userAgent: params.userAgent,
    periodIndex: params.periodIndex,
    systemAutoDebit: params.systemAutoDebit,
  });
  return { ...created, ...approved };
}
