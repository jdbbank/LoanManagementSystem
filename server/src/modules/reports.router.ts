import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { FinancialTransactionLine } from '../entities/financial-transaction-line.entity';
import { Loan } from '../entities/loan.entity';
import { UserRole, ComponentType, TransactionStatus, TransactionType } from '../entities/types';
import { requireAuth, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { monthKey } from '../utils/period';
import { num, round2 } from '../utils/money';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth, requireRole(UserRole.ADMIN, UserRole.HEAD_APPROVER));

const MONTHS = "%Y-%m";

interface LedgerRaw {
  month: string;
  disbursed: string;
  moneyIn: string;
  reversed: string;
  writtenOff: string;
  waived: string;
  penaltyCharged: string;
  transactions: string;
}

interface ComponentRaw {
  month: string;
  principalPaid: string;
  interestPaid: string;
  penaltyPaid: string;
  interestAccrued: string;
  penaltyAdded: string;
  outstandingDelta: string;
}

/** Cash and postings per calendar month, straight from the POSTED ledger. */
async function ledgerByMonth(from: Date, customerId?: string): Promise<LedgerRaw[]> {
  const qb = getDataSource()
    .getRepository(FinancialTransaction)
    .createQueryBuilder('t')
    .select(`DATE_FORMAT(t.postedAt, '${MONTHS}')`, 'month')
    .addSelect('COALESCE(SUM(CASE WHEN t.transactionType = :disb THEN t.amount ELSE 0 END), 0)', 'disbursed')
    .addSelect(
      'COALESCE(SUM(CASE WHEN t.transactionType = :pay OR t.transactionType = :settle THEN t.amount ELSE 0 END), 0)',
      'moneyIn',
    )
    .addSelect('COALESCE(SUM(CASE WHEN t.transactionType = :rev THEN t.amount ELSE 0 END), 0)', 'reversed')
    .addSelect('COALESCE(SUM(CASE WHEN t.transactionType = :writeOff THEN t.amount ELSE 0 END), 0)', 'writtenOff')
    .addSelect('COALESCE(SUM(CASE WHEN t.transactionType = :waiver THEN t.amount ELSE 0 END), 0)', 'waived')
    .addSelect('COALESCE(SUM(CASE WHEN t.transactionType = :penalty THEN t.amount ELSE 0 END), 0)', 'penaltyCharged')
    .addSelect('COUNT(*)', 'transactions')
    .where('t.status = :posted', { posted: TransactionStatus.POSTED })
    .andWhere('t.postedAt >= :from', { from })
    .setParameters({
      disb: TransactionType.DISBURSEMENT,
      pay: TransactionType.PAYMENT,
      settle: TransactionType.SETTLEMENT_PAYMENT,
      rev: TransactionType.PAYMENT_REVERSAL,
      writeOff: TransactionType.WRITE_OFF,
      waiver: TransactionType.WAIVER,
      penalty: TransactionType.PENALTY,
    });

  if (customerId) qb.andWhere('t.customerId = :customerId', { customerId });
  return qb.groupBy('month').getRawMany<LedgerRaw>();
}

/**
 * Component split per month. Lines are the signed effect on outstanding, so a negative
 * PAST_INTEREST line is interest actually collected.
 */
