import { EntityManager } from 'typeorm';
import { getDataSource } from '../datasource';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep } from '../entities/approval-step.entity';
import { CreditLedger } from '../entities/credit-ledger.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { PaymentAllocation } from '../entities/payment-allocation.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import {
  ApprovalLevel,
  ApprovalSubjectType,
  ComponentAmounts,
  ComponentType,
  CreditLedgerType,
  LoanStatus,
  PaymentRequestStatus,
  StepStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { allocateReversalSequentially, allocateSequentially, validateAllocationOverride, zeroComponents } from './allocation.service';
import { applyDeltas, balanceSnapshot, computeLoanStatusAfterPosting, getBalances } from './loan-balance.service';
import { notifyPaymentPosted } from './notification-events.service';
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
  let credit = await em.findOne(CustomerCredit, { where: { customerId, currency } });
  const balanceBefore = credit ? num(credit.balance) : 0;
  const balanceAfter = round2(balanceBefore + delta);
  if (!credit) {
    credit = em.create(CustomerCredit, { customerId, currency, balance: balanceAfter });
  } else {
    credit.balance = balanceAfter;
  }
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

  const allocations = await em.find(PaymentAllocation, { where: { paymentRequestId: request.id } });
  let allocation: ComponentAmounts;
  if (allocations.some((row) => row.overridden)) {
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
    const credit = await em.findOne(CustomerCredit, { where: { customerId: tx.customerId, currency: tx.currency } });
    const available = credit ? num(credit.balance) : 0;
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
        const delta = zeroComponents();
        delta.PENALTY = round2(num(tx.amount));
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

    // Receipt only for money that actually arrived from the customer.
    if (
      tx.transactionType === TransactionType.PAYMENT ||
      tx.transactionType === TransactionType.SETTLEMENT_PAYMENT
    ) {
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
