import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { ApprovalStep } from '../entities/approval-step.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ApprovalSubjectType,
  ComponentAmounts,
  ComponentType,
  LoanStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { getBalances } from '../services/loan-balance.service';
import { getLoanSchedule } from '../services/loan-schedule.service';
import { describePenaltyPolicy } from '../services/penalty-policy.service';
import { createWorkflow } from '../services/approval.service';
import { adjustmentMagnitude } from '../services/adjustment.service';
import { writeAudit } from '../services/audit.service';
import { nextTransactionNo } from '../services/reference.service';
import { postTransaction } from '../services/posting-engine.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

const componentAmountsSchema = z
  .object({
    PENALTY: z.number().min(0),
    PAST_INTEREST: z.number().min(0),
    PAST_PRINCIPAL: z.number().min(0),
  })
  .optional();

const reversalSchema = z.object({
  referenceTransactionId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().min(1).max(1000),
});

const penaltySchema = z.object({
  loanId: z.string().uuid(),
  amount: z.number().positive(),
  reason: z.string().min(1).max(1000),
});

const penaltyAccrualSchema = z.object({
  loanId: z.string().uuid(),
  asOf: z.string().datetime().optional(),
  reason: z.string().min(1).max(1000).optional(),
});

const waiverSchema = z.object({
  loanId: z.string().uuid(),
  componentAmounts: z
    .object({
      PENALTY: z.number().min(0),
      PAST_INTEREST: z.number().min(0),
      PAST_PRINCIPAL: z.number().min(0),
    }),
  reason: z.string().min(1).max(1000),
});

const writeOffSchema = z.object({
  loanId: z.string().uuid(),
  componentAmounts: componentAmountsSchema,
  reason: z.string().min(1).max(1000),
});

const adjustmentSchema = z.object({
  loanId: z.string().uuid(),
  componentAmounts: z
    .object({
      PENALTY: z.number(),
      PAST_INTEREST: z.number(),
      PAST_PRINCIPAL: z.number(),
    }),
  referenceTransactionId: z.string().uuid().optional(),
  reason: z.string().min(1).max(1000),
});

function normalizeComponents(input: Record<string, number>): ComponentAmounts {
  return {
    PENALTY: num(input.PENALTY),
    PAST_INTEREST: num(input.PAST_INTEREST),
    PAST_PRINCIPAL: num(input.PAST_PRINCIPAL),
  };
}

function sumComponents(c: ComponentAmounts): number {
  return round2(num(c.PENALTY) + num(c.PAST_INTEREST) + num(c.PAST_PRINCIPAL));
}

/** Sum of already-posted reversal lines against an original transaction, per component. */
async function alreadyReversedComponents(
  em: EntityManager,
  originalId: string,
  reversalType: TransactionType,
): Promise<ComponentAmounts> {
  const reversals = await em.find(FinancialTransaction, {
    where: { referenceTransactionId: originalId, transactionType: reversalType, status: TransactionStatus.POSTED },
  });
  const result: ComponentAmounts = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
  for (const reversal of reversals) {
    const lines = await em.find(FinancialTransactionLine, { where: { transactionId: reversal.id } });
    for (const line of lines) {
      result[line.component] = round2(num(result[line.component]) + Math.abs(num(line.amount)));
    }
  }
  return result;
}

async function originalComponents(em: EntityManager, originalId: string): Promise<ComponentAmounts> {
  const lines = await em.find(FinancialTransactionLine, { where: { transactionId: originalId } });
  const result: ComponentAmounts = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
  for (const line of lines) {
    result[line.component] = round2(num(result[line.component]) + Math.abs(num(line.amount)));
  }
  return result;
}

async function assertNoPostedAdjustmentDepends(em: EntityManager, originalId: string): Promise<void> {
  const dependent = await em.find(FinancialTransaction, {
    where: {
      referenceTransactionId: originalId,
      transactionType: TransactionType.ADJUSTMENT,
      status: TransactionStatus.POSTED,
    },
  });
  if (dependent.length > 0) {
    throw unprocessable(
      'A posted adjustment already depends on this transaction. Direct reversal is blocked — use the Adjustment Workflow (locked section 11).',
    );
  }
}

interface CreateTxParams {
  loanId: string;
  transactionType: TransactionType;
  amount: number;
  componentAmounts?: ComponentAmounts | null;
  referenceTransactionId?: string | null;
  sourceRequestId?: string | null;
  settlementAgreementId?: string | null;
  reason: string;
  user: AuthUser;
  ip?: string | null;
  userAgent?: string | null;
}