async function componentsByMonth(from: Date, customerId?: string): Promise<ComponentRaw[]> {
  const qb = getDataSource()
    .getRepository(FinancialTransactionLine)
    .createQueryBuilder('line')
    .innerJoin(FinancialTransaction, 't', 't.id = line.transactionId')
    .select(`DATE_FORMAT(t.postedAt, '${MONTHS}')`, 'month')
    .addSelect(
      'COALESCE(SUM(CASE WHEN line.component = :principal AND line.amount < 0 THEN -line.amount ELSE 0 END), 0)',
      'principalPaid',
    )
    .addSelect(
      'COALESCE(SUM(CASE WHEN line.component = :interest AND line.amount < 0 THEN -line.amount ELSE 0 END), 0)',
      'interestPaid',
    )
    .addSelect(
      'COALESCE(SUM(CASE WHEN line.component = :penalty AND line.amount < 0 THEN -line.amount ELSE 0 END), 0)',
      'penaltyPaid',
    )
    .addSelect(
      'COALESCE(SUM(CASE WHEN line.component = :interest AND line.amount > 0 THEN line.amount ELSE 0 END), 0)',
      'interestAccrued',
    )
    .addSelect(
      'COALESCE(SUM(CASE WHEN line.component = :penalty AND line.amount > 0 THEN line.amount ELSE 0 END), 0)',
      'penaltyAdded',
    )
    .addSelect('COALESCE(SUM(line.amount), 0)', 'outstandingDelta')
    .where('t.status = :posted', { posted: TransactionStatus.POSTED })
    .andWhere('t.postedAt >= :from', { from })
    .setParameters({
      principal: ComponentType.PAST_PRINCIPAL,
      interest: ComponentType.PAST_INTEREST,
      penalty: ComponentType.PENALTY,
    });

  if (customerId) qb.andWhere('t.customerId = :customerId', { customerId });
  return qb.groupBy('month').getRawMany<ComponentRaw>();
}

const monthWindow = (value: string, shift: number): string => {
  const [year, month] = value.split('-').map(Number);
  return monthKey(new Date(Date.UTC(year, month - 1 + shift, 1)));
};

/** Growth against a month that is not in the window is unknown, not zero. */
function delta(current: number, previous: number | undefined): Growth {
  if (previous === undefined) return { absolute: 0, percent: null };
  const absolute = round2(current - previous);
  return { absolute, percent: previous === 0 ? null : round2((absolute / Math.abs(previous)) * 100) };
}

interface MonthFacts {
  disbursed: number;
  moneyIn: number;
  reversed: number;
  writtenOff: number;
  waived: number;
  penaltyCharged: number;
  principalPaid: number;
  interestPaid: number;
  penaltyPaid: number;
  interestAccrued: number;
  penaltyAdded: number;
  outstandingDelta: number;
  closingOutstanding: number;
  loansOpened: number;
  transactions: number;
}

interface Growth {
  absolute: number;
  percent: number | null;
}

interface Comparisons {
  collected: Growth;
  disbursed: Growth;
  outstanding: Growth;
}

interface ReportRow extends MonthFacts {
  month: string;
  collected: number;
  mom: Comparisons;
  yoy: Comparisons;
}

const querySchema = z.object({
  months: z.coerce.number().int().min(1).max(36).optional(),
  customerId: z.string().uuid().optional(),
});

/**
 * Monthly portfolio summary. YoY needs a full year of history beyond the requested window,
 * so the query window is widened and only the requested months are returned.
 */
