import { Router } from 'express';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { LoanProduct } from '../entities/loan-product.entity';
import { DEFAULT_PENALTY_POLICY, InterestMethod, PenaltyMode, PenaltyPolicy, PeriodUnit, UserRole } from '../entities/types';
import { termMonthsOf } from '../utils/period';
import {
  assertPenaltyPolicyMakesSense,
  describePenaltyPolicy,
  mergePenaltyPolicy,
} from '../services/penalty-policy.service';
import { writeAudit } from '../services/audit.service';
import { notifyLoanProductCreated } from '../services/notification-events.service';
import { authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';

const router = Router();
router.use(authMiddleware);

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const paginated = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const repository = getDataSource().getRepository(LoanProduct);
    if (paginated) {
      const [products, total] = await repository.findAndCount({
        order: { createdAt: 'ASC' },
        skip: (page - 1) * limit,
        take: limit,
      });
      res.json({ products, pagination: { page, limit, total } });
      return;
    }
    const products = await repository.find({ order: { createdAt: 'ASC' } });
    res.json({ products });
  }),
);

/** Every penalty field is optional so one shape serves both create and patch. */
const penaltyPolicyInput = z.object({
  mode: z.nativeEnum(PenaltyMode).optional(),
  ratePercent: z.number().min(0).max(1000).optional(),
  amount: z.number().min(0).optional(),
  period: z.nativeEnum(PeriodUnit).optional(),
  graceDays: z.number().int().min(0).max(3650).optional(),
  maxPercentOfPrincipal: z.number().min(0).max(1000).optional(),
});

const createProductSchema = z.object({
  code: z.string().min(2).max(32),
  name: z.string().min(1).max(191),
  interestRate: z.number().min(0).max(100000),
  interestRatePeriod: z.nativeEnum(PeriodUnit).optional(),
  /** Omitted means FLAT, the historic lump-sum billing, so older callers are unchanged. */
  interestMethod: z.nativeEnum(InterestMethod).optional(),
  termValue: z.number().int().min(1).max(7300).optional(),
  termUnit: z.nativeEnum(PeriodUnit).optional(),
  /** Legacy: a bare month count, equivalent to `termValue` with `termUnit: MONTH`. */
  termMonths: z.number().int().min(1).max(360).optional(),
  penaltyPolicy: penaltyPolicyInput.optional(),
  /** Percent of the principal still owed, taken when the customer settles the whole debt early. */
  earlySettlementFeePercent: z.number().min(0).max(100).optional(),
  currency: z.string().length(3).optional(),
  description: z.string().max(255).optional(),
});

/** How the pricing reads in an audit line, so the trail explains itself without a lookup. */
const describeInterest = (method: InterestMethod): string =>
  method === InterestMethod.DECLINING ? 'declining balance (equal principal)' : 'flat (billed once at disbursement)';

router.post(
  '/',
  requireRole(UserRole.ADMIN),
  validateBody(createProductSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createProductSchema>;
    const ds = getDataSource();
    const exists = await ds.getRepository(LoanProduct).findOne({ where: { code: body.code } });
    if (exists) {
      res.status(409).json({ error: { message: 'Product code already exists' } });
      return;
    }

    const termUnit = body.termUnit ?? PeriodUnit.MONTH;
    const termValue = body.termValue ?? body.termMonths ?? 12;
    const penaltyPolicy = mergePenaltyPolicy(DEFAULT_PENALTY_POLICY, body.penaltyPolicy ?? {});
    assertPenaltyPolicyMakesSense(penaltyPolicy);

    const product = ds.getRepository(LoanProduct).create({
      code: body.code,
      name: body.name,
      interestRate: body.interestRate,
      interestRatePeriod: body.interestRatePeriod ?? PeriodUnit.YEAR,
      interestMethod: body.interestMethod ?? InterestMethod.FLAT,
      termValue,
      termUnit,
      termMonths: termMonthsOf(termValue, termUnit),
      penaltyPolicy,
      earlySettlementFeePercent: body.earlySettlementFeePercent ?? 0,
      currency: body.currency ?? 'LAK',
      description: body.description ?? null,
    });
    await ds.getRepository(LoanProduct).save(product);
    await writeAudit(ds.manager, {
      action: 'LOAN_PRODUCT_CREATED',
      userId: req.user!.id,
      reason:
        `${product.code} ${product.name} — ${product.interestRate}%/${product.interestRatePeriod.toLowerCase()}, ` +
        `interest ${describeInterest(product.interestMethod)}, ` +
        `${product.termValue} ${product.termUnit.toLowerCase()}, ${describePenaltyPolicy(penaltyPolicy)}, ` +
        `early-settlement fee ${product.earlySettlementFeePercent}%`,
      ip: req.ip ?? null,
    });
    await notifyLoanProductCreated(ds.manager, {
      productId: product.id,
      createdByName: req.user!.fullName,
      actorUserId: req.user!.id,
    });
    res.status(201).json({ product });
  })
);

