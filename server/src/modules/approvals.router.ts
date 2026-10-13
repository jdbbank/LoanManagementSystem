import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep } from '../entities/approval-step.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
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

      let subject:
        | { kind: 'TRANSACTION'; transaction: FinancialTransaction }
        | { kind: 'SETTLEMENT_AGREEMENT'; agreement: SettlementAgreement }
        | null = null;
      if (workflow.subjectType === ApprovalSubjectType.FINANCIAL_TRANSACTION) {
        const tx = await em.findOne(FinancialTransaction, { where: { id: workflow.subjectId } });
        if (tx) subject = { kind: 'TRANSACTION', transaction: tx };
      } else {
        const agreement = await em.findOne(SettlementAgreement, { where: { id: workflow.subjectId } });
        if (agreement) subject = { kind: 'SETTLEMENT_AGREEMENT', agreement };
      }
      const makerUserId = subject
        ? subject.kind === 'TRANSACTION'
          ? subject.transaction.createdBy
          : subject.agreement.createdBy
        : null;

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
        amount: subject
          ? subject.kind === 'TRANSACTION'
            ? num(subject.transaction.amount)
            : num(subject.agreement.agreedAmount)
          : 0,
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