async function createPendingTransaction(em: EntityManager, params: CreateTxParams) {
  const loan = await em.findOne(Loan, { where: { id: params.loanId } });
  if (!loan) throw notFound('Loan');

  const tx = em.create(FinancialTransaction, {
    referenceNo: await nextTransactionNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    transactionType: params.transactionType,
    status: TransactionStatus.PENDING_APPROVAL,
    amount: round2(params.amount),
    currency: 'LAK',
    componentAmounts: params.componentAmounts ?? null,
    referenceTransactionId: params.referenceTransactionId ?? null,
    sourceRequestId: params.sourceRequestId ?? null,
    settlementAgreementId: params.settlementAgreementId ?? null,
    reason: params.reason,
    createdBy: params.user.id,
  });
  await em.save(FinancialTransaction, tx);

  await createWorkflow(em, {
    subjectType: ApprovalSubjectType.FINANCIAL_TRANSACTION,
    subjectId: tx.id,
    amount: tx.amount,
    makerUserId: params.user.id,
    currency: tx.currency,
  });

  await writeAudit(em, {
    action: 'TRANSACTION_CREATED',
    transactionId: tx.id,
    transactionType: tx.transactionType,
    loanId: loan.id,
    customerId: loan.customerId,
    userId: params.user.id,
    previousStatus: 'DRAFT',
    newStatus: 'PENDING_APPROVAL',
    amount: tx.amount,
    currency: tx.currency,
    makerUserId: params.user.id,
    reason: params.reason,
    referenceTransactionId: params.referenceTransactionId ?? null,
    sourceRequestId: params.sourceRequestId ?? null,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return { transaction: tx, loan };
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, num(String(req.query.page ?? '1')) || 1);
    const limit = Math.min(100, Math.max(1, num(String(req.query.limit ?? '20')) || 20));
    const status = typeof req.query.status === 'string' && req.query.status ? (req.query.status as TransactionStatus) : undefined;
    const type = typeof req.query.type === 'string' && req.query.type ? (req.query.type as TransactionType) : undefined;
    const loanId = typeof req.query.loanId === 'string' && req.query.loanId ? req.query.loanId : undefined;
    const referenceTransactionId =
      typeof req.query.referenceTransactionId === 'string' && req.query.referenceTransactionId
        ? req.query.referenceTransactionId
        : undefined;

    const repo = getDataSource().getRepository(FinancialTransaction);
    const qb = repo.createQueryBuilder('tx');
    if (status) qb.andWhere('tx.status = :status', { status });
    if (type) qb.andWhere('tx.transactionType = :type', { type });
    if (loanId) qb.andWhere('tx.loanId = :loanId', { loanId });
    if (referenceTransactionId) qb.andWhere('tx.referenceTransactionId = :referenceTransactionId', { referenceTransactionId });
    const [transactions, total] = await qb
      .orderBy('tx.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    res.json({ data: transactions, pagination: { page, limit, total } });
  })
);

router.post(
  '/:id/post',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const result = await postTransaction(req.params.id, {
      actorId: user.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    res.json({
      data: {
        transaction: result.transaction,
        loan: result.loan,
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
        allocation: result.allocation,
        excess: result.excess,
      },
    });
  })
);

