import { EntityManager } from 'typeorm';
import { writeAudit } from './audit.service';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep as StepEntity } from '../entities/approval-step.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { SystemConfig } from '../entities/system-config.entity';
import {
  ApprovalLevel,
  ApprovalSubjectType,
  SettlementStatus,
  StepStatus,
  TransactionStatus,
  TransactionType,
  WorkflowStatus,
} from '../entities/types';
import { AuthUser, canDecideLevel } from '../middleware/auth';
import { AppError, badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num } from '../utils/money';
import { notifyLoanDecision, notifySettlementDecision } from './notification-events.service';

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
}

export async function createWorkflow(em: EntityManager, input: CreateWorkflowInput): Promise<ApprovalWorkflow> {
  const thresholds = await getThresholds(em);
  const requiredLevels = computeRequiredLevels(input.amount, thresholds);
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

/**
 * Decides one approval step. Rejection stops the whole workflow.
 * Final approval moves the subject to APPROVED — posting is a separate,
 * validated step (LOCKED sections 21, 22).
 */
export async function decideStep(em: EntityManager, input: DecideStepInput): Promise<ApprovalWorkflow> {
  const step = await em.findOne(StepEntity, { where: { id: input.stepId } });
  if (!step) throw notFound('Approval step not found');
  if (step.status !== StepStatus.PENDING) throw new AppError(409, 'This approval step has already been decided');

  const workflow = await em.findOne(ApprovalWorkflow, { where: { id: step.workflowId } });
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
    } else {
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
    } else {
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
    }
  } else {
    workflow.currentLevelIndex = workflow.currentLevelIndex + 1;
    await em.save(workflow);
  }

  return workflow;
}
