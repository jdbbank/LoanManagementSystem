import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep } from '../entities/approval-step.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { RestructureRequest } from '../entities/restructure-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { WorkflowStatus, ApprovalSubjectType, StepStatus, UserRole } from '../entities/types';
import { AuthUser, canDecideLevel, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';
import { num } from '../utils/money';
import { decideStep } from '../services/approval.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

const decisionSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().max(1000).optional(),
});

const bulkDecisionSchema = decisionSchema.extend({
  stepIds: z.array(z.string().uuid()).min(1).max(200),
});

type QueueSubject =
  | { kind: 'TRANSACTION'; transaction: FinancialTransaction }
  | { kind: 'SETTLEMENT_AGREEMENT'; agreement: SettlementAgreement }
  | { kind: 'RESTRUCTURE_REQUEST'; request: RestructureRequest };

/**
 * Who drafted this decision and what it is worth, so the queue can grey out the maker's own row and
 * show the amount the approval level was computed from. A missing subject has no maker, which is why
 * the queue still lists it: an orphaned workflow must be visible rather than silently unapprovable.
 */
function describeSubject(subject: QueueSubject | null): { makerUserId: string | null; amount: number } {
  if (!subject) return { makerUserId: null, amount: 0 };
  if (subject.kind === 'TRANSACTION') {
    return { makerUserId: subject.transaction.createdBy, amount: num(subject.transaction.amount) };
  }
  if (subject.kind === 'SETTLEMENT_AGREEMENT') {
    return { makerUserId: subject.agreement.createdBy, amount: num(subject.agreement.agreedAmount) };
  }
  return { makerUserId: subject.request.createdBy, amount: num(subject.request.repricingAmount) };
}

router.get(
  '/pending',
  requireRole(UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const em = getDataSource().manager;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));

    const [workflows, total] = await em.getRepository(ApprovalWorkflow).findAndCount({
      where: { status: WorkflowStatus.PENDING },
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    if (workflows.length === 0) {
      return res.json({ data: [], pagination: { page, limit, total } });
    }

    const steps = await em.find(ApprovalStep, {
      where: { workflowId: In(workflows.map((w) => w.id)) },
    });

    const items = [];
    for (const workflow of workflows) {
      const requiredLevel = workflow.requiredLevels[workflow.currentLevelIndex];
      const currentStep = steps.find(
        (s) => s.workflowId === workflow.id && s.level === requiredLevel && s.status === StepStatus.PENDING,
      );
      if (!currentStep) continue;

      let subject: QueueSubject | null = null;
      if (workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION) {
        const tx = await em.findOne(FinancialTransaction, { where: { id: workflow.subjectId } });
        if (tx) subject = { kind: 'TRANSACTION', transaction: tx };
      } else if (workflow.subjectType === ApprovalSubjectType.SETTLEMENT_AGREEMENT) {
        const agreement = await em.findOne(SettlementAgreement, { where: { id: workflow.subjectId } });
        if (agreement) subject = { kind: 'SETTLEMENT_AGREEMENT', agreement };
      } else {
        const request = await em.findOne(RestructureRequest, { where: { id: workflow.subjectId } });
        if (request) subject = { kind: 'RESTRUCTURE_REQUEST', request };
      }

      const { makerUserId, amount } = describeSubject(subject);
      const isMaker = makerUserId === user.id;
      const canDecide = !isMaker && canDecideLevel(user, requiredLevel);

      items.push({
        workflowId: workflow.id,
        stepId: currentStep.id,
        subjectType: workflow.subjectType,
        subjectId: workflow.subjectId,
        currentLevel: requiredLevel,
        remainingLevels: workflow.requiredLevels.slice(workflow.currentLevelIndex),
        canDecide,
        blockedForUser: isMaker,
        amount,
        subject,
      });
    }

    res.json({ data: items, pagination: { page, limit, total } });
  })
);

router.post(
  '/steps/:stepId/decision',
  requireRole(UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(decisionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { decision, reason } = req.body;

    const result = await getDataSource().transaction(async (em) =>
      decideStep(em, {
        stepId: req.params.stepId,
        user,
        decision,
        reason,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    const em = getDataSource().manager;
    const steps = await em.find(ApprovalStep, { where: { workflowId: result.id } });
    res.json({ data: { workflow: result, steps } });
  })
);

/**
 * Decides a queue of steps in one click — a monthly interest run can otherwise mean clicking
 * through every loan of the portfolio. Every item still goes through the same decideStep rules:
 * the maker cannot approve their own charge, the level must be the current one, and a rejection
 * needs a reason. Each step is its own database transaction, so one blocked item cannot stop the
 * rest of the queue and the response says exactly why each one did or did not move.
 */
router.post(
  '/steps/bulk-decision',
  requireRole(UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(bulkDecisionSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { stepIds, decision, reason } = req.body as z.infer<typeof bulkDecisionSchema>;

    const results: Array<{
      stepId: string;
      ok: boolean;
      workflowId?: string;
      subjectId?: string;
      error?: string;
    }> = [];

    for (const stepId of stepIds) {
      try {
        const workflow = await getDataSource().transaction(async (em) =>
          decideStep(em, { stepId, user, decision, reason, ip: req.ip, userAgent: req.headers['user-agent'] }),
        );
        results.push({ stepId, ok: true, workflowId: workflow.id, subjectId: workflow.subjectId });
      } catch (err) {
        results.push({
          stepId,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const decided = results.filter((r) => r.ok).length;
    res.json({
      data: {
        requested: stepIds.length,
        decided,
        declined: stepIds.length - decided,
        results,
      },
    });
  })
);

router.get(
  '/workflows/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const workflow = await em.findOne(ApprovalWorkflow, { where: { id: req.params.id } });
    if (!workflow) throw notFound('Approval workflow');
    const steps = await em.find(ApprovalStep, { where: { workflowId: workflow.id } });
    res.json({ data: { workflow, steps } });
  })
);

export default router;
