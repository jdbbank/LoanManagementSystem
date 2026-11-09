import { randomUUID } from 'crypto';
import { In, EntityManager } from 'typeorm';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';
import { getDataSource } from '../datasource';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { Loan } from '../entities/loan.entity';
import { User } from '../entities/user.entity';
import {
  LoanStatus,
  PaymentPolicy,
  PaymentRequestPurpose,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../entities/types';
import { AuthUser } from '../middleware/auth';
import { EPS, round2 } from '../utils/money';
import { logger } from '../utils/logger';
import { PayableNow, getPayableNow } from './payment-due.service';
import { resolveTenant } from './tenant.service';
import { getPaymentPolicy } from './payment-policy.service';
import { createAndApprovePaymentRequest } from './payment-request.service';
import { postTransaction } from './posting-engine.service';

/**
 * The auto-debit job.
 *
 * It is the second half of the collection rule: staff may not collect an instalment before it
 * arrives, so money brought early is booked as customer credit — and this job is what settles the
 * instalment from that credit, `payment.autoDebitLeadDays` days before it falls due.
 *
 * It runs the human path (create request -> verify -> post) rather than a shortcut, so a machine
 * settlement cannot escape a rule a staff settlement is held to. The one deliberate difference is
 * maker-checker: see `ApprovePaymentParams.systemAutoDebit`. The global switch lives in
 * system_config and defaults to off, so nothing moves by itself until an ADMIN turns it on.
 */

export const AUTO_DEBIT_USERNAME = 'system.auto-debit';
const AUTO_DEBIT_FULL_NAME = 'Auto-debit job (system)';
const AUTO_DEBIT_USER_AGENT = 'auto-debit-job';

export interface AutoDebitOutcome {
  loanNumber?: string;
  /** Set when the debit could not be posted, so the recovery pass can be traced back to it. */
  referenceNo?: string;
  periodIndex?: number;
  amount?: number;
  /** ISO date the instalment falls due, so a dry run can show what it is reaching for. */
  dueDate?: string;
  requestNo?: string;
  transactionId?: string;
  reason?: string;
}

export interface AutoDebitRunOptions {
  asOf?: Date;
  /** Read from system_config when omitted; the job's tick and a test override share this entry point. */
  policy?: PaymentPolicy;
  /** Narrow the pass to one loan — what an ADMIN asks for from a loan screen. */
  loanId?: string;
  /** Report the decisions the job would act on, touching nothing: no writes, no machine account. */
  dryRun?: boolean;
}

export interface AutoDebitRunResult {
  asOf: Date;
  enabled: boolean;
  leadDays: number;
  dryRun: boolean;
  scanned: number;
  /** What a dry run would have debited. Empty on a real pass. */
  planned: AutoDebitOutcome[];
  debited: AutoDebitOutcome[];
  skipped: AutoDebitOutcome[];
  failed: AutoDebitOutcome[];
}

export type AutoDebitDecision =
  | { kind: 'DEBIT'; periodIndex: number; dueDate: Date; amount: number }
  | { kind: 'SKIP'; reason: string };

/**
 * The whole rule, as a pure function: one instalment per loan per run, the oldest one inside the
 * job's window that has not been debited yet, and only when the customer's credit covers all of it.
 * `payable.duePeriods` is already limited to that window and ordered oldest first.
 */
export function decideAutoDebit(
  payable: Pick<PayableNow, 'duePeriods' | 'creditBalance' | 'maxPayable'>,
  alreadyDebited: ReadonlySet<number>,
): AutoDebitDecision {
  const open = payable.duePeriods.filter((p) => !alreadyDebited.has(p.index) && p.collectable > EPS);
  if (open.length === 0) {
    return {
      kind: 'SKIP',
      reason:
        payable.duePeriods.length > 0
          ? 'Every instalment inside the lead window has already been debited'
          : 'No instalment is inside the lead window yet',
    };
  }
  const next = open[0];
  if (payable.creditBalance + EPS < next.collectable) {
    return {
      kind: 'SKIP',
      reason:
        `Credit ${round2(payable.creditBalance)} does not cover period ${next.index} ` +
        `(${round2(next.collectable)}) — waiting for the rest instead of taking a partial debit`,
    };
  }
  // The ledger ceiling is applied so a derived schedule can never bill more than the book owes.
  const amount = round2(Math.min(next.collectable, payable.maxPayable));
  if (amount <= EPS) {
    return { kind: 'SKIP', reason: 'Nothing is collectable on this loan right now' };
  }
  return { kind: 'DEBIT', periodIndex: next.index, dueDate: next.dueDate, amount };
}

/**
 * The machine account these rows are written under. It is inactive and its password hash is a
 * throwaway random string, so it can never sign in — it exists only because every financial row
 * and audit entry names a user.
 */
async function ensureAutoDebitAccount(em: EntityManager): Promise<AuthUser> {
  const tenant = await resolveTenant(em);
  const existing = await em.findOne(User, {
    where: { tenantId: tenant.id, username: AUTO_DEBIT_USERNAME },
    withDeleted: true,
  });
  if (existing) {
    if (existing.isActive || existing.deletedAt) {
      existing.isActive = false;
      existing.deletedAt = null;
      await em.save(User, existing);
    }
    return {
      id: existing.id,
      tenantId: existing.tenantId,
      username: existing.username,
      fullName: existing.fullName,
      role: existing.role,
    };
  }

  const created = await em.save(
    em.create(User, {
      tenantId: tenant.id,
      username: AUTO_DEBIT_USERNAME,
      passwordHash: await bcrypt.hash(randomUUID(), 12),
      fullName: AUTO_DEBIT_FULL_NAME,
      email: null,
      isEmailVerified: false,
      role: UserRole.CHECKER,
      isActive: false,
      passwordChangedAt: new Date(),
    }),
  );
  return {
    id: created.id,
    tenantId: created.tenantId,
    username: created.username,
    fullName: created.fullName,
    role: created.role,
  };
}

/**
 * Periods this job already settled. APPROVED counts as well as POSTED: an approved debit whose post
 * never finished must not be paid twice, and the recovery pass below posts it instead. A reversed
 * debit stays marked, so the job does not re-take a period staff deliberately gave back.
 */
async function debitedPeriods(em: EntityManager, loanId: string, accountId: string): Promise<Set<number>> {
  const rows = await em.find(FinancialTransaction, {
    where: {
      loanId,
      createdBy: accountId,
      transactionType: TransactionType.PAYMENT,
      status: In([TransactionStatus.APPROVED, TransactionStatus.POSTED]),
    },
    select: ['periodIndex'],
  });
  const indexes = new Set<number>();
  for (const row of rows) {
    if (row.periodIndex === null || row.periodIndex === undefined) continue;
    indexes.add(Number(row.periodIndex));
  }
  return indexes;
}

function debitNote(loanNumber: string, periodIndex: number, dueDate: Date, leadDays: number): string {
  return `AUTO-DEBIT ${loanNumber} period ${periodIndex} (falls due ${dueDate.toISOString().slice(0, 10)}) ` +
    `from customer credit, ${leadDays} day(s) ahead`;
}

async function postStaleApprovedDebits(
  account: AuthUser,
  loanId: string | null,
  failed: AutoDebitOutcome[],
): Promise<void> {
  const em = getDataSource().manager;
  const stale = await em.find(FinancialTransaction, {
    where: {
      createdBy: account.id,
      transactionType: TransactionType.PAYMENT,
      status: TransactionStatus.APPROVED,
      ...(loanId ? { loanId } : {}),
    },
    order: { createdAt: 'ASC' },
  });
  for (const tx of stale) {
    try {
      await postTransaction(tx.id, { actorId: account.id, ip: null, userAgent: AUTO_DEBIT_USER_AGENT });
    } catch (error) {
      failed.push({
        referenceNo: tx.referenceNo,
        transactionId: tx.id,
        reason: `re-post of an approved debit failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
}

/**
 * What the job does with one loan, as read from `em`: the periods it already settled plus the
 * instalment it would settle now. Callers supply the read — locked inside a transaction when they
 * mean to debit, plain when they only mean to report.
 */
async function decideForLoan(
  em: EntityManager,
  loan: Loan,
  debitedByAccountId: string | null,
  asOf: Date,
  leadDays: number,
): Promise<AutoDebitDecision> {
  const already = debitedByAccountId ? await debitedPeriods(em, loan.id, debitedByAccountId) : new Set<number>();
  const payable = await getPayableNow(em, loan.id, asOf, { collectLeadDays: leadDays });
  return decideAutoDebit(payable, already);
}

/**
 * One pass over the active book. Returns what it moved, what it skipped and why.
 *
 * The global switch governs the timer. Two runs bypass it because they need no permission to move
 * money on their own: a dry run writes nothing at all, and a run scoped to one loan is authorised by
 * the ADMIN who asked for that loan.
 */
export async function runAutoDebit(options: AutoDebitRunOptions = {}): Promise<AutoDebitRunResult> {
  const asOf = options.asOf ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const policy = options.policy ?? (await getPaymentPolicy(getDataSource().manager));
  const result: AutoDebitRunResult = {
    asOf,
    enabled: policy.autoDebitEnabled,
    leadDays: policy.autoDebitLeadDays,
    dryRun,
    scanned: 0,
    planned: [],
    debited: [],
    skipped: [],
    failed: [],
  };

  const em = getDataSource().manager;
  const loans = await em.find(Loan, {
    where: options.loanId ? { id: options.loanId, status: LoanStatus.ACTIVE } : { status: LoanStatus.ACTIVE },
    order: { loanNumber: 'ASC' },
  });
  result.scanned = loans.length;

  if (!policy.autoDebitEnabled && !dryRun && !options.loanId) return result;

  if (dryRun) {
    // Nothing has been created yet on a book that never ran the job, so there is no account to look up.
    const tenant = await resolveTenant(em);
    const account = await em.findOne(User, {
      where: { tenantId: tenant.id, username: AUTO_DEBIT_USERNAME },
      withDeleted: true,
    });
    for (const loan of loans) {
      const decision = await decideForLoan(em, loan, account?.id ?? null, asOf, policy.autoDebitLeadDays);
      if (decision.kind === 'SKIP') {
        result.skipped.push({ loanNumber: loan.loanNumber, reason: decision.reason });
        continue;
      }
      result.planned.push({
        loanNumber: loan.loanNumber,
        periodIndex: decision.periodIndex,
        amount: decision.amount,
        dueDate: decision.dueDate.toISOString().slice(0, 10),
        reason: debitNote(loan.loanNumber, decision.periodIndex, decision.dueDate, policy.autoDebitLeadDays),
      });
    }
    return result;
  }

  const account = await getDataSource().transaction((trx) => ensureAutoDebitAccount(trx));
  await postStaleApprovedDebits(account, options.loanId ?? null, result.failed);

  for (const loan of loans) {
    const outcome: { skip?: AutoDebitOutcome; debit?: AutoDebitOutcome } | null = await getDataSource().transaction(
      async (trx) => {
        // Lock the loan before reading what is due: a second instance of the job waits here and then
        // sees this debit, so one instalment is never settled twice.
        const locked = await trx.findOne(Loan, { where: { id: loan.id }, lock: { mode: 'pessimistic_write' } });
        if (!locked || locked.status !== LoanStatus.ACTIVE) return null;

        const decision = await decideForLoan(trx, locked, account.id, asOf, policy.autoDebitLeadDays);
        if (decision.kind === 'SKIP') {
          return { skip: { loanNumber: locked.loanNumber, reason: decision.reason } };
        }

        const note = debitNote(locked.loanNumber, decision.periodIndex, decision.dueDate, policy.autoDebitLeadDays);
        const created = await createAndApprovePaymentRequest(trx, {
          loanId: locked.id,
          cashAmount: 0,
          creditApplied: decision.amount,
          settlementAgreementId: null,
          purpose: PaymentRequestPurpose.PAY_DEBT,
          note,
          previousRequestId: null,
          user: account,
          ip: null,
          userAgent: AUTO_DEBIT_USER_AGENT,
          // The job's own window is the only ceiling that makes sense here: it is what decided the
          // instalment was collectable, and a staff-grace-window gate would refuse an early debit.
          collectLeadDays: policy.autoDebitLeadDays,
          periodIndex: decision.periodIndex,
          systemAutoDebit: true,
        });
        return {
          debit: {
            loanNumber: locked.loanNumber,
            periodIndex: decision.periodIndex,
            amount: decision.amount,
            requestNo: created.request.requestNo,
            transactionId: created.transaction.id,
          },
        };
      },
    );

    if (!outcome) continue;
    if (outcome.skip) {
      result.skipped.push(outcome.skip);
      continue;
    }
    if (!outcome.debit) continue;

    const debit = outcome.debit;
    try {
      await postTransaction(String(debit.transactionId), {
        actorId: account.id,
        ip: null,
        userAgent: AUTO_DEBIT_USER_AGENT,
      });
      result.debited.push(debit);
    } catch (error) {
      // The debit stays APPROVED, so the next run's recovery pass posts it instead of drafting twice.
      result.failed.push({
        ...debit,
        reason: `posted failed, debit left approved: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  if (result.debited.length > 0 || result.failed.length > 0) {
    logger.info(
      `[auto-debit] ${result.debited.length} debit(s), ${result.skipped.length} skip(s), ` +
        `${result.failed.length} failure(s) over ${result.scanned} active loan(s)`,
    );
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await runAutoDebit();
  } catch (error) {
    logger.error('[auto-debit] run failed', error);
  } finally {
    inFlight = false;
  }
}

/**
 * The timer is armed whatever the switch says, because the switch is read from system_config on
 * every run: an ADMIN turning auto-debit on then takes effect on the next tick without a restart.
 */
export function startAutoDebitJob(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), env.payment.pollIntervalMs);
  timer.unref();
  logger.info(
    `[auto-debit] job armed: every ${env.payment.pollIntervalMs}ms, ` +
      `default lead ${env.payment.autoDebitLeadDays} day(s), switch in system_config`,
  );
}

export async function stopAutoDebitJob(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
}
