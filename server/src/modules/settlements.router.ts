import { Router, Request, Response } from 'express';
import { EntityManager, In } from 'typeorm';
import { z } from 'zod';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { Loan } from '../entities/loan.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import {
  ApprovalSubjectType,
  LoanStatus,
  SettlementStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { getBalances, totalOutstanding } from '../services/loan-balance.service';
import { createWorkflow } from '../services/approval.service';
import { getPayableNow } from '../services/payment-due.service';
import { notifySettlementRequested } from '../services/notification-events.service';
import { writeAudit } from '../services/audit.service';
import { nextAgreementNo } from '../services/reference.service';
import { createPaymentRequestRecord } from '../services/payment-request.service';
import { createEarlySettlementFeeCharge, createWaiverFromSettlement } from './transactions.router';
import {
  assertEarlySettlementFeePosted,
  computeEarlySettlementFee,
  validateSettlementPayment,
  validateSettlementShortfallWaiver,
} from '../services/settlement.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

const createAgreementSchema = z.object({
  loanId: z.string().uuid(),
  agreedAmount: z.number().positive(),
  reason: z.string().min(1).max(1000),
});

const settlementPaymentSchema = z.object({
  cashAmount: z.number().min(0),
  creditToApply: z.number().min(0).optional(),
  note: z.string().max(1000).optional(),
});

const waiveShortfallSchema = z.object({
  reason: z.string().min(1).max(1000),
});

/**
 * The fee has to be in the ledger before the payoff settles the book: a payment allocated against a
 * principal that does not carry it yet would overpay into credit, and the shortfall waiver would then
 * hand the fee back. Staff are told here, before a checker's approval is spent on the payment.
 */
async function assertAgreementFeeBilled(em: EntityManager, agreement: SettlementAgreement): Promise<void> {
  if (num(agreement.earlySettlementFee) <= EPS) return;
  const billed = await em.find(FinancialTransaction, {
    where: {
      settlementAgreementId: agreement.id,
      transactionType: TransactionType.PENALTY,
      status: TransactionStatus.POSTED,
    },
  });
  assertEarlySettlementFeePosted(
    agreement,
    round2(billed.reduce((total, row) => total + num(row.amount), 0)),
  );
}

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const loanId = typeof req.query.loanId === 'string' && req.query.loanId ? req.query.loanId : undefined;
    const status =
      typeof req.query.status === 'string' && req.query.status ? (req.query.status as SettlementStatus) : undefined;
    const repo = getDataSource().getRepository(SettlementAgreement);
    const qb = repo.createQueryBuilder('agreement');
    if (loanId) qb.andWhere('agreement.loanId = :loanId', { loanId });
    if (status) qb.andWhere('agreement.status = :status', { status });
    const [agreements, total] = await qb
      .orderBy('agreement.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    res.json({ data: agreements, pagination: { page, limit, total } });
  })
);

router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(createAgreementSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { loanId, agreedAmount, reason } = req.body;

    const agreement = await getDataSource().transaction(async (em) => {
      const loan = await em.findOne(Loan, { where: { id: loanId } });
      if (!loan) throw notFound('Loan');
      if (loan.status !== LoanStatus.ACTIVE) {
        throw unprocessable(`Loan is ${loan.status} — settlements require an ACTIVE loan`);
      }
      const outstanding = totalOutstanding(getBalances(loan));
      if (num(agreedAmount) - outstanding > EPS) {
        throw unprocessable(
          `Agreed amount (${round2(num(agreedAmount))}) exceeds outstanding (${outstanding})`,
        );
      }

      // Settling early means there are still instalments that have not come due. The fee is theirs:
      // an agreement made at the end of the term is not a favour the bank owes nobody.
      const payable = await getPayableNow(em, loan.id);
      const fee = computeEarlySettlementFee(
        num(loan.outstandingPastPrincipal),
        num(loan.earlySettlementFeePercent),
        payable.nextPendingPeriod !== null,
      );

      const created = em.create(SettlementAgreement, {
        agreementNo: await nextAgreementNo(em),
        loanId: loan.id,
        customerId: loan.customerId,
        agreedAmount: round2(num(agreedAmount)),
        earlySettlementFee: fee,
        status: SettlementStatus.PENDING_APPROVAL,
        reason,
        createdBy: user.id,
      });
      await em.save(SettlementAgreement, created);

      await createWorkflow(em, {
        subjectType: ApprovalSubjectType.SETTLEMENT_AGREEMENT,
        subjectId: created.id,
        amount: created.agreedAmount,
        makerUserId: user.id,
        currency: created.currency,
      });

      if (fee > EPS) {
        await createEarlySettlementFeeCharge(em, {
          loan,
          settlementAgreementId: created.id,
          agreementNo: created.agreementNo,
          feePercent: num(loan.earlySettlementFeePercent),
          amount: fee,
          user,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
      }

      await writeAudit(em, {
        action: 'SETTLEMENT_AGREEMENT_CREATED',
        loanId: loan.id,
        customerId: loan.customerId,
        userId: user.id,
        newStatus: SettlementStatus.PENDING_APPROVAL,
        amount: created.agreedAmount,
        currency: created.currency,
        makerUserId: user.id,
        reason:
          `${reason} — early-settlement fee ${fee} ` +
          `(${num(loan.earlySettlementFeePercent)}% of principal outstanding ${num(loan.outstandingPastPrincipal)})`,
        sourceRequestId: created.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await notifySettlementRequested(em, {
        loanId: loan.id,
        customerId: loan.customerId,
        agreedAmount: num(created.agreedAmount),
        currency: created.currency,
      });

      return created;
    });

    res.status(201).json({ data: agreement });
  })
);

/**
 * What ending this loan today would cost before anyone signs: the fee the loan's own snapshot puts on
 * the principal still owed, and the total the customer has to hand over. It reads and never writes, so
 * a branch can quote a payoff without touching the book.
 */
router.get(
  '/early-settlement-fee/:loanId',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const loan = await em.findOne(Loan, { where: { id: req.params.loanId } });
    if (!loan) throw notFound('Loan');

    const payable = await getPayableNow(em, loan.id);
    const outstanding = totalOutstanding(getBalances(loan));
    const settledBeforeTermEnd = payable.nextPendingPeriod !== null;
    const fee = computeEarlySettlementFee(
      num(loan.outstandingPastPrincipal),
      num(loan.earlySettlementFeePercent),
      settledBeforeTermEnd,
    );

    res.json({
      data: {
        loanId: loan.id,
        loanNumber: loan.loanNumber,
        status: loan.status,
        feePercent: num(loan.earlySettlementFeePercent),
        principalOutstanding: num(loan.outstandingPastPrincipal),
        settledBeforeTermEnd,
        fee,
        outstanding,
        totalDue: round2(outstanding + fee),
        nextPendingPeriod: payable.nextPendingPeriod,
      },
    });
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const agreement = await em.findOne(SettlementAgreement, { where: { id: req.params.id } });
    if (!agreement) throw notFound('Settlement agreement');

    const [requests, transactions] = await Promise.all([
      em.find(PaymentRequest, { where: { settlementAgreementId: agreement.id } }),
      em.find(FinancialTransaction, { where: { settlementAgreementId: agreement.id } }),
    ]);
    res.json({ data: { agreement, paymentRequests: requests, transactions } });
  })
);