router.post(
  '/reversals',
  requireRole(...OPERATOR_ROLES),
  validateBody(reversalSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { referenceTransactionId, amount, reason } = req.body;

    const result = await getDataSource().transaction(async (em) => {
      const original = await em.findOne(FinancialTransaction, { where: { id: referenceTransactionId } });
      if (!original) throw notFound('Original transaction');
      if (original.status !== TransactionStatus.POSTED) {
        throw unprocessable(`Original transaction is ${original.status} — only POSTED payments can be reversed`);
      }
      if (original.transactionType !== TransactionType.PAYMENT && original.transactionType !== TransactionType.SETTLEMENT_PAYMENT) {
        throw unprocessable('Only payments and settlement payments can be reversed with a payment reversal');
      }
      await assertNoPostedAdjustmentDepends(em, original.id);

      const originalAllocation = await originalComponents(em, original.id);
      const alreadyReversed = await alreadyReversedComponents(em, original.id, TransactionType.PAYMENT_REVERSAL);
      const remaining: ComponentAmounts = {
        PENALTY: round2(num(originalAllocation.PENALTY) - num(alreadyReversed.PENALTY)),
        PAST_INTEREST: round2(num(originalAllocation.PAST_INTEREST) - num(alreadyReversed.PAST_INTEREST)),
        PAST_PRINCIPAL: round2(num(originalAllocation.PAST_PRINCIPAL) - num(alreadyReversed.PAST_PRINCIPAL)),
      };
      if (sumComponents(remaining) + EPS < num(amount)) {
        throw unprocessable(
          `Reversal amount (${round2(num(amount))}) exceeds remaining reversible allocation (${sumComponents(remaining)})`,
        );
      }

      return createPendingTransaction(em, {
        loanId: original.loanId,
        transactionType: TransactionType.PAYMENT_REVERSAL,
        amount: num(amount),
        referenceTransactionId: original.id,
        sourceRequestId: original.sourceRequestId,
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });

    res.status(201).json({ data: result });
  })
);

router.post(
  '/penalties',
  requireRole(...OPERATOR_ROLES),
  validateBody(penaltySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, amount, reason } = req.body;
    const result = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      if (loan.status === LoanStatus.CLOSED) {
        throw unprocessable('Cannot add penalty to a CLOSED loan');
      }
      return createPendingTransaction(em, {
        loanId,
        transactionType: TransactionType.PENALTY,
        amount: num(amount),
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
    res.status(201).json({ data: result });
  })
);

/**
 * Same PENALTY transaction as the manual route, but the amount comes from the loan's own
 * penalty policy snapshot. Still PENDING_APPROVAL — the accrual never moves a balance by itself.
 */
router.post(
  '/penalties/accrue',
  requireRole(...OPERATOR_ROLES),
  validateBody(penaltyAccrualSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId } = req.body;
    const asOf = typeof req.body.asOf === 'string' && req.body.asOf ? new Date(req.body.asOf) : new Date();
    if (Number.isNaN(asOf.getTime())) throw badRequest('asOf must be a valid date');

    const result = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      if (loan.status === LoanStatus.CLOSED) {
        throw unprocessable('Cannot add penalty to a CLOSED loan');
      }
      const schedule = await getLoanSchedule(em, loanId, asOf);
      if (schedule.totals.penaltySuggested <= EPS) {
        throw unprocessable(
          'No penalty left to charge — the accrued penalty is already billed or waived',
        );
      }
      const created = await createPendingTransaction(em, {
        loanId,
        transactionType: TransactionType.PENALTY,
        amount: schedule.totals.penaltySuggested,
        reason:
          req.body.reason ??
          `Penalty accrual (${describePenaltyPolicy(schedule.penaltyPolicy)}) up to ` +
            `${asOf.toISOString().slice(0, 10)} — ${schedule.aging.overduePeriods} overdue period(s)`,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      return { ...created, schedule };
    });

    res.status(201).json({ data: result });
  })
);

router.post(
  '/waivers',
  requireRole(...OPERATOR_ROLES),
  validateBody(waiverSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, componentAmounts, reason } = req.body;
    const components = normalizeComponents(componentAmounts);
    if (sumComponents(components) <= EPS) throw badRequest('Waiver must waive at least one component');

    const result = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      const outstanding = getBalances(loan);
      for (const component of Object.values(ComponentType)) {
        if (num(components[component]) - num(outstanding[component]) > EPS) {
          throw unprocessable(
            `Waiver for ${component} (${round2(num(components[component]))}) exceeds outstanding (${num(outstanding[component])})`,
          );
        }
      }
      return createPendingTransaction(em, {
        loanId,
        transactionType: TransactionType.WAIVER,
        amount: sumComponents(components),
        componentAmounts: components,
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
    res.status(201).json({ data: result });
  })
);

router.post(
  '/write-offs',
  requireRole(...OPERATOR_ROLES),
  validateBody(writeOffSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, componentAmounts, reason } = req.body;

    const result = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      if (loan.status !== LoanStatus.ACTIVE) {
        throw unprocessable(`Loan is ${loan.status} — only ACTIVE loans can be written off`);
      }
      // Without explicit components, write off the full outstanding (locked section 18).
      const components = componentAmounts
        ? normalizeComponents(componentAmounts)
        : { PENALTY: num(loan.outstandingPenalty), PAST_INTEREST: num(loan.outstandingPastInterest), PAST_PRINCIPAL: num(loan.outstandingPastPrincipal) };
      if (sumComponents(components) <= EPS) throw badRequest('Write-off amount must be greater than zero');

      const outstanding = getBalances(loan);
      for (const component of Object.values(ComponentType)) {
        if (num(components[component]) - num(outstanding[component]) > EPS) {
          throw unprocessable(
            `Write-off for ${component} (${round2(num(components[component]))}) exceeds outstanding (${num(outstanding[component])})`,
          );
        }
      }
      return createPendingTransaction(em, {
        loanId,
        transactionType: TransactionType.WRITE_OFF,
        amount: sumComponents(components),
        componentAmounts: components,
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
    res.status(201).json({ data: result });
  })
);

