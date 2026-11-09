import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { Loan } from '../entities/loan.entity';
import { RestructureRequest } from '../entities/restructure-request.entity';
import { RestructureChangeType, RestructureStatus } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';
import { num } from '../utils/money';
import {
  applyRestructure,
  createRestructureRequest,
  loadRestructureContext,
  restructureState,
} from '../services/restructure.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

const createRequestSchema = z.object({
  loanId: z.string().uuid(),
  hardshipReason: z.string().min(10, 'Explain why this borrower can no longer pay as contracted').max(2000),
  changeTypes: z
    .enum([
      RestructureChangeType.INTEREST_RATE_REDUCTION,
      RestructureChangeType.TERM_EXTENSION,
      RestructureChangeType.PAYER_CHANGE,
      RestructureChangeType.INTEREST_RELIEF,
    ])
    .array()
    .min(1),
  newInterestRate: z.number().positive().nullable().optional(),
  newTermMonths: z.number().int().positive().nullable().optional(),
  newPayerCustomerId: z.string().uuid().nullable().optional(),
  interestReliefAmount: z.number().min(0).optional(),
});

const proposedPayerSchema = z.object({
  newPayerCustomerId: z.string().uuid({ message: 'Choose the customer who would take over the payments' }),
});

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const loanId = typeof req.query.loanId === 'string' && req.query.loanId ? req.query.loanId : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as RestructureStatus)
        : undefined;

    const qb = getDataSource().getRepository(RestructureRequest).createQueryBuilder('request');
    if (loanId) qb.andWhere('request.loanId = :loanId', { loanId });
    if (status) qb.andWhere('request.status = :status', { status });
    const [requests, total] = await qb
      .orderBy('request.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    res.json({ data: requests, pagination: { page, limit, total } });
  })
);

/**
 * What the loan looks like to a hardship decision right now, before anyone writes paper: the balance,
 * the security against it, and the terms on file. Reads only, so a branch can see whether an addendum
 * would even pass the collateral rule before spending a maker-checker queue on it.
 */
router.get(
  '/context/:loanId',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const loan = await em.findOne(Loan, { where: { id: req.params.loanId } });
    if (!loan) throw notFound('Loan');

    const payerCustomerId =
      typeof req.query.payerCustomerId === 'string' && req.query.payerCustomerId
        ? req.query.payerCustomerId
        : null;
    const ctx = await loadRestructureContext(em, loan, payerCustomerId);

    res.json({
      data: {
        loan: {
          id: loan.id,
          loanNumber: loan.loanNumber,
          customerId: loan.customerId,
          status: loan.status,
          currency: loan.currency,
          disbursedAt: loan.disbursedAt,
        },
        ...ctx,
      },
    });
  })
);

/**
 * The payer an addendum would put forward, with the KYC state their engagement was verified against.
 * Lets the branch fix a missing verification before the paper reaches an approver.
 */
router.post(
  '/proposed-payer/:loanId',
  validateBody(proposedPayerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const loan = await em.findOne(Loan, { where: { id: req.params.loanId } });
    if (!loan) throw notFound('Loan');

    const ctx = await loadRestructureContext(em, loan, req.body.newPayerCustomerId);
    res.json({
      data: {
        payer: ctx.proposedPayer
          ? {
              customerId: ctx.proposedPayer.customerId,
              fullName: ctx.proposedPayer.fullName,
              engagedAt: ctx.proposedPayer.party.engagedAt,
              relationship: ctx.proposedPayer.party.relationship,
              kyc: ctx.proposedPayer.kyc,
            }
          : null,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const request = await em.findOne(RestructureRequest, { where: { id: req.params.id } });
    if (!request) throw notFound('Restructure request');
    res.json({ data: await restructureState(em, request) });
  })
);

/**
 * Writes the hardship addendum and puts it in front of the approval engine. The request itself changes
 * nothing — approving it does not either. The terms only move when an operator applies it below.
 */
router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(createRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const body = req.body as z.infer<typeof createRequestSchema>;

    const request = await getDataSource().transaction((em) =>
      createRestructureRequest(em, {
        loanId: body.loanId,
        hardshipReason: body.hardshipReason,
        changeTypes: body.changeTypes as RestructureChangeType[],
        newInterestRate: body.newInterestRate ?? null,
        newTermMonths: body.newTermMonths ?? null,
        newPayerCustomerId: body.newPayerCustomerId ?? null,
        interestReliefAmount: num(body.interestReliefAmount ?? 0),
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.status(201).json({ data: request });
  })
);

/**
 * Puts an approved addendum into force: the loan's snapshot terms are rewritten and the interest relief
 * is drafted as a WAIVER with its own approval trail. Applying is an operator's act, not the approver's,
 * so the decision and the change of record stay two separate pairs of hands.
 */
router.post(
  '/:id/apply',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;

    const result = await getDataSource().transaction((em) =>
      applyRestructure(em, {
        requestId: req.params.id,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.json({ data: await restructureState(getDataSource().manager, result.request) });
  })
);

export default router;
