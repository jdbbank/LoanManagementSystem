import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Loan } from '../entities/loan.entity';
import { CollateralStatus, CollateralType, UserRole } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound } from '../utils/errors';
import { num } from '../utils/money';
import {
  computeCollateralCoverage,
  findCollaterals,
  loanOutstanding,
  registerCollateral,
  releaseCollateral,
} from '../services/collateral.service';
import { getCollateralPolicy } from '../services/collateral-policy.service';
import { getDataSource } from '../datasource';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** Releasing a pledge removes security from a live loan, so it is not a maker's decision. */
const RELEASE_ROLES = [UserRole.HEAD_APPROVER, UserRole.ADMIN];

const registerCollateralSchema = z.object({
  type: z.enum([
    CollateralType.LAND,
    CollateralType.BUILDING,
    CollateralType.VEHICLE,
    CollateralType.DEPOSIT,
    CollateralType.EQUIPMENT,
    CollateralType.GOLD,
    CollateralType.OTHER,
  ]),
  description: z.string().min(3).max(255),
  certificateNo: z.string().max(64).optional(),
  appraisedValue: z.number().positive(),
  valuedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
    .optional(),
  ownerCustomerId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
});

const releaseCollateralSchema = z.object({
  reason: z.string().min(1, 'A release needs a reason on record').max(1000),
});

function loanIdOf(req: Request): string {
  const loanId = (req.params as Record<string, string>).loanId;
  if (!loanId) throw badRequest('Missing loanId');
  return loanId;
}

/** The register value is the date the appraiser signed, not today, so it is taken as a plain date. */
function valuedAtOf(body: { valuedAt?: string }): Date {
  return body.valuedAt ? new Date(`${body.valuedAt}T00:00:00.000Z`) : new Date();
}

async function coverageView(em: EntityManager, loanId: string) {
  const loan = await em.findOne(Loan, { where: { id: loanId } });
  if (!loan) throw notFound('Loan');
  const [collaterals, policy] = await Promise.all([findCollaterals(em, loanId), getCollateralPolicy(em)]);
  const outstanding = loanOutstanding(loan);
  return {
    loan: {
      id: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      customerId: loan.customerId,
      currency: loan.currency,
      outstanding,
    },
    collaterals,
    policy,
    coverage: computeCollateralCoverage(collaterals, outstanding, policy),
  };
}

/**
 * Pledged security of one loan with the coverage the current policy computes over it, so a branch sees
 * the same pass/fail the restructure check will apply.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ data: await coverageView(getDataSource().manager, loanIdOf(req)) });
  })
);

/** Coverage alone, for a screen that only needs to know whether the security still stands up. */
router.get(
  '/coverage',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const view = await coverageView(em, loanIdOf(req));
    res.json({
      data: {
        loan: view.loan,
        policy: view.policy,
        coverage: view.coverage,
        pledged: view.collaterals.filter((item) => item.status === CollateralStatus.PLEDGED),
      },
    });
  })
);

router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(registerCollateralSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const body = req.body as z.infer<typeof registerCollateralSchema>;

    const item = await getDataSource().transaction(async (em) =>
      registerCollateral(em, {
        loanId: loanIdOf(req),
        type: body.type,
        description: body.description,
        certificateNo: body.certificateNo ?? null,
        appraisedValue: num(body.appraisedValue),
        valuedAt: valuedAtOf(body),
        ownerCustomerId: body.ownerCustomerId ?? null,
        note: body.note ?? null,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.status(201).json({ data: item });
  })
);

router.post(
  '/:collateralId/release',
  requireRole(...RELEASE_ROLES),
  validateBody(releaseCollateralSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body as { reason: string };

    const item = await getDataSource().transaction(async (em) =>
      releaseCollateral(em, {
        collateralId: req.params.collateralId,
        reason,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.json({ data: item });
  })
);

export default router;
