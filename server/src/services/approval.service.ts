import { EntityManager } from 'typeorm';
import { writeAudit } from './audit.service';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep as StepEntity } from '../entities/approval-step.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { RestructureRequest } from '../entities/restructure-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { SystemConfig } from '../entities/system-config.entity';
import {
  ApprovalLevel,
  ApprovalSubjectType,
  RestructureStatus,
  SettlementStatus,
  StepStatus,
  TransactionStatus,
  TransactionType,
  WorkflowStatus,
} from '../entities/types';
import { AuthUser, canDecideLevel } from '../middleware/auth';
import { AppError, badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num } from '../utils/money';
import {
  notifyLoanDecision,
  notifyRestructureDecision,
  notifySettlementDecision,
} from './notification-events.service';

export const CONFIG_CHECKER_THRESHOLD = 'approval.checkerThreshold';
export const CONFIG_HEAD_THRESHOLD = 'approval.headThreshold';

export const DEFAULT_CHECKER_THRESHOLD = 1_000_000;
export const DEFAULT_HEAD_THRESHOLD = 10_000_000;

/**
 * The ONE global approval threshold configuration (LOCKED section 12).
 * Every module reads it from here — no module-specific overrides.
 */
export async function getThresholds(em: EntityManager): Promise<{ checkerThreshold: number; headThreshold: number }> {
  const configs = await em.find(SystemConfig);
  const map = new Map(configs.map((c) => [c.key, c]));
  const checker = map.get(CONFIG_CHECKER_THRESHOLD);
  const head = map.get(CONFIG_HEAD_THRESHOLD);
  return {
    checkerThreshold: checker ? num(checker.value) : DEFAULT_CHECKER_THRESHOLD,
    headThreshold: head ? num(head.value) : DEFAULT_HEAD_THRESHOLD,
  };
}

/**
 * The largest threshold the API accepts. `Number.MAX_SAFE_INTEGER` is below the DECIMAL(18,2)
 * capacity every money column has, so a value inside this bound is stored exactly as sent —
 * going higher would let a request silently round on its way through a JavaScript number.
 */
export const MAX_APPROVAL_THRESHOLD = Number.MAX_SAFE_INTEGER;

export interface ApprovalThresholds {
  checkerThreshold: number;
  headThreshold: number;
}

/**
 * Writes the central approval thresholds (LOCKED section 12) through the caller's transaction,
 * the same way the KYC and password policies are written: both rows and the audit row land
 * together or not at all, because a half-applied pair decides which amounts skip an approval
 * level — `checker > head` means every large amount stops needing the Head it still needs.
 */
export async function updateThresholds(
  em: EntityManager,
  input: ApprovalThresholds,
  userId: string,
): Promise<{ previous: ApprovalThresholds; updated: ApprovalThresholds }> {
  const previous = await getThresholds(em);
  const checker = num(input.checkerThreshold);
  const head = num(input.headThreshold);
  if (head < checker) {
    throw badRequest('Head threshold must be greater than or equal to the checker threshold');
  }

  const rows: Array<[string, number, string]> = [
    [CONFIG_CHECKER_THRESHOLD, checker, 'Amounts at or below this need Maker -> Checker only'],
    [CONFIG_HEAD_THRESHOLD, head, 'Amounts above this also need Head and Admin final approval'],
  ];
  for (const [key, value, description] of rows) {
    const existing = await em.findOne(SystemConfig, { where: { key } });
    if (existing) {
      existing.value = value;
      existing.updatedBy = userId;
      existing.description = description;
      await em.save(SystemConfig, existing);
    } else {
      await em.save(
        SystemConfig,
        em.create(SystemConfig, { key, value, updatedBy: userId, description }),
      );
    }
  }

  return { previous, updated: await getThresholds(em) };
}

/**
 * Approval levels by amount (LOCKED section 12):
 *   <= checkerThreshold                       -> Maker -> Checker
 *   > checkerThreshold and <= headThreshold   -> Maker -> Checker -> Head
 *   > headThreshold                           -> Maker -> Checker -> Head -> Admin (final)
 */
