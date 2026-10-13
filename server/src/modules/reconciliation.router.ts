import { Router, Request, Response } from 'express';
import { EntityManager, In } from 'typeorm';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { ReconciliationRecord } from '../entities/reconciliation-record.entity';
import {
  ComponentAmounts,
  ComponentType,
  LoanStatus,
  ReconciliationStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { writeAudit } from '../services/audit.service';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

/**
 * Sums all POSTED transaction lines per loan into per-component outstanding.
 * This is the financial truth used to verify the operational balances
 * (locked requirement sections 3, 26.20).
 */
async function computePostedHistory(em: EntityManager, loanId: string): Promise<ComponentAmounts> {
  const posted = await em.find(FinancialTransaction, {
    where: { loanId, status: TransactionStatus.POSTED },
  });
  const lines = await em.find(FinancialTransactionLine, {
    where: { transactionId: In(posted.map((t) => t.id)) },
  });
  const result: ComponentAmounts = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 };
  for (const line of lines) {
    result[line.component] = round2(num(result[line.component]) + num(line.amount));
  }
  return result;
}

function differences(operational: ComponentAmounts, computed: ComponentAmounts): ComponentAmounts {
  return {
    PENALTY: round2(num(operational.PENALTY) - num(computed.PENALTY)),
    PAST_INTEREST: round2(num(operational.PAST_INTEREST) - num(computed.PAST_INTEREST)),
    PAST_PRINCIPAL: round2(num(operational.PAST_PRINCIPAL) - num(computed.PAST_PRINCIPAL)),
  };
}

function isMatch(difference: ComponentAmounts): boolean {
  return (
    Math.abs(num(difference.PENALTY)) < EPS &&
    Math.abs(num(difference.PAST_INTEREST)) < EPS &&
    Math.abs(num(difference.PAST_PRINCIPAL)) < EPS
  );
}

router.post(
  '/run',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const loanId = typeof req.query.loanId === 'string' && req.query.loanId ? req.query.loanId : null;

    const records = await getDataSource().transaction(async (em) => {
      const loans = loanId
        ? await em.find(Loan, { where: { id: loanId } })
        : await em.find(Loan, {});

      const created: ReconciliationRecord[] = [];
      for (const loan of loans) {
        const operational: ComponentAmounts = {
          PENALTY: num(loan.outstandingPenalty),
          PAST_INTEREST: num(loan.outstandingPastInterest),
          PAST_PRINCIPAL: num(loan.outstandingPastPrincipal),
        };
        const computed = await computePostedHistory(em, loan.id);
        const difference = differences(operational, computed);
        const status = isMatch(difference) ? ReconciliationStatus.MATCHED : ReconciliationStatus.MISMATCHED;

        const record = em.create(ReconciliationRecord, {
          loanId: loan.id,
          status,
          operationalOutstanding: operational,
          computedFromHistory: computed,
          difference,
          runBy: user.id,
        });
        await em.save(ReconciliationRecord, record);
        created.push(record);

        if (status === ReconciliationStatus.MISMATCHED) {
          // A mismatch is recorded, never auto-corrected (locked section 3).
          await writeAudit(em, {
            action: 'RECONCILIATION_MISMATCH',
            loanId: loan.id,
            customerId: loan.customerId,
            userId: user.id,
            previousBalance: {
              ...operational,
              total: round2(num(operational.PENALTY) + num(operational.PAST_INTEREST) + num(operational.PAST_PRINCIPAL)),
            },
            newBalance: {
              ...computed,
              total: round2(num(computed.PENALTY) + num(computed.PAST_INTEREST) + num(computed.PAST_PRINCIPAL)),
            },
            amount: Math.abs(num(difference.PENALTY)) + Math.abs(num(difference.PAST_INTEREST)) + Math.abs(num(difference.PAST_PRINCIPAL)),
            reason: `Operational outstanding differs from posted transaction history. Resolve via approved adjustment — never by editing balances.`,
            ip: req.ip,
            userAgent: req.headers['user-agent'],
          });
        }
      }
      return created;
    });

    res.json({
      data: {
        total: records.length,
        matched: records.filter((r) => r.status === ReconciliationStatus.MATCHED).length,
        mismatched: records.filter((r) => r.status === ReconciliationStatus.MISMATCHED).length,
        records,
      },
    });
  })
);

router.get(
  '/records',
  asyncHandler(async (req: Request, res: Response) => {
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as ReconciliationStatus)
        : undefined;
    const loanId = typeof req.query.loanId === 'string' && req.query.loanId ? req.query.loanId : undefined;

    const repo = getDataSource().getRepository(ReconciliationRecord);
    const qb = repo.createQueryBuilder('record');
    if (status) qb.andWhere('record.status = :status', { status });
    if (loanId) qb.andWhere('record.loanId = :loanId', { loanId });
    const [records, total] = await qb
      .orderBy('record.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
    res.json({ data: records, pagination: { page, limit, total } });
  })
);

router.get(
  '/records/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const record = await getDataSource().manager.findOne(ReconciliationRecord, { where: { id: req.params.id } });
    if (!record) throw notFound('Reconciliation record');
    res.json({ data: record });
  })
);

export default router;
