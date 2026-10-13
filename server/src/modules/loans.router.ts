import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Loan } from '../entities/loan.entity';
import { Customer } from '../entities/customer.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ComponentAmounts,
  LoanStatus,
  TransactionStatus,
  TransactionType,
  ComponentType,
  KycStatus,
  PeriodUnit,
} from '../entities/types';
import { requireAuth, requireRole, OPERATOR_ROLES } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound, unprocessable } from '../utils/errors';
import { round2, num } from '../utils/money';
import { flatInterestTotal, termMonthsOf } from '../utils/period';
import { pad } from '../utils/pad';
import { writeAudit } from '../services/audit.service';
import { getKycPolicy } from '../services/kyc-policy.service';
import { notifyLoanSubmitted } from '../services/notification-events.service';
import { getLoanSchedule } from '../services/loan-schedule.service';
import { mergePenaltyPolicy } from '../services/penalty-policy.service';
import { nextTransactionNo } from '../services/reference.service';
import { balanceSnapshot, getBalances, totalOutstanding } from '../services/loan-balance.service';
import { allocateSequentially } from '../services/allocation.service';
import { getDataSource } from '../datasource';
import { AuthUser } from '../middleware/auth';

const router = Router();
router.use(requireAuth);

const createLoanSchema = z
  .object({
    customerId: z.string().uuid(),
    productId: z.string().uuid(),
    principalAmount: z.number().positive(),
    termValue: z.number().int().min(1).max(7300).optional(),
    termUnit: z.nativeEnum(PeriodUnit).optional(),
    /** Legacy override: a bare month count. Equivalent to `termValue` with `termUnit: MONTH`. */
    termMonths: z.number().int().positive().max(600).optional(),
    disbursedAt: z.string().datetime().optional(),
    note: z.string().max(1000).optional(),
  })
  .refine((body) => body.termValue === undefined || body.termUnit !== undefined, {
    message: 'termUnit is required when termValue is given',
  });

/** How far back a disbursement may be dated; older money does not belong in this ledger. */
const DISBURSEMENT_LOOKBACK_DAYS = 730;

function previewOutstanding(loan: Loan) {
  return {
    penalty: loan.outstandingPenalty,
    pastInterest: loan.outstandingPastInterest,
    pastPrincipal: loan.outstandingPastPrincipal,
    total: totalOutstanding(getBalances(loan)),
  };
}

interface LoanFilters {
  status?: LoanStatus;
  customerId?: string;
  q?: string;
}

/** The list filters, shared by the page query and the aggregate query so both always agree. */
function loanListQb(filters: LoanFilters) {
  const qb = getDataSource()
    .getRepository(Loan)
    .createQueryBuilder('loan')
    .leftJoinAndMapOne('loan.customer', Customer, 'customer', 'customer.id = loan.customerId')
    .leftJoinAndMapOne('loan.product', LoanProduct, 'product', 'product.id = loan.productId');

  if (filters.status) qb.andWhere('loan.status = :status', { status: filters.status });
  if (filters.customerId) qb.andWhere('loan.customerId = :customerId', { customerId: filters.customerId });
  if (filters.q) {
    qb.andWhere('(loan.loanNumber LIKE :q OR customer.fullName LIKE :q OR customer.nationalId LIKE :q)', {
      q: `%${filters.q}%`,
    });
  }
  return qb;
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, num(String(req.query.page ?? '1')) || 1);
    const limit = Math.min(100, Math.max(1, num(String(req.query.limit ?? '20')) || 20));
    const filters: LoanFilters = {
      status: typeof req.query.status === 'string' && req.query.status ? (req.query.status as LoanStatus) : undefined,
      customerId:
        typeof req.query.customerId === 'string' && req.query.customerId ? req.query.customerId : undefined,
      q: typeof req.query.q === 'string' ? req.query.q.trim() : '',
    };

    const [loans, total] = await loanListQb(filters)
      .orderBy('loan.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    // Portfolio summary for the same filter set — plain balance sums, no accrual guessing.
    const aggregates = await loanListQb(filters)
      .select('COALESCE(SUM(loan.principalAmount), 0)', 'principal')
      .addSelect('COALESCE(SUM(loan.outstandingPastPrincipal), 0)', 'outstandingPrincipal')
      .addSelect('COALESCE(SUM(loan.outstandingPastInterest), 0)', 'outstandingInterest')
      .addSelect('COALESCE(SUM(loan.outstandingPenalty), 0)', 'outstandingPenalty')
      .addSelect('COALESCE(SUM(loan.currentOutstanding), 0)', 'outstandingTotal')
      .addSelect('COALESCE(SUM(CASE WHEN loan.status = :closed THEN 1 ELSE 0 END), 0)', 'closedCount')
      .setParameter('closed', LoanStatus.CLOSED)
      .getRawOne<{ principal: string; outstandingPrincipal: string; outstandingInterest: string; outstandingPenalty: string; outstandingTotal: string; closedCount: string }>();

    res.json({
      data: loans.map((l) => ({
        ...l,
        outstanding: previewOutstanding(l),
      })),
      pagination: { page, limit, total },
      aggregates: {
        principalCharged: round2(num(aggregates?.principal)),
        outstandingPrincipal: round2(num(aggregates?.outstandingPrincipal)),
        outstandingInterest: round2(num(aggregates?.outstandingInterest)),
        outstandingPenalty: round2(num(aggregates?.outstandingPenalty)),
        outstandingTotal: round2(num(aggregates?.outstandingTotal)),
        closedCount: num(aggregates?.closedCount),
      },
    });
  })
);