export function computeRequiredLevels(
  amount: number,
  thresholds: { checkerThreshold: number; headThreshold: number },
): ApprovalLevel[] {
  const value = num(amount);
  if (value <= thresholds.checkerThreshold + EPS) return [ApprovalLevel.CHECKER];
  if (value <= thresholds.headThreshold + EPS) return [ApprovalLevel.CHECKER, ApprovalLevel.HEAD];
  return [ApprovalLevel.CHECKER, ApprovalLevel.HEAD, ApprovalLevel.ADMIN];
}

export interface CreateWorkflowInput {
  subjectType: ApprovalSubjectType;
  subjectId: string;
  amount: number;
  makerUserId: string;
  currency?: string;
  /**
   * Levels this decision needs whatever the amount says. A hardship addendum is a change to a signed
   * contract, so it always needs a Checker and a Head; the amount can only add a level above that.
   */
  minimumLevels?: ApprovalLevel[];
}

const LEVEL_ORDER: ApprovalLevel[] = [ApprovalLevel.CHECKER, ApprovalLevel.HEAD, ApprovalLevel.ADMIN];

/** The union of the amount-driven levels and any forced ones, kept in approval order. */
function withMinimumLevels(levels: ApprovalLevel[], minimum?: ApprovalLevel[]): ApprovalLevel[] {
  if (!minimum || minimum.length === 0) return levels;
  return LEVEL_ORDER.filter((level) => levels.includes(level) || minimum.includes(level));
}

export async function createWorkflow(em: EntityManager, input: CreateWorkflowInput): Promise<ApprovalWorkflow> {
  const thresholds = await getThresholds(em);
  const requiredLevels = withMinimumLevels(computeRequiredLevels(input.amount, thresholds), input.minimumLevels);
  const workflow = em.create(ApprovalWorkflow, {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    requiredLevels,
    currentLevelIndex: 0,
  });
  const saved = await em.save(ApprovalWorkflow, workflow);
  for (const level of requiredLevels) {
    await em.save(StepEntity, em.create(StepEntity, { workflowId: saved.id, level }));
  }
  return saved;
}

export interface DecideStepInput {
  stepId: string;
  user: AuthUser;
  decision: 'APPROVE' | 'REJECT';
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
}

interface SubjectInfo {
  makerUserId: string;
  loanId?: string | null;
  customerId?: string | null;
  amount: number;
  currency: string;
  description: string;
}

async function loadSubject(em: EntityManager, workflow: ApprovalWorkflow): Promise<SubjectInfo> {
  if (workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION) {
    const tx = await em.findOne(FinancialTransaction, { where: { id: workflow.subjectId } });
    if (!tx) throw notFound('Financial transaction not found');
    return {
      makerUserId: tx.createdBy,
      loanId: tx.loanId,
      customerId: tx.customerId,
      amount: num(tx.amount),
      currency: tx.currency,
      description: `transaction ${tx.referenceNo} (${tx.transactionType})`,
    };
  }
  if (workflow.subjectType === ApprovalSubjectType.SETTLEMENT_AGREEMENT) {
    const agreement = await em.findOne(SettlementAgreement, { where: { id: workflow.subjectId } });
    if (!agreement) throw notFound('Settlement agreement not found');
    return {
      makerUserId: agreement.createdBy,
      loanId: agreement.loanId,
      customerId: agreement.customerId,
      amount: num(agreement.agreedAmount),
      currency: agreement.currency,
      description: `settlement agreement ${agreement.agreementNo}`,
    };
  }
  const request = await em.findOne(RestructureRequest, { where: { id: workflow.subjectId } });
  if (!request) throw notFound('Restructure request not found');
  return {
    makerUserId: request.createdBy,
    loanId: request.loanId,
    customerId: request.customerId,
    // The decision is priced on what the loan still owes, not on the relief alone: re-papering a
    // large contract is a large decision even when the waiver written on it is small.
    amount: request.repricingAmount,
    currency: request.currency,
    description: `hardship addendum ${request.requestNo}`,
  };
}

/**
 * Decides one approval step. Rejection stops the whole workflow.
 * Final approval moves the subject to APPROVED — posting is a separate,
 * validated step (LOCKED sections 21, 22).
 */