router.get(
  '/monthly',
  asyncHandler(async (req: Request, res: Response) => {
    const parsed = querySchema.parse({
      months: typeof req.query.months === 'string' ? req.query.months : undefined,
      customerId: typeof req.query.customerId === 'string' && req.query.customerId ? req.query.customerId : undefined,
    });
    const windowMonths = parsed.months ?? 12;
    const customerId = parsed.customerId;

    const now = new Date();
    const currentMonth = monthKey(now);
    const windowStart = monthWindow(currentMonth, -(windowMonths - 1));
    // One extra year on top of the window so the same month last year is available.
    const queryStart = `${monthWindow(windowStart, -12)}-01T00:00:00.000Z`;

    const [ledger, components, opened, balances] = await Promise.all([
      ledgerByMonth(new Date(queryStart), customerId),
      componentsByMonth(new Date(queryStart), customerId),
      getDataSource()
        .getRepository(Loan)
        .createQueryBuilder('loan')
        .select(`DATE_FORMAT(loan.createdAt, '${MONTHS}')`, 'month')
        .addSelect('COUNT(*)', 'count')
        .where('loan.createdAt >= :from', { from: new Date(queryStart) })
        .groupBy('month')
        .getRawMany<{ month: string; count: string }>(),
      getDataSource()
        .getRepository(Loan)
        .createQueryBuilder('loan')
        .select('COALESCE(SUM(loan.currentOutstanding), 0)', 'outstanding')
        .getRawOne<{ outstanding: string }>(),
    ]);

    const cash = new Map(ledger.map((row) => [row.month, row]));
    const split = new Map(components.map((row) => [row.month, row]));
    const openedByMonth = new Map(opened.map((row) => [row.month, num(row.count)]));

    // Every queried month gets a slot, including the extra year used for YoY comparisons.
    const seen: string[] = [];
    for (let month = monthWindow(windowStart, -12); month <= currentMonth; month = monthWindow(month, 1)) {
      seen.push(month);
    }
    seen.sort();

    // The ledger is the only source of truth, so the opening balance is the sum of every
    // posted line before the window — not a snapshot taken today.
    let running = 0;
    const byMonth: Record<string, MonthFacts> = {};
    for (const month of seen) {
      const c = cash.get(month);
      const s = split.get(month);
      const outstandingDelta = round2(num(s?.outstandingDelta));
      running = round2(running + outstandingDelta);
      byMonth[month] = {
        disbursed: round2(num(c?.disbursed)),
        moneyIn: round2(num(c?.moneyIn)),
        reversed: round2(num(c?.reversed)),
        writtenOff: round2(num(c?.writtenOff)),
        waived: round2(num(c?.waived)),
        penaltyCharged: round2(num(c?.penaltyCharged)),
        principalPaid: round2(num(s?.principalPaid)),
        interestPaid: round2(num(s?.interestPaid)),
        penaltyPaid: round2(num(s?.penaltyPaid)),
        interestAccrued: round2(num(s?.interestAccrued)),
        penaltyAdded: round2(num(s?.penaltyAdded)),
        outstandingDelta,
        closingOutstanding: running,
        loansOpened: openedByMonth.get(month) ?? 0,
        transactions: num(c?.transactions),
      };
    }

    const rows = seen
      .filter((month) => month >= windowStart && month <= currentMonth)
      .map((month): ReportRow => {
        const row = byMonth[month];
        const previous = byMonth[monthWindow(month, -1)];
        const lastYear = byMonth[monthWindow(month, -12)];
        const collected = round2(row.moneyIn - row.reversed);
        return {
          month,
          ...row,
          collected,
          mom: {
            collected: delta(collected, previous ? round2(previous.moneyIn - previous.reversed) : undefined),
            disbursed: delta(row.disbursed, previous?.disbursed),
            outstanding: delta(row.closingOutstanding, previous?.closingOutstanding),
          },
          yoy: {
            collected: delta(collected, lastYear ? round2(lastYear.moneyIn - lastYear.reversed) : undefined),
            disbursed: delta(row.disbursed, lastYear?.disbursed),
            outstanding: delta(row.closingOutstanding, lastYear?.closingOutstanding),
          },
        };
      });

    const totals = rows.reduce(
      (acc, row) => ({
        disbursed: round2(acc.disbursed + row.disbursed),
        moneyIn: round2(acc.moneyIn + row.moneyIn),
        reversed: round2(acc.reversed + row.reversed),
        collected: round2(acc.collected + row.collected),
        interestPaid: round2(acc.interestPaid + row.interestPaid),
        penaltyPaid: round2(acc.penaltyPaid + row.penaltyPaid),
        writtenOff: round2(acc.writtenOff + row.writtenOff),
        loansOpened: acc.loansOpened + row.loansOpened,
      }),
      {
        disbursed: 0,
        moneyIn: 0,
        reversed: 0,
        collected: 0,
        interestPaid: 0,
        penaltyPaid: 0,
        writtenOff: 0,
        loansOpened: 0,
      },
    );

    res.json({
      data: {
        currency: 'LAK',
        from: windowStart,
        to: currentMonth,
        months: windowMonths,
        customerId: customerId ?? null,
        openingOutstanding: rows.length > 0 ? round2(rows[0].closingOutstanding - rows[0].outstandingDelta) : 0,
        closingOutstanding: rows.length > 0 ? rows[rows.length - 1].closingOutstanding : 0,
        loanBookOutstanding: round2(num(balances?.outstanding)),
        rows,
        totals,
      },
    });
  }),
);

export default router;