export interface CreateLoanParams {
  customerId: string;
  productId: string;
  principalAmount: number;
  termValue?: number;
  termUnit?: PeriodUnit;
  /** Legacy month override. */
  termMonths?: number;
  disbursedAt?: string;
  note?: string | null;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** Atomic loan creation + posted DISBURSEMENT (financial truth from the very first transaction). */
export async function createLoanWithDisbursement(em: EntityManager, params: CreateLoanParams) {
  const {
    customerId,
    productId,
    principalAmount,
    termValue,
    termUnit,
    termMonths,
    disbursedAt,
    note,
    userId,
    ip,
    userAgent,
  } = params;

  // The ledger may only be written for a date the system can actually account for: never in the
  // future, and not before the recorded history of this deployment.
  if (disbursedAt) {
    const when = new Date(disbursedAt).getTime();
    const now = Date.now();
    if (Number.isNaN(when)) throw badRequest('disbursedAt must be a valid date');
    if (when > now + 5 * 60 * 1000) throw unprocessable('disbursedAt cannot be in the future');
    if (when < now - DISBURSEMENT_LOOKBACK_DAYS * 86_400_000) {
      throw unprocessable(`disbursedAt must be within the last ${DISBURSEMENT_LOOKBACK_DAYS} days`);
    }
  }

  const customer = await em.findOneBy(Customer, { id: customerId });
  if (!customer) throw badRequest('Customer not found');

  // KYC gate (configurable through /api/config/kyc): identity evidence must be verified first.
  const kycPolicy = await getKycPolicy(em);
  if (kycPolicy.blockDisbursementUntilVerified && customer.kycStatus !== KycStatus.VERIFIED) {
    throw unprocessable(
      `Customer KYC is ${customer.kycStatus} — disbursement requires VERIFIED KYC (${customer.customerNumber})`,
    );
  }

  const product = await em.findOneBy(LoanProduct, { id: productId, isActive: true });
  if (!product) throw badRequest('Loan product not found or inactive');

  // The loan's own term wins over the product default; a bare month count keeps its old meaning.
  const effectiveUnit = termUnit ?? (termMonths !== undefined ? PeriodUnit.MONTH : product.termUnit);
  const effectiveValue = termValue ?? (termMonths !== undefined ? termMonths : product.termValue);
  const effectiveMonths = termMonthsOf(effectiveValue, effectiveUnit);
  const interest = flatInterestTotal({
    principal: principalAmount,
    ratePercent: product.interestRate,
    rateUnit: product.interestRatePeriod,
    termValue: effectiveValue,
    termUnit: effectiveUnit,
  });

  const count = await em.count(Loan);
  const loan = em.create(Loan, {
    loanNumber: `LN-${pad(count + 1, 6)}`,
    customerId,
    productId,
    principalAmount: round2(principalAmount),
    interestRate: product.interestRate,
    interestRatePeriod: product.interestRatePeriod,
    termValue: effectiveValue,
    termUnit: effectiveUnit,
    termMonths: effectiveMonths,
    penaltyPolicy: mergePenaltyPolicy(product.penaltyPolicy, {}),
    currency: product.currency,
    status: LoanStatus.ACTIVE,
    outstandingPenalty: 0,
    outstandingPastInterest: interest,
    outstandingPastPrincipal: round2(principalAmount),
    currentOutstanding: round2(principalAmount + interest),
    disbursedAt: disbursedAt ? new Date(disbursedAt) : new Date(),
  });
  await em.save(Loan, loan);

  const componentAmounts: ComponentAmounts = {
    [ComponentType.PENALTY]: 0,
    [ComponentType.PAST_INTEREST]: interest,
    [ComponentType.PAST_PRINCIPAL]: round2(principalAmount),
  };
  const tx = em.create(FinancialTransaction, {
    referenceNo: await nextTransactionNo(em),
    loanId: loan.id,
    customerId,
    transactionType: TransactionType.DISBURSEMENT,
    status: TransactionStatus.POSTED,
    amount: round2(principalAmount + interest),
    currency: product.currency,
    componentAmounts,
    reason: note ? `Disbursement for loan ${loan.loanNumber} — ${note}` : `Disbursement for loan ${loan.loanNumber}`,
    createdBy: userId,
    postedBy: userId,
    approvedAt: new Date(),
    postedAt: disbursedAt ? new Date(disbursedAt) : new Date(),
  });
  await em.save(FinancialTransaction, tx);

  await em.insert(FinancialTransactionLine, [
    { transactionId: tx.id, component: ComponentType.PAST_PRINCIPAL, amount: round2(principalAmount) },
    { transactionId: tx.id, component: ComponentType.PAST_INTEREST, amount: interest },
  ]);

  await writeAudit(em, {
    action: 'LOAN_DISBURSED',
    loanId: loan.id,
    customerId,
    userId,
    amount: round2(principalAmount),
    currency: product.currency,
    newStatus: loan.status,
    newBalance: balanceSnapshot(loan),
    reason: note ?? null,
    ip,
    userAgent,
  });

  await writeAudit(em, {
    action: 'TRANSACTION_POSTED',
    transactionId: tx.id,
    transactionType: tx.transactionType,
    loanId: loan.id,
    customerId,
    userId,
    amount: tx.amount,
    currency: tx.currency,
    previousStatus: TransactionStatus.POSTED,
    newStatus: TransactionStatus.POSTED,
    previousBalance: { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0, total: 0 },
    newBalance: balanceSnapshot(loan),
    reason: tx.reason,
    ip,
    userAgent,
  });

  await notifyLoanSubmitted(em, {
    loanId: loan.id,
    customerId,
    productId,
    principalAmount: round2(principalAmount),
  });

  return { loan, customer, product, tx };
}

router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(createLoanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { customerId, productId, principalAmount, termValue, termUnit, termMonths, disbursedAt, note } = req.body;

    const result = await getDataSource().transaction((em) =>
      createLoanWithDisbursement(em, {
        customerId,
        productId,
        principalAmount,
        termValue,
        termUnit,
        termMonths,
        disbursedAt,
        note,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.status(201).json({
      data: {
        loan: { ...result.loan, customer: result.customer, product: result.product, outstanding: previewOutstanding(result.loan) },
        disbursementTransaction: result.tx,
      },
    });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10));
    const em = getDataSource();
    const loan = await em.getRepository(Loan).findOneBy({ id });
    if (!loan) throw notFound('Loan');

    const [customer, product, transactionResult, credit, settlements] = await Promise.all([
      em.getRepository(Customer).findOneBy({ id: loan.customerId }),
      em.getRepository(LoanProduct).findOneBy({ id: loan.productId }),
      em.getRepository(FinancialTransaction).findAndCount({
        where: { loanId: id },
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      em.getRepository(CustomerCredit).findOneBy({ customerId: loan.customerId }),
      em.getRepository(SettlementAgreement).find({
        where: { loanId: id },
        order: { createdAt: 'DESC' },
      }),
    ]);
    const [transactions, transactionTotal] = transactionResult;

    res.json({
      data: {
        loan: {
          ...loan,
          customer,
          product,
          outstanding: previewOutstanding(loan),
        },
        transactions,
        transactionPagination: { page, limit, total: transactionTotal },
        credit,
        settlements,
      },
    });
  })
);

router.get(
  '/:id/allocation-preview',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const amount = num(String(req.query.amount ?? '0'));
    if (!(amount > 0)) throw badRequest('amount must be > 0');
    const loan = await getDataSource().getRepository(Loan).findOneBy({ id });
    if (!loan) throw notFound('Loan');

    const outstanding: ComponentAmounts = {
      [ComponentType.PENALTY]: loan.outstandingPenalty,
      [ComponentType.PAST_INTEREST]: loan.outstandingPastInterest,
      [ComponentType.PAST_PRINCIPAL]: loan.outstandingPastPrincipal,
    };
    const { allocation, excess } = allocateSequentially(amount, outstanding);
    res.json({ data: { amount, outstanding, allocation, excess } });
  })
);

router.get(
  '/:id/schedule',
  asyncHandler(async (req: Request, res: Response) => {
    const id = req.params.id;
    const rawAsOf = typeof req.query.asOf === 'string' ? req.query.asOf : '';
    const asOf = rawAsOf ? new Date(rawAsOf) : new Date();
    if (Number.isNaN(asOf.getTime())) throw badRequest('asOf must be a valid date');

    const em = getDataSource();
    const loan = await em.getRepository(Loan).findOneBy({ id });
    if (!loan) throw notFound('Loan');

    res.json({ data: await getLoanSchedule(em.manager, id, asOf) });
  })
);

export default router;
