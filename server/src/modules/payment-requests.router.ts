import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { PaymentAllocation } from '../entities/payment-allocation.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { PaymentRequestPurpose, PaymentRequestStatus, UserRole } from '../entities/types';
import { getDataSource } from '../datasource';
import { AuthUser, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound, unprocessable } from '../utils/errors';
import { num, round2 } from '../utils/money';
import { writeAudit } from '../services/audit.service';
import {
  notifyPaymentRequestRejected,
  notifyPaymentRequestSubmitted,
  notifyPaymentRequestVerified,
} from '../services/notification-events.service';
import {
  approvePaymentRequest,
  createPaymentRequestRecord,
} from '../services/payment-request.service';

const router = Router();
router.use(requireAuth);

const createRequestSchema = z.object({
  loanId: z.string().uuid(),
  cashAmount: z.number().min(0),
  creditToApply: z.number().min(0).optional(),
  settlementAgreementId: z.string().uuid().optional(),
  purpose: z.nativeEnum(PaymentRequestPurpose).optional(),
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
    const { loanId, cashAmount, creditToApply, settlementAgreementId, purpose, note } = req.body;
    const result = await getDataSource().transaction(async (em) => {
      const created = await createPaymentRequestRecord(em, {
        loanId,
        cashAmount,
        creditApplied: creditToApply ?? 0,
        settlementAgreementId: settlementAgreementId ?? null,
        purpose: purpose ?? PaymentRequestPurpose.PAY_DEBT,
        note: note ?? null,
        previousRequestId: null,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyPaymentRequestSubmitted(em, {
        loanId: created.loan.id,
        requestNo: created.request.requestNo,
        amount: round2(num(cashAmount) + num(creditToApply ?? 0)),
        currency: created.loan.currency,
        purpose: purpose ?? PaymentRequestPurpose.PAY_DEBT,
        receivedAt: new Date(),
      });
      return created;
    });
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
    const { overrideAllocation, reason } = req.body as {
      overrideAllocation?: { PENALTY: number; PAST_INTEREST: number; PAST_PRINCIPAL: number };
      reason?: string;
    };

    const result = await getDataSource().transaction(async (em) => {
      const approved = await approvePaymentRequest(em, {
        requestId: req.params.id,
        user,
        overrideAllocation,
        reason,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyPaymentRequestVerified(em, {
        loanId: approved.request.loanId,
        requestNo: approved.request.requestNo,
        amount: num(approved.transaction.amount),
        currency: approved.transaction.currency,
        allocation: approved.allocation,
        makerUserId: approved.request.createdBy,
      });
      return approved;
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

      await notifyPaymentRequestRejected(em, {
        loanId: request.loanId,
        requestNo: request.requestNo,
        amount: round2(num(request.cashAmount) + num(request.creditApplied)),
        currency: request.currency,
        reason,
        makerUserId: request.createdBy,
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

    const result = await getDataSource().transaction(async (em) => {
      const created = await createPaymentRequestRecord(em, {
        loanId: original.loanId,
        cashAmount: num(original.cashAmount),
        creditApplied: num(original.creditApplied),
        settlementAgreementId: original.settlementAgreementId,
        purpose: original.purpose,
        note: original.note,
        previousRequestId: original.id,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyPaymentRequestSubmitted(em, {
        loanId: created.loan.id,
        requestNo: created.request.requestNo,
        amount: round2(num(original.cashAmount) + num(original.creditApplied)),
        currency: created.loan.currency,
        purpose: original.purpose,
        receivedAt: new Date(),
      });
      return created;
    });

    res.status(201).json({ data: result });
  })
);

export default router;
