import { EntityManager } from 'typeorm';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import {
  ComponentAmounts,
  ComponentType,
  DEFAULT_PENALTY_POLICY,
  PenaltyMode,
  PenaltyPolicy,
  PeriodUnit,
  SchedulePeriodStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { EPS, num, round2 } from '../utils/money';
import {
  addCalendarMonths,
  DAYS_PER_UNIT,
  elapsedDays,
  periodCount,
  splitAcross,
  termMonthsOf,
} from '../utils/period';

/**
 * Installment view of a loan.
 *
 * Financial truth stays where the locked requirements put it (section 2.1): nothing here is stored.
 * The plan is split from the amounts the ledger actually charged, payments are applied oldest
 * period first, and every figure is recomputed from POSTED transactions at read time — so the
 * schedule can never disagree with the balance or need a backfill for old loans.
 */

/** Transaction types that raise a charge against the customer. */
const CHARGE_TYPES: TransactionType[] = [
  TransactionType.DISBURSEMENT,
  TransactionType.PENALTY,
  TransactionType.ADJUSTMENT,
];

/** Money the customer actually handed over; a reversal line takes it back again. */
const PAYMENT_TYPES: TransactionType[] = [
  TransactionType.PAYMENT,
  TransactionType.SETTLEMENT_PAYMENT,
  TransactionType.PAYMENT_REVERSAL,
];

/**
 * Relief granted by staff (waiver, write-off) and the reversal of a write-off. It settles a debt
 * but is not a payment, so it must never be reported as one.
 */
const RELIEF_TYPES: TransactionType[] = [
  TransactionType.WAIVER,
  TransactionType.WRITE_OFF,
  TransactionType.WRITE_OFF_REVERSAL,
];

export interface LoanSchedulePeriod {
  index: number;
  periodStart: Date;
  dueDate: Date;
  principalDue: number;
  interestDue: number;
  principalPaid: number;
  interestPaid: number;
  /** Waiver or write-off applied to this period — settles the debt but is not a payment. */
  principalRelieved: number;
  interestRelieved: number;
  penaltyAccrued: number;
  penaltyBilled: number;
  due: number;
  paid: number;
  relieved: number;
  outstanding: number;
  overdueDays: number;
  status: SchedulePeriodStatus;
}

export interface LoanScheduleTotals {
  principalCharged: number;
  interestCharged: number;
  penaltyCharged: number;
  penaltyRelieved: number;
  penaltyAccrued: number;
  penaltySuggested: number;
  paid: ComponentAmounts;
  relieved: ComponentAmounts;
  outstanding: ComponentAmounts;
  totalCharged: number;
  totalOutstanding: number;
  creditBalance: number;
}

export interface LoanScheduleAging {
  overduePeriods: number;
  unpaidPeriods: number;
  maxOverdueDays: number;
  nextDueDate: Date | null;
  maturityDate: Date;
}

export interface LoanSchedule {
  loanId: string;
  loanNumber: string;
  customerId: string;
  currency: string;
  asOf: Date;
  disbursedAt: Date;
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  periodCount: number;
  penaltyPolicy: PenaltyPolicy;
  totals: LoanScheduleTotals;
  aging: LoanScheduleAging;
  periods: LoanSchedulePeriod[];
}

interface ComponentSums {
  charged: ComponentAmounts;
  paid: ComponentAmounts;
  relieved: ComponentAmounts;
}

const zeroComponents = (): ComponentAmounts => ({ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 });

/** Per-component sums of posted ledger lines, split into charges, cash and staff relief. */
async function readComponentSums(em: EntityManager, loanId: string): Promise<ComponentSums> {
  const rows: Array<{ component: ComponentType; amount: string | number; type: TransactionType }> =
    await em
      .createQueryBuilder()
      .select('line.component', 'component')
      .addSelect('line.amount', 'amount')
      .addSelect('tx.transactionType', 'type')
      .from(FinancialTransactionLine, 'line')
      .innerJoin(FinancialTransaction, 'tx', 'tx.id = line.transactionId')
      .where('tx.loanId = :loanId', { loanId })
      .andWhere('tx.status = :status', { status: TransactionStatus.POSTED })
      .getRawMany();

  const charged = zeroComponents();
  const paid = zeroComponents();
  const relieved = zeroComponents();
  for (const row of rows) {
    const amount = num(row.amount);
    // Relief lines are stored negative, so subtracting them turns the pools back into positive sums.
    if (CHARGE_TYPES.includes(row.type)) charged[row.component] = round2(charged[row.component] + amount);
    else if (PAYMENT_TYPES.includes(row.type)) paid[row.component] = round2(paid[row.component] - amount);
    else if (RELIEF_TYPES.includes(row.type)) relieved[row.component] = round2(relieved[row.component] - amount);
  }
  return { charged, paid, relieved };
}

/** Penalties are stored in months-of-term order; the loan's own term fields are the snapshot. */
export function resolvePenaltyPolicy(loan: Loan, product?: LoanProduct | null): PenaltyPolicy {
  return loan.penaltyPolicy ?? product?.penaltyPolicy ?? DEFAULT_PENALTY_POLICY;
}

/** Term as configured, falling back to the canonical months stored on pre-unit loans. */
function resolveTerm(loan: Loan): { termValue: number; termUnit: PeriodUnit } {
  if (loan.termValue > 0 && loan.termUnit) return { termValue: loan.termValue, termUnit: loan.termUnit };
  return { termValue: loan.termMonths, termUnit: PeriodUnit.MONTH };
}

export function penaltyForPeriod(
  policy: PenaltyPolicy,
  unpaidBase: number,
  overdueDays: number,
): number {
  if (policy.mode === PenaltyMode.NONE || overdueDays <= 0 || unpaidBase <= EPS) return 0;
  const unitDays = DAYS_PER_UNIT[policy.period];
  if (policy.mode === PenaltyMode.FIXED_PER_PERIOD) {
    const units = Math.ceil(overdueDays / unitDays);
    return round2(num(policy.amount) * units);
  }
  return round2(unpaidBase * (num(policy.ratePercent) / 100) * (overdueDays / unitDays));
}

/** Apply the product ceiling by trimming the newest periods first. */
export function capAccruedPenalties(periods: LoanSchedulePeriod[], policy: PenaltyPolicy, principal: number): void {
  const capPercent = num(policy.maxPercentOfPrincipal);
  if (capPercent <= 0) return;
  const cap = round2((principal * capPercent) / 100);
  let total = round2(periods.reduce((acc, p) => acc + p.penaltyAccrued, 0));
  for (let i = periods.length - 1; i >= 0 && total > cap; i -= 1) {
    const trimmed = Math.min(periods[i].penaltyAccrued, round2(total - cap));
    periods[i].penaltyAccrued = round2(periods[i].penaltyAccrued - trimmed);
    total = round2(total - trimmed);
  }
}

/** Spread penalty actually billed over the periods, oldest accrued first. */
export function spreadBilledPenalty(periods: LoanSchedulePeriod[], billed: number): void {
  let remaining = round2(billed);
  for (const period of periods) {
    const applied = Math.min(remaining, period.penaltyAccrued);
    if (applied <= EPS) continue;
    period.penaltyBilled = round2(applied);
    remaining = round2(remaining - applied);
  }
  if (remaining > EPS) {
    const first = periods.find((p) => p.outstanding > EPS) ?? periods[0];
    if (first) first.penaltyBilled = round2(first.penaltyBilled + remaining);
  }
}

export function periodStatus(period: LoanSchedulePeriod, graceDays: number, asOf: Date): SchedulePeriodStatus {
  const scheduledDue = round2(period.principalDue + period.interestDue);
  const settled = round2(period.paid + period.relieved);
  if (scheduledDue > EPS && settled >= scheduledDue - EPS) return SchedulePeriodStatus.PAID;
  // Past the due date a period is overdue whether or not part of it has been paid.
  if (period.overdueDays > 0) return SchedulePeriodStatus.OVERDUE;
  if (settled > EPS) return SchedulePeriodStatus.PARTIAL;
  if (period.dueDate.getTime() - graceDays * 86_400_000 <= asOf.getTime()) return SchedulePeriodStatus.DUE;
  return SchedulePeriodStatus.PENDING;
}

export async function getLoanSchedule(
  em: EntityManager,
  loanId: string,
  asOf: Date = new Date(),
): Promise<LoanSchedule> {
  const loan = await em.findOne(Loan, { where: { id: loanId } });
  if (!loan) throw new Error(`Loan ${loanId} not found`);

  const [{ charged, paid, relieved }, product, credit] = await Promise.all([
    readComponentSums(em, loan.id),
    em.findOne(LoanProduct, { where: { id: loan.productId } }),
    em.findOne(CustomerCredit, { where: { customerId: loan.customerId, currency: loan.currency } }),
  ]);

  const disbursedAt = loan.disbursedAt ?? loan.createdAt;
  const policy = resolvePenaltyPolicy(loan, product);
  const { termValue, termUnit } = resolveTerm(loan);
  const count = periodCount(termValue, termUnit);

  const principalShares = splitAcross(charged.PAST_PRINCIPAL, count);
  const interestShares = splitAcross(charged.PAST_INTEREST, count);

  // Cash and staff relief are both applied oldest period first, mirroring the locked allocation
  // order one level down: the ledger decides how much of the debt is gone, the schedule decides
  // which month it cleared. They stay counted apart, because a waiver is not a payment.
  let principalCash = paid.PAST_PRINCIPAL;
  let interestCash = paid.PAST_INTEREST;
  let principalRelief = relieved.PAST_PRINCIPAL;
  let interestRelief = relieved.PAST_INTEREST;

  const periods: LoanSchedulePeriod[] = [];
  for (let i = 0; i < count; i += 1) {
    const periodStart = addCalendarMonths(disbursedAt, i);
    const dueDate = addCalendarMonths(disbursedAt, i + 1);
    const principalDue = principalShares[i];
    const interestDue = interestShares[i];

    const principalPaid = Math.max(0, Math.min(principalCash, principalDue));
    principalCash = round2(principalCash - principalPaid);
    const principalRelieved = Math.max(0, Math.min(principalRelief, round2(principalDue - principalPaid)));
    principalRelief = round2(principalRelief - principalRelieved);
    const interestPaid = Math.max(0, Math.min(interestCash, interestDue));
    interestCash = round2(interestCash - interestPaid);
    const interestRelieved = Math.max(0, Math.min(interestRelief, round2(interestDue - interestPaid)));
    interestRelief = round2(interestRelief - interestRelieved);

    const scheduledTotal = round2(principalDue + interestDue);
    const periodPaid = round2(principalPaid + interestPaid);
    const periodRelieved = round2(principalRelieved + interestRelieved);
    const outstanding = round2(scheduledTotal - periodPaid - periodRelieved);
    const graceDue = new Date(dueDate.getTime() + num(policy.graceDays) * 86_400_000);
    const overdueDays = elapsedDays(graceDue, asOf);

    const period: LoanSchedulePeriod = {
      index: i + 1,
      periodStart,
      dueDate,
      principalDue,
      interestDue,
      principalPaid,
      interestPaid,
      principalRelieved,
      interestRelieved,
      penaltyAccrued: 0,
      penaltyBilled: 0,
      due: scheduledTotal,
      paid: periodPaid,
      relieved: periodRelieved,
      outstanding,
      overdueDays,
      status: SchedulePeriodStatus.PENDING,
    };
    period.penaltyAccrued = penaltyForPeriod(policy, outstanding, overdueDays);
    period.status = periodStatus(period, num(policy.graceDays), asOf);
    periods.push(period);
  }

  capAccruedPenalties(periods, policy, loan.principalAmount);
  const penaltyAccrued = round2(periods.reduce((acc, p) => acc + p.penaltyAccrued, 0));
  spreadBilledPenalty(periods, charged.PENALTY);

  const outstanding: ComponentAmounts = {
    PENALTY: loan.outstandingPenalty,
    PAST_INTEREST: loan.outstandingPastInterest,
    PAST_PRINCIPAL: loan.outstandingPastPrincipal,
  };

  const overdue = periods.filter((p) => p.status === SchedulePeriodStatus.OVERDUE);
  const aging: LoanScheduleAging = {
    overduePeriods: overdue.length,
    unpaidPeriods: periods.filter((p) => p.outstanding > EPS).length,
    maxOverdueDays: overdue.reduce((max, p) => Math.max(max, p.overdueDays), 0),
    nextDueDate: periods.find((p) => p.outstanding > EPS)?.dueDate ?? null,
    maturityDate: periods[periods.length - 1]?.dueDate ?? disbursedAt,
  };

  const totals: LoanScheduleTotals = {
    principalCharged: charged.PAST_PRINCIPAL,
    interestCharged: charged.PAST_INTEREST,
    penaltyCharged: charged.PENALTY,
    penaltyRelieved: relieved.PENALTY,
    penaltyAccrued,
    penaltySuggested: round2(Math.max(0, penaltyAccrued - charged.PENALTY - relieved.PENALTY)),
    paid,
    relieved,
    outstanding,
    totalCharged: round2(charged.PAST_PRINCIPAL + charged.PAST_INTEREST + charged.PENALTY),
    totalOutstanding: round2(outstanding.PENALTY + outstanding.PAST_INTEREST + outstanding.PAST_PRINCIPAL),
    creditBalance: credit ? num(credit.balance) : 0,
  };

  return {
    loanId: loan.id,
    loanNumber: loan.loanNumber,
    customerId: loan.customerId,
    currency: loan.currency,
    asOf,
    disbursedAt,
    interestRate: loan.interestRate,
    interestRatePeriod: loan.interestRatePeriod ?? PeriodUnit.YEAR,
    termValue,
    termUnit,
    termMonths: termMonthsOf(termValue, termUnit),
    periodCount: count,
    penaltyPolicy: policy,
    totals,
    aging,
    periods,
  };
}