/**
 * Creates the payment request that executes this settlement agreement.
 * The agreement itself changes nothing — only the POSTED settlement payment does
 * (locked section 16).
 */
router.post(
  '/:id/settlement-payment',
  requireRole(...OPERATOR_ROLES),
  validateBody(settlementPaymentSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { cashAmount, creditToApply, note } = req.body;

    const em = getDataSource().manager;
    const agreement = await em.findOne(SettlementAgreement, { where: { id: req.params.id } });
    if (!agreement) throw notFound('Settlement agreement');
    const loan = await em.findOne(Loan, { where: { id: agreement.loanId } });
    if (!loan) throw notFound('Loan');
    if (loan.status !== LoanStatus.ACTIVE) {
      throw unprocessable(`Loan is ${loan.status} — cannot accept settlement payment`);
    }

    const paymentTotal = round2(num(cashAmount) + num(creditToApply ?? 0));
    if (paymentTotal <= EPS) throw badRequest('Settlement payment amount must be greater than zero');
    validateSettlementPayment(agreement, loan.id, paymentTotal);
    await assertAgreementFeeBilled(em, agreement);

    const result = await getDataSource().transaction(async (trx) =>
      createPaymentRequestRecord(trx, {
        loanId: agreement.loanId,
        cashAmount: num(cashAmount),
        creditApplied: num(creditToApply ?? 0),
        settlementAgreementId: agreement.id,
        note: note ?? `Settlement payment for agreement ${agreement.agreementNo}`,
        previousRequestId: null,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.status(201).json({ data: result });
  })
);

/**
 * Waives the remaining shortfall after the settlement payment — a SEPARATE
 * waiver transaction with its own approval workflow (locked sections 16, 12).
 */
router.post(
  '/:id/waive-shortfall',
  requireRole(...OPERATOR_ROLES),
  validateBody(waiveShortfallSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body;

    const result = await getDataSource().transaction(async (em) => {
      const agreement = await em.findOne(SettlementAgreement, { where: { id: req.params.id } });
      if (!agreement) throw notFound('Settlement agreement');
      if (agreement.status !== SettlementStatus.APPROVED) {
        throw unprocessable(`Settlement agreement is ${agreement.status}`);
      }
      const loan = await em.findOne(Loan, {
        where: { id: agreement.loanId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!loan) throw notFound('Loan');

      const postedPayments = await em.find(FinancialTransaction, {
        where: {
          settlementAgreementId: agreement.id,
          transactionType: TransactionType.SETTLEMENT_PAYMENT,
          status: TransactionStatus.POSTED,
        },
      });
      const paymentIds = postedPayments.map((payment) => payment.id);
      const postedReversals = paymentIds.length
        ? await em.find(FinancialTransaction, {
            where: {
              referenceTransactionId: In(paymentIds),
              transactionType: TransactionType.PAYMENT_REVERSAL,
              status: TransactionStatus.POSTED,
            },
          })
        : [];
      validateSettlementShortfallWaiver(
        agreement,
        postedPayments.reduce((total, payment) => total + num(payment.amount), 0),
        postedReversals.reduce((total, reversal) => total + num(reversal.amount), 0),
      );

      const shortfall = getBalances(loan);
      const shortfallTotal = round2(
        num(shortfall.PENALTY) + num(shortfall.PAST_INTEREST) + num(shortfall.PAST_PRINCIPAL),
      );
      if (shortfallTotal <= EPS) {
        throw unprocessable('There is no outstanding shortfall to waive');
      }

      return createWaiverFromSettlement(em, {
        loan,
        settlementAgreementId: agreement.id,
        components: shortfall,
        reason: `${reason} (settlement shortfall for agreement ${agreement.agreementNo})`,
        user,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });

    res.status(201).json({ data: result });
  })
);

export default router;
