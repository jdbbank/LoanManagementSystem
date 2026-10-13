import { Router, Request, Response } from 'express';
import { Customer } from '../entities/customer.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { Loan } from '../entities/loan.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { ApprovalWorkflow } from '../entities/approval-workflow.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { LoanStatus, PaymentRequestStatus, TransactionStatus, WorkflowStatus } from '../entities/types';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { num, round2 } from '../utils/money';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

router.get(
  '/stats',
  asyncHandler(async (_req: Request, res: Response) => {
    const em = getDataSource().manager;

    const [customers, loans, pendingRequests, pendingWorkflows, postedTransactions, credits] = await Promise.all([
      em.count(Customer),
      em.find(Loan, {}),
      em.count(PaymentRequest, { where: { status: PaymentRequestStatus.PENDING } }),
      em.count(ApprovalWorkflow, { where: { status: WorkflowStatus.PENDING } }),
      em.count(FinancialTransaction, { where: { status: TransactionStatus.POSTED } }),
      em.find(CustomerCredit, {}),
    ]);

    const loansByStatus: Record<string, number> = {};
    let totalOutstanding = 0;
    let activeOutstanding = 0;
    for (const loan of loans) {
      loansByStatus[loan.status] = (loansByStatus[loan.status] ?? 0) + 1;
      const total = round2(
        num(loan.outstandingPenalty) + num(loan.outstandingPastInterest) + num(loan.outstandingPastPrincipal),
      );
      totalOutstanding = round2(totalOutstanding + total);
      if (loan.status === LoanStatus.ACTIVE) activeOutstanding = round2(activeOutstanding + total);
    }

    const totalCredit = credits.reduce((sum, c) => round2(sum + num(c.balance)), 0);

    res.json({
      data: {
        customers,
        loans: loans.length,
        loansByStatus,
        pendingPaymentRequests: pendingRequests,
        pendingApprovals: pendingWorkflows,
        postedTransactions,
        totalOutstanding,
        activeOutstanding,
        totalCustomerCredit: totalCredit,
      },
    });
  })
);

router.get(
  '/recent-activity',
  asyncHandler(async (_req: Request, res: Response) => {
    const transactions = await getDataSource().manager.find(FinancialTransaction, {
      order: { createdAt: 'DESC' },
      take: 10,
    });
    res.json({ data: transactions });
  })
);

export default router;
