import { In, EntityManager } from 'typeorm';
import { Loan } from '../entities/loan.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { InterestMethod, LoanStatus, TransactionStatus, TransactionType } from '../entities/types';
import { EPS, num, round2 } from '../utils/money';
import { addCalendarMonths, decliningPeriodInterest, periodCount } from '../utils/period';

/**
 * Declining-balance interest ("ต้นเท่า ดอกลด").
 *
 * Nothing here is stored as a schedule: the ledger is the truth, so a period's interest is a normal
 * PENDING_APPROVAL charge that a checker approves and the posting engine books. This module only
 * answers "which periods of this loan have begun and were never billed, and what is each worth at
 * the principal outstanding right now" — the same shape as the penalty accrual it sits beside.
 */

export interface InterestPeriodDue {
  loanId: string;
  periodIndex: number;
  periodStart: Date;
  dueDate: Date;
  /** Principal still owed, the base the charge is priced on. */
  baseOutstandingPrincipal: number;
  amount: number;
}

export interface InterestAccrualSkip {
  loanId: string;
  loanNumber?: string;
  reason: string;
}

/** Period indexes already billed (or awaiting approval) — REJECTED charges do not block a re-bill. */
async function chargedPeriods(em: EntityManager, loanIds: string[]): Promise<Map<string, Set<number>>> {
  const rows = await em.find(FinancialTransaction, {
    where: {
      loanId: In(loanIds),
      transactionType: In([TransactionType.DISBURSEMENT, TransactionType.INTEREST_ACCRUAL]),
      status: In([TransactionStatus.PENDING_APPROVAL, TransactionStatus.APPROVED, TransactionStatus.POSTED]),
    },
    select: ['loanId', 'periodIndex'],
  });
  const byLoan = new Map<string, Set<number>>();
  for (const row of rows) {
    // A disbursement without a periodIndex is a FLAT lump-sum booking; DECLINING sets it to 1.
    if (row.periodIndex === null || row.periodIndex === undefined) continue;
    const set = byLoan.get(row.loanId) ?? new Set<number>();
    set.add(num(row.periodIndex));
    byLoan.set(row.loanId, set);
  }
  return byLoan;
}

/**
 * Periods of one DECLINING loan that have started and were never billed, oldest first.
 * `null` means the loan is not on declining interest and no period accrual applies.
 */
export async function dueInterestPeriods(
  em: EntityManager,
  loan: Loan,
  asOf: Date,
  alreadyCharged?: Set<number>,
): Promise<InterestPeriodDue[] | null> {
  if (loan.interestMethod !== InterestMethod.DECLINING) return null;

  const charged = alreadyCharged ?? (await chargedPeriods(em, [loan.id])).get(loan.id) ?? new Set<number>();
  const disbursedAt = loan.disbursedAt ?? loan.createdAt;
  const count = loan.termValue > 0 ? periodCount(loan.termValue, loan.termUnit) : Math.max(1, num(loan.termMonths));

  const due: InterestPeriodDue[] = [];
  for (let index = 1; index <= count; index += 1) {
    if (charged.has(index)) continue;
    const periodStart = addCalendarMonths(disbursedAt, index - 1);
    // Interest is priced for the period the customer is entering, so the window must have begun.
    if (periodStart.getTime() > asOf.getTime()) continue;
    const amount = decliningPeriodInterest(loan.outstandingPastPrincipal, loan.interestRate, loan.interestRatePeriod);
    if (amount <= EPS) break;
    due.push({
      loanId: loan.id,
      periodIndex: index,
      periodStart,
      dueDate: addCalendarMonths(disbursedAt, index),
      baseOutstandingPrincipal: round2(num(loan.outstandingPastPrincipal)),
      amount,
    });
  }
  return due;
}

export interface DueInterestResult {
  asOf: Date;
  items: Array<InterestPeriodDue & {
    loanNumber: string;
    customerId: string;
    termPeriods: number;
    missingPeriods: number;
  }>;
  skipped: InterestAccrualSkip[];
}

/** The whole portfolio view behind `GET /transactions/interest/due` and the bulk accrue action. */
export async function listDueInterest(
  em: EntityManager,
  asOf: Date = new Date(),
  loanIds?: string[],
): Promise<DueInterestResult> {
  const loans = await em.find(Loan, {
    where: {
      interestMethod: InterestMethod.DECLINING,
      status: LoanStatus.ACTIVE,
      ...(loanIds?.length ? { id: In(loanIds) } : {}),
    },
    order: { disbursedAt: 'ASC', loanNumber: 'ASC' },
  });

  const byLoan = await chargedPeriods(em, loans.map((l) => l.id));
  const items: DueInterestResult['items'] = [];
  const skipped: InterestAccrualSkip[] = [];

  for (const loan of loans) {
    const due = (await dueInterestPeriods(em, loan, asOf, byLoan.get(loan.id))) ?? [];
    if (due.length === 0) {
      skipped.push({
        loanId: loan.id,
        loanNumber: loan.loanNumber,
        reason:
          num(loan.outstandingPastPrincipal) <= EPS
            ? 'No principal left to charge interest on'
            : 'Every period that has started is already billed',
      });
      continue;
    }
    // One charge per loan per run: each period is priced on the balance when it is billed, so
    // billing several back-periods at once would price them all on today's balance.
    const count = loan.termValue > 0 ? periodCount(loan.termValue, loan.termUnit) : Math.max(1, num(loan.termMonths));
    const next = due[0];
    items.push({
      ...next,
      loanNumber: loan.loanNumber,
      customerId: loan.customerId,
      termPeriods: count,
      missingPeriods: due.length,
    });
  }

  return { asOf, items, skipped };
}