const updateProductSchema = z.object({
  name: z.string().min(1).max(191).optional(),
  isActive: z.boolean().optional(),
  description: z.string().max(255).optional(),
  interestRate: z.number().min(0).max(100000).optional(),
  interestRatePeriod: z.nativeEnum(PeriodUnit).optional(),
  interestMethod: z.nativeEnum(InterestMethod).optional(),
  termValue: z.number().int().min(1).max(7300).optional(),
  termUnit: z.nativeEnum(PeriodUnit).optional(),
  penaltyPolicy: penaltyPolicyInput.optional(),
  earlySettlementFeePercent: z.number().min(0).max(100).optional(),
});

/**
 * Re-pricing a product only affects loans created afterwards — every loan snapshots rate,
 * interest method, term and penalty policy at disbursement, so the ledger of an existing
 * loan never moves.
 */
router.patch(
  '/:id',
  requireRole(UserRole.ADMIN),
  validateBody(updateProductSchema),
  asyncHandler(async (req, res) => {
    const ds = getDataSource();
    const product = await ds.getRepository(LoanProduct).findOne({ where: { id: req.params.id } });
    if (!product) throw notFound('Loan product not found');
    // Products created before the penalty field exist as NULL; heal them on first write.
    product.penaltyPolicy = mergePenaltyPolicy(product.penaltyPolicy, {});
    const body = req.body as z.infer<typeof updateProductSchema>;

    if (body.name !== undefined) product.name = body.name;
    if (body.isActive !== undefined) product.isActive = body.isActive;
    if (body.description !== undefined) product.description = body.description;
    if (body.interestRate !== undefined) product.interestRate = body.interestRate;
    if (body.interestRatePeriod !== undefined) product.interestRatePeriod = body.interestRatePeriod;
    if (body.interestMethod !== undefined) product.interestMethod = body.interestMethod;
    if (body.earlySettlementFeePercent !== undefined) {
      product.earlySettlementFeePercent = body.earlySettlementFeePercent;
    }

    const termChanged = body.termValue !== undefined || body.termUnit !== undefined;
    if (termChanged) {
      product.termValue = body.termValue ?? product.termValue;
      product.termUnit = body.termUnit ?? product.termUnit;
      product.termMonths = termMonthsOf(product.termValue, product.termUnit);
    }

    if (body.penaltyPolicy !== undefined) {
      const merged = mergePenaltyPolicy(product.penaltyPolicy, body.penaltyPolicy);
      assertPenaltyPolicyMakesSense(merged);
      product.penaltyPolicy = merged;
    }

    await ds.getRepository(LoanProduct).save(product);
    await writeAudit(ds.manager, {
      action: 'LOAN_PRODUCT_UPDATED',
      userId: req.user!.id,
      reason:
        `${product.code}: ${Object.keys(body).join(', ')} — now ${product.interestRate}%/` +
        `${product.interestRatePeriod.toLowerCase()}, interest ${describeInterest(product.interestMethod)}, ` +
        `${product.termValue} ${product.termUnit.toLowerCase()}, ` +
        `${describePenaltyPolicy(product.penaltyPolicy)}`,
      ip: req.ip ?? null,
    });
    res.json({ product });
  })
);

export default router;