export async function decideStep(em: EntityManager, input: DecideStepInput): Promise<ApprovalWorkflow> {
  // Both rows are locked before anything is read: without this, two checkers clicking the same
  // step at the same time each see PENDING and both write an approval (F-CONC-3).
  const step = await em.findOne(StepEntity, { where: { id: input.stepId }, lock: { mode: 'pessimistic_write' } });
  if (!step) throw notFound('Approval step not found');
  if (step.status !== StepStatus.PENDING) throw new AppError(409, 'This approval step has already been decided');

  const workflow = await em.findOne(ApprovalWorkflow, {
    where: { id: step.workflowId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!workflow) throw notFound('Approval workflow not found');
  if (workflow.status !== WorkflowStatus.PENDING) throw new AppError(409, 'This approval workflow is already closed');

  const requiredLevel = workflow.requiredLevels[workflow.currentLevelIndex];
  if (step.level !== requiredLevel) {
    throw new AppError(409, `This step is not the current level; waiting for ${requiredLevel}`);
  }
  if (!canDecideLevel(input.user, step.level)) {
    throw new AppError(403, `Your role cannot decide a ${step.level} approval step`);
  }

  const subject = await loadSubject(em, workflow);
  if (subject.makerUserId === input.user.id) {
    throw unprocessable('Maker-Checker separation: the maker cannot approve their own request');
  }
  if (input.decision === 'REJECT' && !input.reason?.trim()) {
    throw badRequest('A rejection reason is required');
  }

  const base = {
    subjectId: workflow.subjectId,
    loanId: subject.loanId ?? null,
    customerId: subject.customerId ?? null,
    userId: input.user.id,
    reason: input.reason ?? null,
    amount: subject.amount,
    currency: subject.currency,
    makerUserId: subject.makerUserId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  };

  step.userId = input.user.id;
  step.reason = input.reason ?? null;
  step.decidedAt = new Date();

  if (input.decision === 'REJECT') {
    step.status = StepStatus.REJECTED;
    workflow.status = WorkflowStatus.REJECTED;
    workflow.completedAt = new Date();
    await em.save([step, workflow]);

    if (workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION) {
      const tx = await em.findOneByOrFail(FinancialTransaction, { id: workflow.subjectId });
      tx.status = TransactionStatus.REJECTED;
      tx.rejectionReason = input.reason ?? 'Rejected in approval workflow';
      await em.save(FinancialTransaction, tx);
      // Only a refused loan application is a customer-facing decision; other
      // rejected drafts never reached the customer.
      if (tx.transactionType === TransactionType.DISBURSEMENT) {
        await notifyLoanDecision(em, {
          loanId: tx.loanId,
          customerId: tx.customerId,
          amount: num(tx.amount),
          currency: tx.currency,
          approved: false,
          reason: tx.rejectionReason,
        });
      }
    } else if (workflow.subjectType === ApprovalSubjectType.SETTLEMENT_AGREEMENT) {
      const agreement = await em.findOneByOrFail(SettlementAgreement, { id: workflow.subjectId });
      agreement.status = SettlementStatus.REJECTED;
      agreement.decidedBy = input.user.id;
      agreement.decidedAt = new Date();
      agreement.decisionReason = input.reason ?? null;
      await em.save(SettlementAgreement, agreement);
      await notifySettlementDecision(em, {
        loanId: agreement.loanId,
        customerId: agreement.customerId,
        agreedAmount: num(agreement.agreedAmount),
        currency: agreement.currency,
        approved: false,
        reason: agreement.decisionReason,
        decidedAt: agreement.decidedAt,
      });
    } else {
      const request = await em.findOneByOrFail(RestructureRequest, { id: workflow.subjectId });
      request.status = RestructureStatus.REJECTED;
      request.decidedBy = input.user.id;
      request.decidedAt = new Date();
      request.decisionReason = input.reason ?? null;
      await em.save(RestructureRequest, request);
      await notifyRestructureDecision(em, {
        loanId: request.loanId,
        requestNo: request.requestNo,
        approved: false,
        reason: request.decisionReason,
        makerUserId: request.createdBy,
      });
      // Nothing was written to the ledger and no term was touched — a refused addendum leaves the
      // contract exactly as it stands. The APPROVAL_STEP_REJECTED row below carries the decision.
    }

    await writeAudit(em, {
      ...base,
      action: 'APPROVAL_STEP_REJECTED',
      previousStatus: 'PENDING_APPROVAL',
      newStatus: 'REJECTED',
    });
    return workflow;
  }

  step.status = StepStatus.APPROVED;
  await em.save(step);

  await writeAudit(em, {
    ...base,
    action: 'APPROVAL_STEP_APPROVED',
    transactionId: workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION ? workflow.subjectId : null,
    transactionType:
      workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION
        ? (await em.findOneBy(FinancialTransaction, { id: workflow.subjectId }))?.transactionType ?? null
        : null,
    previousStatus: 'PENDING_APPROVAL',
    newStatus: 'PENDING_APPROVAL',
  });

  const isLastLevel = workflow.currentLevelIndex >= workflow.requiredLevels.length - 1;
  if (isLastLevel) {
    workflow.status = WorkflowStatus.APPROVED;
    workflow.completedAt = new Date();
    await em.save(workflow);

    if (workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION) {
      const tx = await em.findOneByOrFail(FinancialTransaction, { id: workflow.subjectId });
      tx.status = TransactionStatus.APPROVED;
      tx.approvedAt = new Date();
      await em.save(FinancialTransaction, tx);
      await writeAudit(em, {
        ...base,
        action: 'TRANSACTION_APPROVED',
        transactionId: tx.id,
        transactionType: tx.transactionType,
        previousStatus: 'PENDING_APPROVAL',
        newStatus: 'APPROVED',
      });
      if (tx.transactionType === TransactionType.DISBURSEMENT) {
        await notifyLoanDecision(em, {
          loanId: tx.loanId,
          customerId: tx.customerId,
          amount: num(tx.amount),
          currency: tx.currency,
          approved: true,
          reason: input.reason ?? null,
        });
      }
    } else if (workflow.subjectType === ApprovalSubjectType.SETTLEMENT_AGREEMENT) {
      const agreement = await em.findOneByOrFail(SettlementAgreement, { id: workflow.subjectId });
      agreement.status = SettlementStatus.APPROVED;
      agreement.decidedBy = input.user.id;
      agreement.decidedAt = new Date();
      agreement.decisionReason = input.reason ?? null;
      await em.save(SettlementAgreement, agreement);
      await writeAudit(em, {
        ...base,
        action: 'SETTLEMENT_AGREEMENT_APPROVED',
        previousStatus: 'PENDING_APPROVAL',
        newStatus: 'APPROVED',
      });
      await notifySettlementDecision(em, {
        loanId: agreement.loanId,
        customerId: agreement.customerId,
        agreedAmount: num(agreement.agreedAmount),
        currency: agreement.currency,
        approved: true,
        reason: agreement.decisionReason,
        decidedAt: agreement.decidedAt,
      });
    } else {
      const request = await em.findOneByOrFail(RestructureRequest, { id: workflow.subjectId });
      request.status = RestructureStatus.APPROVED;
      request.decidedBy = input.user.id;
      request.decidedAt = new Date();
      request.decisionReason = input.reason ?? null;
      await em.save(RestructureRequest, request);
      await writeAudit(em, {
        ...base,
        action: 'RESTRUCTURE_REQUEST_APPROVED',
        previousStatus: RestructureStatus.PENDING_APPROVAL,
        newStatus: RestructureStatus.APPROVED,
        reason:
          `Addendum ${request.requestNo} approved` +
          `${input.reason ? `: ${input.reason}` : ''} — the loan keeps its current terms until staff apply it`,
      });
      await notifyRestructureDecision(em, {
        loanId: request.loanId,
        requestNo: request.requestNo,
        approved: true,
        reason: request.decisionReason,
        makerUserId: request.createdBy,
      });
    }
  } else {
    workflow.currentLevelIndex = workflow.currentLevelIndex + 1;
    await em.save(workflow);
  }

  return workflow;
}
