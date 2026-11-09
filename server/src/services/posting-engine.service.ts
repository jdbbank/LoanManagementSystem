import { EntityManager, In } from 'typeorm';
import { getDataSource } from '../datasource';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep } from '../entities/approval-step.entity';
import { CreditLedger } from '../entities/credit-ledger.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import { PaymentAllocation } from '../entities/payment-allocation.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ApprovalLevel,
  ApprovalSubjectType,
  ComponentAmounts,
  ComponentType,
  CreditLedgerType,
  LoanStatus,
  PaymentRequestPurpose,
  PaymentRequestStatus,
  StepStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { allocateReversalSequentially, allocateSequentially, validateAllocationOverride, zeroComponents } from './allocation.service';
import { applyDeltas, balanceSnapshot, computeLoanStatusAfterPosting, getBalances } from './loan-balance.service';
import { resolvePenaltyPolicy } from './loan-schedule.service';
import { penaltyCeilingOf } from './penalty-policy.service';
import { assertEarlySettlementFeePosted, settlementTotalDue } from './settlement.service';
import {
  notifyAutoDebitPosted,
  notifyCreditDeposited,
  notifyPaymentPosted,
  notifyPenaltyPosted,
  notifyWaiverPosted,
  notifyWriteOffPosted,
} from './notification-events.service';
import { writeAudit } from './audit.service';
import { notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2, sumAmounts } from '../utils/money';

