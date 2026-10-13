import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Loan } from '../entities/loan.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { PaymentAllocation } from '../entities/payment-allocation.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ComponentAmounts,
  ComponentType,
  LoanStatus,
  PaymentRequestStatus,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../entities/types';
import { AuthUser, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { allocateSequentially, validateAllocationOverride } from '../services/allocation.service';
import { getBalances } from '../services/loan-balance.service';
import { writeAudit } from '../services/audit.service';
import { validateSettlementPayment } from '../services/settlement.service';
import { nextRequestNo, nextTransactionNo } from '../services/reference.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

const createRequestSchema = z.object({
  loanId: z.string().uuid(),
  cashAmount: z.number().min(0),
  creditToApply: z.number().min(0).optional(),
  settlementAgreementId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
});

const approveSchema = z.object({
  overrideAllocation: z
    .object({
      PENALTY: z.number().min(0),
      PAST_INTEREST: z.number().min(0),
      PAST_PRINCIPAL: z.number().min(0),
    })
    .optional(),
  reason: z.string().max(1000).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required').max(1000),
});

export async function createPaymentRequestRecord(
  em: EntityManager,
  params: {
    loanId: string;
    cashAmount: number;
    creditApplied: number;
    settlementAgreementId: string | null;
    note: string | null;
    previousRequestId: string | null;
    user: AuthUser;
    ip?: string | null;
    userAgent?: string | null;
  },
) {
  const loan = await em.findOne(Loan, { where: { id: params.loanId } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — payments require an ACTIVE loan`);
  }

  const paymentTotal = round2(params.cashAmount + params.creditApplied);
  if (paymentTotal <= EPS) throw badRequest('Payment amount must be greater than zero');

  if (params.settlementAgreementId) {
    const agreement = await em.findOne(SettlementAgreement, {
      where: { id: params.settlementAgreementId },
    });
    validateSettlementPayment(agreement, loan.id, paymentTotal);
  }

  if (params.creditApplied > EPS) {
    const credit = await em.findOne(CustomerCredit, {
      where: { customerId: loan.customerId, currency: 'LAK' },
    });
    const available = credit ? num(credit.balance) : 0;
    if (available + EPS < params.creditApplied) {
      throw unprocessable(`Insufficient customer credit: available ${available}, requested ${params.creditApplied}`);
    }
  }

  const outstanding = getBalances(loan);
  const proposed = allocateSequentially(paymentTotal, outstanding);

  const request = em.create(PaymentRequest, {
    requestNo: await nextRequestNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    cashAmount: round2(params.cashAmount),
    creditApplied: round2(params.creditApplied),
    status: PaymentRequestStatus.PENDING,
    previousRequestId: params.previousRequestId,
    settlementAgreementId: params.settlementAgreementId,
    note: params.note,
    createdBy: params.user.id,
  });
  await em.save(PaymentRequest, request);

  // System-proposed sequential allocation snapshot (locked section 7).
  const allocations: PaymentAllocation[] = [];
  for (const component of Object.values(ComponentType)) {
    const row = em.create(PaymentAllocation, {
      paymentRequestId: request.id,
      component,
      proposedAmount: proposed.allocation[component],
      finalAmount: 0,
    });
    await em.save(PaymentAllocation, row);
    allocations.push(row);
  }

  await writeAudit(em, {
    action: params.previousRequestId ? 'PAYMENT_REQUEST_RESUBMITTED' : 'PAYMENT_REQUEST_CREATED',
    loanId: loan.id,
    customerId: loan.customerId,
    userId: params.user.id,
    amount: paymentTotal,
    currency: 'LAK',
    newStatus: PaymentRequestStatus.PENDING,
    reason: params.note,
    relatedTransactionId: null,
    sourceRequestId: request.id,
    referenceTransactionId: params.previousRequestId,
    ip: params.ip,
    userAgent: params.userAgent,
  });

  return { request, loan, proposed: proposed.allocation, allocations };
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, num(String(req.query.page ?? '1')) || 1);
    const limit = Math.min(100, Math.max(1, num(String(req.query.limit ?? '20')) || 20));
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as PaymentRequestStatus)
        : undefined;
    const loanId = typeof req.query.loanId === 'string' ? req.query.loanId : undefined;

    const repo = getDataSource().getRepository(PaymentRequest);
    const qb = repo.createQueryBuilder('request');
    if (status) qb.andWhere('request.status = :status', { status });
    if (loanId) qb.andWhere('request.loanId = :loanId', { loanId });
    const [requests, total] = await qb
      .orderBy('request.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    res.json({ data: requests, pagination: { page, limit, total } });
  })
);

router.get(
  '/pending-count',
  asyncHandler(async (_req: Request, res: Response) => {
    const count = await getDataSource().manager.count(PaymentRequest, {
      where: { status: PaymentRequestStatus.PENDING },
    });
    res.json({ data: { count } });
  })
);

router.post(
  '/',
  requireRole(UserRole.MAKER, UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(createRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, cashAmount, creditToApply, settlementAgreementId, note } = req.body;
    const result = await getDataSource().transaction(async (em) =>
      createPaymentRequestRecord(em, {
        loanId,
        cashAmount,
        creditApplied: creditToApply ?? 0,
        settlementAgreementId: settlementAgreementId ?? null,
        note: note ?? null,
        previousRequestId: null,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );
    res.status(201).json({ data: result });
  })
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const request = await em.findOne(PaymentRequest, { where: { id: req.params.id } });
    if (!request) throw notFound('Payment request');
    const [allocations, transaction, previous] = await Promise.all([
      em.find(PaymentAllocation, { where: { paymentRequestId: request.id } }),
      request.status === PaymentRequestStatus.APPROVED
        ? em.findOne(FinancialTransaction, { where: { sourceRequestId: request.id } })
        : Promise.resolve(null),
      request.previousRequestId
        ? em.findOne(PaymentRequest, { where: { id: request.previousRequestId } })
        : Promise.resolve(null),
    ]);
    res.json({ data: { request, allocations, transaction, previousRequest: previous } });
  })
);

router.post(
  '/:id/approve',
  requireRole(UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(approveSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { overrideAllocation, reason } = req.body;

    const result = await getDataSource().transaction(async (em) => {
      const request = await em.findOne(PaymentRequest, {
        where: { id: req.params.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw notFound('Payment request');
      if (request.status !== PaymentRequestStatus.PENDING) {
        throw unprocessable(`Request is already ${request.status}`);
      }
      if (request.createdBy === user.id) {
        throw unprocessable('Maker cannot verify their own payment request (maker-checker separation)');
      }

      const loan = await em.findOne(Loan, { where: { id: request.loanId }, lock: { mode: 'pessimistic_write' } });
      if (!loan) throw notFound('Loan');
      if (loan.status !== LoanStatus.ACTIVE) {
        throw unprocessable(`Loan is ${loan.status} — cannot approve payment`);
      }

      const paymentTotal = round2(num(request.cashAmount) + num(request.creditApplied));
      const outstanding = getBalances(loan);
      const proposed = allocateSequentially(paymentTotal, outstanding).allocation;

      let allocation: ComponentAmounts = proposed;
      if (overrideAllocation) {
        allocation = {
          PENALTY: num(overrideAllocation.PENALTY),
          PAST_INTEREST: num(overrideAllocation.PAST_INTEREST),
          PAST_PRINCIPAL: num(overrideAllocation.PAST_PRINCIPAL),
        };
        // HARD validation — reject immediately, no warning mode, no bypass (locked section 7).
        validateAllocationOverride(allocation, paymentTotal, outstanding);
      }

      request.status = PaymentRequestStatus.APPROVED;
      request.approvedBy = user.id;
      request.approvedAt = new Date();
      await em.save(PaymentRequest, request);

      const allocations = await em.find(PaymentAllocation, { where: { paymentRequestId: request.id } });
      for (const row of allocations) {
        row.finalAmount = allocation[row.component];
        row.overridden = overrideAllocation !== undefined;
        await em.save(PaymentAllocation, row);
      }

      const tx = em.create(FinancialTransaction, {
        referenceNo: await nextTransactionNo(em),
        loanId: loan.id,
        customerId: loan.customerId,
        transactionType: request.settlementAgreementId
          ? TransactionType.SETTLEMENT_PAYMENT
          : TransactionType.PAYMENT,
        status: TransactionStatus.APPROVED,
        amount: paymentTotal,
        currency: 'LAK',
        componentAmounts: allocation,
        sourceRequestId: request.id,
        settlementAgreementId: request.settlementAgreementId,
        reason: reason ?? `Payment for request ${request.requestNo}`,
        createdBy: request.createdBy,
        approvedAt: new Date(),
      });
      await em.save(FinancialTransaction, tx);

      await writeAudit(em, {
        action: 'PAYMENT_REQUEST_APPROVED',
        transactionId: tx.id,
        transactionType: TransactionType.PAYMENT,
        loanId: loan.id,
        customerId: loan.customerId,
        userId: user.id,
        previousStatus: PaymentRequestStatus.PENDING,
        newStatus: PaymentRequestStatus.APPROVED,
        amount: paymentTotal,
        currency: 'LAK',
        makerUserId: request.createdBy,
        checkerUserId: user.id,
        reason: reason ?? null,
        sourceRequestId: request.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return { request, transaction: tx, allocation, proposed };
    });

    res.json({ data: result });
  })
);

router.post(
  '/:id/reject',
  requireRole(UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(rejectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body;

    const request = await getDataSource().transaction(async (em) => {
      const request = await em.findOne(PaymentRequest, {
        where: { id: req.params.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!request) throw notFound('Payment request');
      if (request.status !== PaymentRequestStatus.PENDING) {
        throw unprocessable(`Request is already ${request.status}`);
      }
      if (request.createdBy === user.id) {
        throw unprocessable('Maker cannot reject their own payment request (maker-checker separation)');
      }

      request.status = PaymentRequestStatus.REJECTED;
      request.rejectionReason = reason;
      request.rejectedBy = user.id;
      request.rejectedAt = new Date();
      await em.save(PaymentRequest, request);

      await writeAudit(em, {
        action: 'PAYMENT_REQUEST_REJECTED',
        loanId: request.loanId,
        customerId: request.customerId,
        userId: user.id,
        previousStatus: PaymentRequestStatus.PENDING,
        newStatus: PaymentRequestStatus.REJECTED,
        amount: round2(num(request.cashAmount) + num(request.creditApplied)),
        currency: request.currency,
        makerUserId: request.createdBy,
        checkerUserId: user.id,
        reason,
        sourceRequestId: request.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return request;
    });

    res.json({ data: request });
  })
);

router.post(
  '/:id/resubmit',
  requireRole(UserRole.MAKER, UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const original = await getDataSource().manager.findOne(PaymentRequest, { where: { id: req.params.id } });
    if (!original) throw notFound('Payment request');
    if (original.status !== PaymentRequestStatus.REJECTED) {
      throw unprocessable('Only rejected requests can be resubmitted');
    }

    const result = await getDataSource().transaction(async (em) =>
      createPaymentRequestRecord(em, {
        loanId: original.loanId,
        cashAmount: num(original.cashAmount),
        creditApplied: num(original.creditApplied),
        settlementAgreementId: original.settlementAgreementId,
        note: original.note,
        previousRequestId: original.id,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.status(201).json({ data: result });
  })
);

export default router;