router.post(
  '/write-off-reversals',
  requireRole(...OPERATOR_ROLES),
  validateBody(reversalSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { referenceTransactionId, amount, reason } = req.body;

    const result = await getDataSource().transaction(async (em) => {
      const original = await em.findOne(FinancialTransaction, { where: { id: referenceTransactionId } });
      if (!original) throw notFound('Original write-off transaction');
      if (original.status !== TransactionStatus.POSTED) {
        throw unprocessable(`Original write-off is ${original.status}`);
      }
      if (original.transactionType !== TransactionType.WRITE_OFF) {
        throw unprocessable('Reference transaction is not a write-off');
      }
      const originalAllocation = await originalComponents(em, original.id);
      const alreadyReversed = await alreadyReversedComponents(em, original.id, TransactionType.WRITE_OFF_REVERSAL);
      const remaining: ComponentAmounts = {
        PENALTY: round2(num(originalAllocation.PENALTY) - num(alreadyReversed.PENALTY)),
        PAST_INTEREST: round2(num(originalAllocation.PAST_INTEREST) - num(alreadyReversed.PAST_INTEREST)),
        PAST_PRINCIPAL: round2(num(originalAllocation.PAST_PRINCIPAL) - num(alreadyReversed.PAST_PRINCIPAL)),
      };
      if (sumComponents(remaining) + EPS < num(amount)) {
        throw unprocessable(
          `Write-off reversal amount (${round2(num(amount))}) exceeds remaining reversible amount (${sumComponents(remaining)})`,
        );
      }
      return createPendingTransaction(em, {
        loanId: original.loanId,
        transactionType: TransactionType.WRITE_OFF_REVERSAL,
        amount: num(amount),
        referenceTransactionId: original.id,
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });

    res.status(201).json({ data: result });
  })
);

router.post(
  '/adjustments',
  requireRole(...OPERATOR_ROLES),
  validateBody(adjustmentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, componentAmounts, referenceTransactionId, reason } = req.body;
    const components = normalizeComponents(componentAmounts);
    const magnitude = adjustmentMagnitude(components);
    if (magnitude < EPS) throw badRequest('Adjustment must change at least one component');

    const result = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      const outstanding = getBalances(loan);
      for (const component of Object.values(ComponentType)) {
        const resulting = round2(num(outstanding[component]) + num(components[component]));
        if (resulting < -EPS) {
          throw unprocessable(`Adjustment would make ${component} outstanding negative (${resulting})`);
        }
      }
      return createPendingTransaction(em, {
        loanId,
        transactionType: TransactionType.ADJUSTMENT,
        amount: magnitude,
        componentAmounts: components,
        referenceTransactionId: referenceTransactionId ?? null,
        reason,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });
    res.status(201).json({ data: result });
  })
);

/** Waiver of the remaining settlement shortfall — separate transaction, own approval (locked section 16). */
export async function createWaiverFromSettlement(
  em: EntityManager,
  params: {
    loan: Loan;
    settlementAgreementId: string;
    components: ComponentAmounts;
    reason: string;
    user: AuthUser;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  return createPendingTransaction(em, {
    loanId: params.loan.id,
    transactionType: TransactionType.WAIVER,
    amount: round2(
      num(params.components.PENALTY) + num(params.components.PAST_INTEREST) + num(params.components.PAST_PRINCIPAL),
    ),
    componentAmounts: params.components,
    settlementAgreementId: params.settlementAgreementId,
    reason: params.reason,
    user: params.user,
    ip: params.ip,
    userAgent: params.userAgent,
  });
}

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const tx = await em.findOne(FinancialTransaction, { where: { id: req.params.id } });
    if (!tx) throw notFound('Financial transaction');

    const [lines, workflow] = await Promise.all([
      em.find(FinancialTransactionLine, { where: { transactionId: tx.id } }),
      em.findOne(ApprovalWorkflow, {
        where: { subjectId: tx.id, subjectType: ApprovalSubjectType.FINANCIAL_TRANSACTION },
      }),
    ]);
    const steps = workflow
      ? await em.find(ApprovalStep, { where: { workflowId: workflow.id } })
      : [];
    const settlement = tx.settlementAgreementId
      ? await em.findOne(SettlementAgreement, { where: { id: tx.settlementAgreementId } })
      : null;

    res.json({ data: { transaction: tx, lines, workflow, steps, settlement } });
  })
);

export default router;