export interface PostContext {
  actorId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface PostResult {
  transaction: FinancialTransaction;
  loan: Loan;
  previousStatus: LoanStatus;
  newStatus: LoanStatus;
  allocation: ComponentAmounts | null;
  excess: number;
}

const NEG = (c: ComponentAmounts): ComponentAmounts => ({
  PENALTY: -num(c.PENALTY),
  PAST_INTEREST: -num(c.PAST_INTEREST),
  PAST_PRINCIPAL: -num(c.PAST_PRINCIPAL),
});

/** Reads posted transaction lines as per-component magnitudes (for original allocations). */
async function readLinesAsComponents(em: EntityManager, transactionId: string): Promise<ComponentAmounts> {
  const lines = await em.find(FinancialTransactionLine, { where: { transactionId } });
  const result = zeroComponents();
  for (const line of lines) {
    result[line.component] = round2(num(result[line.component]) + Math.abs(num(line.amount)));
  }
  return result;
}

/**
 * Downstream dependency check (LOCKED section 11): a posted adjustment that references
 * the original payment makes direct reversal unsafe — the Adjustment Workflow must be used.
 */
async function assertNoDownstreamDependency(em: EntityManager, originalTransactionId: string): Promise<void> {
  const downstream = await em.find(FinancialTransaction, {
    where: {
      referenceTransactionId: originalTransactionId,
      transactionType: TransactionType.ADJUSTMENT,
      status: TransactionStatus.POSTED,
    },
  });
  if (downstream.length > 0) {
    throw unprocessable(
      'This payment has downstream posted adjustments and cannot be directly reversed. Use the separate Adjustment Workflow (locked requirement section 11).',
    );
  }
}

async function insertLines(em: EntityManager, transactionId: string, deltas: ComponentAmounts): Promise<void> {
  for (const component of Object.values(ComponentType)) {
    const amount = round2(num(deltas[component]));
    if (Math.abs(amount) < EPS) continue;
    await em.insert(FinancialTransactionLine, {
      transactionId,
      component,
      amount,
    });
  }
}

async function approvalUserIds(em: EntityManager, tx: FinancialTransaction): Promise<{
  checkerUserId: string | null;
  headApproverUserId: string | null;
  adminUserId: string | null;
}> {
  const workflow = await em.findOne(ApprovalWorkflow, {
    where: { subjectId: tx.id, subjectType: ApprovalSubjectType.FINANCIAL_TRANSACTION },
  });
  if (!workflow) {
    // Payment requests use a single-checker verify (locked section 4) instead of a workflow.
    if (tx.sourceRequestId) {
      const request = await em.findOne(PaymentRequest, { where: { id: tx.sourceRequestId } });
      if (request) {
        return { checkerUserId: request.approvedBy, headApproverUserId: null, adminUserId: null };
      }
    }
    return { checkerUserId: null, headApproverUserId: null, adminUserId: null };
  }
  const steps = await em.find(ApprovalStep, { where: { workflowId: workflow.id } });
  const find = (level: ApprovalLevel) => steps.find((s) => s.level === level && s.status === StepStatus.APPROVED)?.userId ?? null;
  return {
    checkerUserId: find(ApprovalLevel.CHECKER),
    headApproverUserId: find(ApprovalLevel.HEAD),
    adminUserId: find(ApprovalLevel.ADMIN),
  };
}

/**
 * The customer's credit row, write-locked for the rest of this transaction. Two payments on
 * different loans of the same customer otherwise read the same balance and spend it twice,
 * leaving `credit_ledger` unable to close against `customer_credits.balance` (F-CONC-1).
 * A customer with no row yet gets one inserted, so concurrent first-time accruals lock a real
 * row instead of both trying to create it.
 */
async function lockCredit(em: EntityManager, customerId: string, currency: string): Promise<CustomerCredit> {
  const locked = await em.findOne(CustomerCredit, {
    where: { customerId, currency },
    lock: { mode: 'pessimistic_write' },
  });
  if (locked) return locked;

  try {
    await em.insert(CustomerCredit, { customerId, currency, balance: 0 });
  } catch {
    // A concurrent transaction created it first; the locked read below waits for it and finds it.
  }
  const created = await em.findOne(CustomerCredit, {
    where: { customerId, currency },
    lock: { mode: 'pessimistic_write' },
  });
  if (!created) throw notFound('Customer credit row could not be locked');
  return created;
}

async function adjustCredit(
  em: EntityManager,
  customerId: string,
  currency: string,
  delta: number,
  type: CreditLedgerType,
  transactionId: string,
  ctx: PostContext,
  loanId: string,
): Promise<number> {
  const credit = await lockCredit(em, customerId, currency);
  const balanceAfter = round2(num(credit.balance) + delta);
  credit.balance = balanceAfter;
  await em.save(CustomerCredit, credit);
  await em.insert(CreditLedger, {
    customerId,
    type,
    amount: round2(Math.abs(delta)),
    balanceAfter,
    transactionId,
  });
  await writeAudit(em, {
    action: type === 'ACCRUED' ? 'CREDIT_ACCRUED' : 'CREDIT_USED',
    transactionId,
    loanId,
    customerId,
    userId: ctx.actorId,
    amount: round2(Math.abs(delta)),
    currency,
    reason: type === 'ACCRUED' ? 'Overpayment excess stored as customer credit' : 'Customer credit applied to payment',
  });
  return balanceAfter;
}

interface PaymentPosting {
  allocation: ComponentAmounts;
  excess: number;
}

/**
 * A settlement agreement is paid once (F-CONC-5). Several approved drafts of the same agreement can
 * exist because the create-time check only compares one payment against the agreed amount, so the
 * ceiling is measured again here against what has actually been posted. The ceiling covers the early
 * settlement fee too, and that fee has to be posted first — otherwise the payment allocates against a
 * book that does not carry it yet.
 */
async function assertWithinSettlementCeiling(
  em: EntityManager,
  tx: FinancialTransaction,
  paymentTotal: number,
): Promise<void> {
  const agreement = await em.findOne(SettlementAgreement, {
    where: { id: String(tx.settlementAgreementId) },
    lock: { mode: 'pessimistic_write' },
  });
  if (!agreement) throw notFound('Settlement agreement not found');

  const posted = await em.find(FinancialTransaction, {
    where: {
      settlementAgreementId: agreement.id,
      transactionType: TransactionType.SETTLEMENT_PAYMENT,
      status: TransactionStatus.POSTED,
    },
  });
  const postedIds = posted.map((row) => row.id);
  const reversals = postedIds.length
    ? await em.find(FinancialTransaction, {
        where: {
          referenceTransactionId: In(postedIds),
          transactionType: TransactionType.PAYMENT_REVERSAL,
          status: TransactionStatus.POSTED,
        },
      })
    : [];

  const billedFee = await em.find(FinancialTransaction, {
    where: {
      settlementAgreementId: agreement.id,
      transactionType: TransactionType.PENALTY,
      status: TransactionStatus.POSTED,
    },
  });
  assertEarlySettlementFeePosted(
    agreement,
    round2(billedFee.reduce((total, row) => total + num(row.amount), 0)),
  );

  const alreadyPaid = round2(
    posted.reduce((total, row) => total + num(row.amount), 0) -
      reversals.reduce((total, row) => total + num(row.amount), 0),
  );
  const totalDue = settlementTotalDue(agreement);
  if (alreadyPaid + paymentTotal - totalDue > EPS) {
    throw unprocessable(
      `Settlement agreement ${agreement.agreementNo} is already paid for ${alreadyPaid} of ${totalDue} ` +
        `(${num(agreement.agreedAmount)} agreed plus ${num(agreement.earlySettlementFee)} early-settlement fee)`,
    );
  }
}

/**
 * The product ceiling is `maxPercentOfPrincipal` percent of this loan's own principal — the same
 * figure `capAccruedPenalties` trims a system-calculated accrual with. That route can therefore
 * never breach it, so this guard exists for the manual charge route, where an operator types the
 * amount and nothing bounded it. A waiver does not buy headroom back: the ceiling is on what has
 * been billed, not on what is still owed, so charging to the cap, waiving it and charging again
 * stays refused. Only a PAYMENT can be reversed, so posted penalties are cumulative.
 * The loan row is already write-locked by the caller, so two penalties cannot post at once.
 */
async function assertWithinPenaltyCeiling(
  em: EntityManager,
  tx: FinancialTransaction,
  loan: Loan,
): Promise<void> {
  const product = await em.findOne(LoanProduct, { where: { id: loan.productId } });
  const policy = resolvePenaltyPolicy(loan, product);
  const cap = penaltyCeilingOf(policy, num(loan.principalAmount));
  if (cap <= 0) return;

  const posted = await em.find(FinancialTransaction, {
    where: {
      loanId: loan.id,
      transactionType: TransactionType.PENALTY,
      status: TransactionStatus.POSTED,
    },
  });
  const alreadyBilled = round2(posted.reduce((total, row) => total + num(row.amount), 0));
  const total = round2(alreadyBilled + num(tx.amount));
  if (total - cap > EPS) {
    throw unprocessable(
      `Penalty would exceed the product ceiling: ${total} billed of a ${cap} maximum ` +
        `(${num(policy.maxPercentOfPrincipal)}% of principal ${num(loan.principalAmount)})`,
    );
  }
}

async function postPayment(
  em: EntityManager,
  tx: FinancialTransaction,
  loan: Loan,
  ctx: PostContext,
): Promise<PaymentPosting> {
  if (!tx.sourceRequestId) {
    throw unprocessable('Payment transaction has no source payment request');
  }
  const request = await em.findOne(PaymentRequest, { where: { id: tx.sourceRequestId } });
  if (!request) throw notFound('Source payment request not found');
  if (request.status !== PaymentRequestStatus.APPROVED) {
    throw unprocessable('Source payment request is not approved');
  }

  const paymentTotal = round2(num(tx.amount));
  const outstanding = getBalances(loan);

  if (tx.settlementAgreementId) await assertWithinSettlementCeiling(em, tx, paymentTotal);

  const allocations = await em.find(PaymentAllocation, { where: { paymentRequestId: request.id } });
  let allocation: ComponentAmounts;
  if (request.purpose === PaymentRequestPurpose.DEPOSIT_TO_CREDIT) {
    // A deposit is cash taken against no debt, so nothing is allocated and the whole amount
    // falls through to the customer's credit below.
    allocation = zeroComponents();
  } else if (allocations.some((row) => row.overridden)) {
    // Staff override — HARD validation again at posting time (LOCKED section 7).
    allocation = zeroComponents();
    for (const row of allocations) allocation[row.component] = round2(num(row.finalAmount));
    validateAllocationOverride(allocation, paymentTotal, outstanding);
  } else {
    // The approver confirmed the system proposal, so the sequence is recomputed against the balance
    // of this moment: money received settles what is actually owed, and anything left becomes credit.
    allocation = allocateSequentially(paymentTotal, outstanding).allocation;
  }

  const allocatedTotal = sumAmounts(allocation.PENALTY, allocation.PAST_INTEREST, allocation.PAST_PRINCIPAL);
  const excess = round2(paymentTotal - allocatedTotal);

  if (num(request.creditApplied) > EPS) {
    const available = num((await lockCredit(em, tx.customerId, tx.currency)).balance);
    if (available + EPS < num(request.creditApplied)) {
      throw unprocessable(
        `Insufficient customer credit: available ${available}, required ${num(request.creditApplied)}`,
      );
    }
    await adjustCredit(em, tx.customerId, tx.currency, -round2(num(request.creditApplied)), CreditLedgerType.USED, tx.id, ctx, loan.id);
  }

  if (excess > EPS) {
    await adjustCredit(em, tx.customerId, tx.currency, excess, CreditLedgerType.ACCRUED, tx.id, ctx, loan.id);
  }

  await insertLines(em, tx.id, NEG(allocation));
  applyDeltas(loan, NEG(allocation));
  return { allocation, excess };
}

async function postPaymentReversal(
  em: EntityManager,
  tx: FinancialTransaction,
  ctx: PostContext,
): Promise<ComponentAmounts> {
  if (!tx.referenceTransactionId) throw unprocessable('Reversal has no reference transaction');
  const original = await em.findOne(FinancialTransaction, { where: { id: tx.referenceTransactionId } });
  if (!original) throw notFound('Original transaction not found');
  if (original.status !== TransactionStatus.POSTED) throw unprocessable('Original transaction is not posted');
  if (original.transactionType !== TransactionType.PAYMENT && original.transactionType !== TransactionType.SETTLEMENT_PAYMENT) {
    throw unprocessable('Only payment transactions can be payment-reversed');
  }
  await assertNoDownstreamDependency(em, original.id);

  const originalAllocation = await readLinesAsComponents(em, original.id);
  const priorReversals = await em.find(FinancialTransaction, {
    where: {
      referenceTransactionId: original.id,
      transactionType: TransactionType.PAYMENT_REVERSAL,
      status: TransactionStatus.POSTED,
    },
  });
  const alreadyReversed = zeroComponents();
  for (const reversal of priorReversals) {
    const components = await readLinesAsComponents(em, reversal.id);
    alreadyReversed.PENALTY = round2(alreadyReversed.PENALTY + components.PENALTY);
    alreadyReversed.PAST_INTEREST = round2(alreadyReversed.PAST_INTEREST + components.PAST_INTEREST);
    alreadyReversed.PAST_PRINCIPAL = round2(alreadyReversed.PAST_PRINCIPAL + components.PAST_PRINCIPAL);
  }

  const { reversal, leftover } = allocateReversalSequentially(num(tx.amount), originalAllocation, alreadyReversed);
  if (leftover > EPS) {
    throw unprocessable(
      `Reversal amount exceeds the remaining reversible allocation (${round2(num(tx.amount) - leftover)} remaining)`,
    );
  }
  await insertLines(em, tx.id, reversal);
  return reversal;
}

async function postWriteOffReversal(
  em: EntityManager,
  tx: FinancialTransaction,
): Promise<ComponentAmounts> {
  if (!tx.referenceTransactionId) throw unprocessable('Write-off reversal has no reference transaction');
  const original = await em.findOne(FinancialTransaction, { where: { id: tx.referenceTransactionId } });
  if (!original) throw notFound('Original write-off not found');
  if (original.status !== TransactionStatus.POSTED) throw unprocessable('Original write-off is not posted');
  if (original.transactionType !== TransactionType.WRITE_OFF) {
    throw unprocessable('Reference transaction is not a write-off');
  }
  const originalComponents = await readLinesAsComponents(em, original.id);
  const priorReversals = await em.find(FinancialTransaction, {
    where: {
      referenceTransactionId: original.id,
      transactionType: TransactionType.WRITE_OFF_REVERSAL,
      status: TransactionStatus.POSTED,
    },
  });
  const alreadyReversed = zeroComponents();
  for (const reversal of priorReversals) {
    const components = await readLinesAsComponents(em, reversal.id);
    alreadyReversed.PENALTY = round2(alreadyReversed.PENALTY + components.PENALTY);
    alreadyReversed.PAST_INTEREST = round2(alreadyReversed.PAST_INTEREST + components.PAST_INTEREST);
    alreadyReversed.PAST_PRINCIPAL = round2(alreadyReversed.PAST_PRINCIPAL + components.PAST_PRINCIPAL);
  }
  const { reversal, leftover } = allocateReversalSequentially(num(tx.amount), originalComponents, alreadyReversed);
  if (leftover > EPS) {
    throw unprocessable('Write-off reversal amount exceeds the remaining reversible amount');
  }
  await insertLines(em, tx.id, reversal);
  return reversal;
}

function readComponentAmounts(tx: FinancialTransaction): ComponentAmounts {
  if (!tx.componentAmounts) {
    throw unprocessable(`Transaction ${tx.referenceNo} is missing component amounts`);
  }
  const c = tx.componentAmounts;
  return { PENALTY: num(c.PENALTY), PAST_INTEREST: num(c.PAST_INTEREST), PAST_PRINCIPAL: num(c.PAST_PRINCIPAL) };
}

function validateWithinOutstanding(components: ComponentAmounts, outstanding: ComponentAmounts, label: string): void {
  for (const component of Object.values(ComponentType)) {
    const value = num(components[component]);
    if (value < -EPS) {
      throw unprocessable(`${label} for ${component} must not be negative`);
    }
    if (value - num(outstanding[component]) > EPS) {
      throw unprocessable(
        `${label} for ${component} (${round2(value)}) exceeds outstanding (${num(outstanding[component])})`,
      );
    }
  }
}

/**
 * THE posting engine (LOCKED sections 8, 19, 22).
 * Everything below runs inside ONE atomic database transaction:
 * lines + allocation + outstanding update + credit + status transition + audit trail.
 * Any failure rolls back everything — no partial financial posting is possible.
 */
export async function postTransaction(txId: string, ctx: PostContext): Promise<PostResult> {
  return getDataSource().transaction(async (em: EntityManager) => {
    const tx = await em.findOne(FinancialTransaction, {
      where: { id: txId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!tx) throw notFound('Financial transaction not found');
    if (tx.status !== TransactionStatus.APPROVED) {
      throw unprocessable(`Only APPROVED transactions can be posted (current status: ${tx.status})`);
    }

    const loan = await em.findOne(Loan, {
      where: { id: tx.loanId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!loan) throw notFound('Loan not found');

    const previousStatus = loan.status;
    const previousBalance = balanceSnapshot(loan);
    const outstanding = getBalances(loan);

    let allocation: ComponentAmounts | null = null;
    let excess = 0;

    switch (tx.transactionType) {
      case TransactionType.PAYMENT:
      case TransactionType.SETTLEMENT_PAYMENT: {
        const result = await postPayment(em, tx, loan, ctx);
        allocation = result.allocation;
        excess = result.excess;
        break;
      }
      case TransactionType.PAYMENT_REVERSAL: {
        // Outstanding increases by the reversed financial amount (LOCKED section 13).
        const reversal = await postPaymentReversal(em, tx, ctx);
        applyDeltas(loan, reversal);
        allocation = reversal;
        break;
      }
      case TransactionType.PENALTY: {
        if (num(tx.amount) <= EPS) throw unprocessable('Penalty amount must be positive');
        // The charge may have been drafted while the loan was ACTIVE and approved after it was
        // closed or written off — a finished book still must not grow (same rule as accrual).
        if (loan.status !== LoanStatus.ACTIVE) {
          throw unprocessable(`Loan is ${loan.status} — penalty can only be charged on an ACTIVE loan`);
        }
        await assertWithinPenaltyCeiling(em, tx, loan);
        const delta = zeroComponents();
        delta.PENALTY = round2(num(tx.amount));
        await insertLines(em, tx.id, delta);
        applyDeltas(loan, delta);
        allocation = delta;
        break;
      }
      case TransactionType.INTEREST_ACCRUAL: {
        if (num(tx.amount) <= EPS) throw unprocessable('Interest accrual amount must be positive');
        // Interest on money that is no longer owed would reopen a settled loan, so the charge
        // only ever runs against a live one (the accrual job applies the same rule upstream).
        if (loan.status !== LoanStatus.ACTIVE) {
          throw unprocessable(`Loan is ${loan.status} — interest can only be accrued on an ACTIVE loan`);
        }
        const delta = zeroComponents();
        delta.PAST_INTEREST = round2(num(tx.amount));
        await insertLines(em, tx.id, delta);
        applyDeltas(loan, delta);
        allocation = delta;
        break;
      }
      case TransactionType.WAIVER: {
        const components = readComponentAmounts(tx);
        validateWithinOutstanding(components, outstanding, 'Waiver');
        await insertLines(em, tx.id, NEG(components));
        applyDeltas(loan, NEG(components));
        allocation = components;
        break;
      }
      case TransactionType.WRITE_OFF: {
        const components = readComponentAmounts(tx);
        validateWithinOutstanding(components, outstanding, 'Write-off');
        await insertLines(em, tx.id, NEG(components));
        applyDeltas(loan, NEG(components));
        allocation = components;
        break;
      }
      case TransactionType.WRITE_OFF_REVERSAL: {
        const reversal = await postWriteOffReversal(em, tx);
        applyDeltas(loan, reversal);
        allocation = reversal;
        break;
      }
      case TransactionType.ADJUSTMENT: {
        const deltas = readComponentAmounts(tx);
        for (const component of Object.values(ComponentType)) {
          const resulting = round2(num(outstanding[component]) + num(deltas[component]));
          if (resulting < -EPS) {
            throw unprocessable(
              `Adjustment would make ${component} outstanding negative (${resulting})`,
            );
          }
        }
        await insertLines(em, tx.id, deltas);
        applyDeltas(loan, deltas);
        allocation = deltas;
        break;
      }
      case TransactionType.DISBURSEMENT: {
        throw unprocessable('Disbursement transactions are posted at loan creation');
      }
      default:
        throw unprocessable(`Unsupported transaction type: ${tx.transactionType as string}`);
    }

    const newStatus = computeLoanStatusAfterPosting(tx.transactionType, getBalances(loan), loan.status);
    loan.status = newStatus;

    tx.status = TransactionStatus.POSTED;
    tx.postedAt = new Date();
    tx.postedBy = ctx.actorId;
    await em.save(FinancialTransaction, tx);
    await em.save(Loan, loan);

    const newBalance = balanceSnapshot(loan);
    const approvers = await approvalUserIds(em, tx);

    await writeAudit(em, {
      action: 'TRANSACTION_POSTED',
      transactionId: tx.id,
      transactionType: tx.transactionType,
      loanId: loan.id,
      customerId: tx.customerId,
      userId: ctx.actorId,
      previousStatus: 'APPROVED',
      newStatus: 'POSTED',
      previousBalance,
      newBalance,
      amount: num(tx.amount),
      currency: tx.currency,
      makerUserId: tx.createdBy,
      checkerUserId: approvers.checkerUserId,
      headApproverUserId: approvers.headApproverUserId,
      adminUserId: approvers.adminUserId,
      reason: tx.reason ?? null,
      referenceTransactionId: tx.referenceTransactionId ?? null,
      relatedTransactionId: null,
      sourceRequestId: tx.sourceRequestId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // The auto-debit job is the only flow that stamps a period on a PAYMENT, so a payment carrying one
    // is a debit it settled from credit the customer deposited. No cash arrived now, so it is announced
    // as the instalment it closed rather than as a payment receipt.
    const autoDebitPeriod = tx.transactionType === TransactionType.PAYMENT ? tx.periodIndex : null;
    if (autoDebitPeriod !== null) {
      await notifyAutoDebitPosted(em, {
        loanId: loan.id,
        customerId: tx.customerId,
        amount: num(tx.amount),
        currency: tx.currency,
        periodIndex: autoDebitPeriod,
        paidAt: tx.postedAt ?? new Date(),
        allocation: allocation ?? zeroComponents(),
        remaining: num(loan.currentOutstanding),
      });
    } else if (
      tx.transactionType === TransactionType.PAYMENT ||
      tx.transactionType === TransactionType.SETTLEMENT_PAYMENT
    ) {
      // Receipt only for money that actually arrived from the customer.
      await notifyPaymentPosted(em, {
        loanId: loan.id,
        customerId: tx.customerId,
        amount: num(tx.amount),
        currency: tx.currency,
        paidAt: tx.postedAt ?? new Date(),
        allocation,
        remaining: num(loan.currentOutstanding),
      });
    }

    // Money no instalment could absorb is the customer's credit, not settled debt: the notice above
    // only speaks for what it cleared, so the remainder needs a receipt of its own.
    if (excess > EPS) {
      await notifyCreditDeposited(em, {
        loanId: loan.id,
        customerId: tx.customerId,
        amount: excess,
        currency: tx.currency,
        depositedAt: tx.postedAt ?? new Date(),
        note: tx.reason,
      });
    }

    // Movements that change what the customer owes under an authority. Approval of a non-disbursement
    // subject makes no decision mail, so posting is the point these reach the customer and the staff
    // who released it.
    if (tx.transactionType === TransactionType.PENALTY) {
      await notifyPenaltyPosted(em, {
        loanId: loan.id,
        amount: num(tx.amount),
        currency: tx.currency,
        postedAt: tx.postedAt ?? new Date(),
        reason: tx.reason,
      });
    }
    if (tx.transactionType === TransactionType.WAIVER) {
      await notifyWaiverPosted(em, {
        loanId: loan.id,
        amount: num(tx.amount),
        currency: tx.currency,
        components: allocation ?? zeroComponents(),
        postedAt: tx.postedAt ?? new Date(),
        reason: tx.reason,
      });
    }
    if (tx.transactionType === TransactionType.WRITE_OFF) {
      await notifyWriteOffPosted(em, {
        loanId: loan.id,
        amount: num(tx.amount),
        currency: tx.currency,
        components: allocation ?? zeroComponents(),
        postedAt: tx.postedAt ?? new Date(),
        reason: tx.reason,
      });
    }

    if (newStatus !== previousStatus) {
      await writeAudit(em, {
        action: 'LOAN_STATUS_CHANGED',
        transactionId: tx.id,
        transactionType: tx.transactionType,
        loanId: loan.id,
        customerId: loan.customerId,
        userId: ctx.actorId,
        previousStatus,
        newStatus,
        previousBalance,
        newBalance,
        amount: num(tx.amount),
        currency: tx.currency,
        makerUserId: tx.createdBy,
        checkerUserId: approvers.checkerUserId,
        headApproverUserId: approvers.headApproverUserId,
        adminUserId: approvers.adminUserId,
        reason: `Driven by posted ${tx.transactionType} ${tx.referenceNo}`,
        referenceTransactionId: tx.referenceTransactionId ?? null,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      });
    }

    return {
      transaction: tx,
      loan,
      previousStatus,
      newStatus,
      allocation,
      excess,
    };
  });
}
