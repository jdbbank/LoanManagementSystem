import { EntityManager } from 'typeorm';
import { Loan } from '../entities/loan.entity';
import { LoanStatus, SchedulePeriodStatus } from '../entities/types';
import { notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { getBalances, totalOutstanding } from './loan-balance.service';
import { getLoanSchedule, isPeriodArrived, LoanSchedulePeriod } from './loan-schedule.service';

/**
 * What a customer may hand over today.
 *
 * The ledger says what is owed in total; only the schedule says which instalments have actually
 * arrived. A flat-rate loan is billed in full at disbursement, so "outstanding" alone would let
 * staff collect period 12 of a 12-month loan in month one. Money brought early is a deposit
 * against the customer's credit, not a payment — and the auto-debit job settles the period from
 * that credit once it arrives.
 */

export interface PayablePeriod {
  index: number;
  dueDate: Date;
  outstanding: number;
  penaltyBilled: number;
  collectable: number;
  status: SchedulePeriodStatus;
}

export interface PayableNow {
  loanId: string;
  loanNumber: string;
  asOf: Date;
  /** Highest payment the system accepts right now. */
  maxPayable: number;
  /** Sum of the instalments that have arrived, before the ledger ceiling is applied. */
  dueToPay: number;
  /** Everything the loan owes, including instalments that have not arrived yet. */
  ledgerOutstanding: number;
  duePeriods: PayablePeriod[];
  /** Next instalment the customer cannot pay yet, so the UI can name the date. */
  nextPendingPeriod: { index: number; dueDate: Date; amount: number } | null;
  creditBalance: number;
}

function collectableOf(period: LoanSchedulePeriod): number {
  return round2(period.outstanding + period.penaltyBilled);
}

export interface PayableOptions {
  /**
   * How many days before its due date an instalment counts as collectable. Staff payments use the
   * product's grace window (the default); the auto-debit job passes its own configured lead, which
   * is how it may settle an instalment a few days early from credit the customer already deposited.
   */
  collectLeadDays?: number;
}

export async function getPayableNow(
  em: EntityManager,
  loanId: string,
  asOf: Date = new Date(),
  options: PayableOptions = {},
): Promise<PayableNow> {
  const schedule = await getLoanSchedule(em, loanId, asOf);
  const loan = await em.findOne(Loan, { where: { id: loanId } });
  if (!loan) throw notFound('Loan');

  const leadDays = options.collectLeadDays ?? num(schedule.penaltyPolicy.graceDays);
  const duePeriods: PayablePeriod[] = [];
  let nextPending: PayableNow['nextPendingPeriod'] = null;

  for (const period of schedule.periods) {
    const collectable = collectableOf(period);
    if (period.status === SchedulePeriodStatus.PAID || collectable <= EPS) continue;
    if (isPeriodArrived(period, leadDays, asOf)) {
      duePeriods.push({
        index: period.index,
        dueDate: period.dueDate,
        outstanding: period.outstanding,
        penaltyBilled: period.penaltyBilled,
        collectable,
        status: period.status,
      });
      continue;
    }
    if (!nextPending) {
      nextPending = { index: period.index, dueDate: period.dueDate, amount: collectable };
    }
  }

  const dueToPay = round2(duePeriods.reduce((acc, p) => acc + p.collectable, 0));
  const ledgerOutstanding = totalOutstanding(getBalances(loan));

  return {
    loanId: loan.id,
    loanNumber: loan.loanNumber,
    asOf,
    maxPayable: round2(Math.min(dueToPay, ledgerOutstanding)),
    dueToPay,
    ledgerOutstanding,
    duePeriods,
    nextPendingPeriod: nextPending,
    creditBalance: schedule.totals.creditBalance,
  };
}

/**
 * The collection gate. Staff can settle every instalment that has arrived and not one amount more;
 * the ceiling is what the posting engine would otherwise push into future periods.
 *
 * Settlement payments are deliberately not gated here: paying the whole debt off early is a
 * negotiated event with its own agreement ceiling (and its own early-settlement fee).
 */
export async function assertPaymentWithinDueScope(
  em: EntityManager,
  loan: Loan,
  paymentTotal: number,
  asOf: Date = new Date(),
  options: PayableOptions = {},
): Promise<PayableNow> {
  if (loan.status !== LoanStatus.ACTIVE) return getPayableNow(em, loan.id, asOf, options);

  const payable = await getPayableNow(em, loan.id, asOf, options);
  if (paymentTotal <= payable.maxPayable + EPS) return payable;

  const indices = payable.duePeriods.map((p) => p.index);
  const arrived =
    indices.length === 0
      ? 'no instalment has arrived yet'
      : indices.length === 1
        ? `period ${indices[0]}`
        : `periods ${indices[0]}-${indices[indices.length - 1]} (${indices.length} instalments)`;
  const next = payable.nextPendingPeriod
    ? ` Next instalment ${payable.nextPendingPeriod.index} falls due on ${payable.nextPendingPeriod.dueDate
        .toISOString()
        .slice(0, 10)}.`
    : '';
  throw unprocessable(
    `Only ${payable.maxPayable.toFixed(2)} LAK is due on loan ${loan.loanNumber} today (${arrived}), ` +
      `but ${paymentTotal.toFixed(2)} was requested. Bring the rest as a deposit to credit — ` +
      `the system auto-debits it when the instalment falls due.${next}`,
    {
      loanId: loan.id,
      maxPayable: payable.maxPayable,
      requested: paymentTotal,
      duePeriods: payable.duePeriods,
      nextPendingPeriod: payable.nextPendingPeriod,
    },
  );
}
