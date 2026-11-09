import { In, IsNull, EntityManager } from 'typeorm';
import { getDataSource } from '../datasource';
import { User } from '../entities/user.entity';
import { AccountLockReason, AccountSecurityPolicy, UserRole } from '../entities/types';
import { getAccountSecurityPolicy } from './account-security-policy.service';
import { writeAudit } from './audit.service';
import { logger } from '../utils/logger';

/**
 * Where the account-security policy turns into rows. Login is the only place the failure lock is
 * counted, and every write here goes through SQL rather than a read-modify-write on a loaded entity,
 * because parallel guesses that read the same row lost counts before (F-CONC-4).
 *
 * `users.lockedAt` is the lock and `users.lockReason` is which rule set it. Neither is `isActive`:
 * disabling an account is ADMIN intent, this is a rule firing, and only ADMIN may clear it.
 *
 * Two rules write that pair: the failure lock, counted at login, and the idle lock below, which fires
 * from the sweep job and from the login door itself, because the job ships switched off.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Whether the wrong-password rule runs at all. `0` means the rule is switched off, not "unset".
 *
 * The failure lock covers ADMIN accounts even when `applyToAdminAccounts` is false — that switch is
 * about not locking the only operator out for being quiet or holding an old password, which is a
 * different risk from somebody guessing an ADMIN password ten times in a row.
 */
export function locksOnFailedAttempts(policy: AccountSecurityPolicy): boolean {
  return policy.maxFailedAttempts > 0;
}

export type FailedLoginOutcome =
  | { kind: 'counted'; attempts: number }
  | { kind: 'locked'; attempts: number }
  | { kind: 'already-locked'; attempts: number };

/**
 * Spends one wrong password. Returns whether THIS guess is the one that tripped the lock, so the
 * caller writes exactly one `USER_ACCOUNT_LOCKED` audit line however many guesses arrive together.
 */
export async function registerFailedLogin(
  em: EntityManager,
  userId: string,
  policy: AccountSecurityPolicy,
): Promise<FailedLoginOutcome> {
  await em
    .createQueryBuilder()
    .update(User)
    .set({ failedLoginAttempts: () => 'failedLoginAttempts + 1' })
    .where('id = :id', { id: userId })
    .execute();

  const fresh = await em.findOneByOrFail(User, { id: userId });
  const attempts = fresh.failedLoginAttempts;
  if (fresh.lockedAt) return { kind: 'already-locked', attempts };
  if (!locksOnFailedAttempts(policy) || attempts < policy.maxFailedAttempts) {
    return { kind: 'counted', attempts };
  }
  const tripped = await lockAccount(em, userId, AccountLockReason.FAILED_ATTEMPTS);
  return { kind: tripped ? 'locked' : 'already-locked', attempts };
}

/**
 * Locks an account that is not locked yet. `affected` answers "did this call do it", so two rules
 * firing in the same instant — a guess reaching the limit while the idle sweep runs — still leave one
 * lock row and one audit line rather than a reason that depends on write order.
 *
 * `at` exists for the caller that has to report the lock it just wrote: the login gate answers a 403
 * with the same instant it stores, so the two can never disagree.
 */
export async function lockAccount(
  em: EntityManager,
  userId: string,
  reason: AccountLockReason,
  at: Date = new Date(),
): Promise<boolean> {
  const result = await em
    .createQueryBuilder()
    .update(User)
    .set({ lockedAt: at, lockReason: reason })
    .where('id = :id', { id: userId })
    .andWhere('lockedAt IS NULL')
    .execute();
  return (result.affected ?? 0) === 1;
}

/**
 * ADMIN-only: a locked account cannot unlock itself by guessing right. Returns false when the account
 * was not locked (never locked, or another ADMIN unlocked it a moment earlier), which is what makes a
 * double unlock idempotent instead of a second lock-clearing write.
 */
export async function clearLoginLock(em: EntityManager, userId: string): Promise<boolean> {
  const result = await em
    .createQueryBuilder()
    .update(User)
    .set({ lockedAt: null, lockReason: null, failedLoginAttempts: 0 })
    .where('id = :id', { id: userId })
    .andWhere('lockedAt IS NOT NULL')
    .execute();
  return (result.affected ?? 0) === 1;
}

/**
 * One write for both facts a successful sign-in establishes: the last-login instant the idle rule
 * measures from, and the consecutive-failure count going back to zero.
 */
export async function registerSuccessfulLogin(em: EntityManager, userId: string, at: Date): Promise<void> {
  await em
    .createQueryBuilder()
    .update(User)
    .set({ lastLoginAt: at, failedLoginAttempts: 0 })
    .where('id = :id', { id: userId })
    .execute();
}

/**
 * How quiet an account is, and whether that quiet is long enough to lock it.
 *
 * The clock starts at the last moment the account proved itself live: a successful sign-in, a password
 * event (the owner's own change or an ADMIN-set one, which is what the reset link an unlock emails
 * ends in), or creation for a row that has had neither. Taking the latest rather than falling back
 * through them is what makes an ADMIN unlock mean something: unlocking a quiet account and leaving the
 * old sign-in as the basis would re-lock it on the very next attempt, so the rule would be a door that
 * opens once and never again.
 */
export interface IdleLockStatus {
  /** False while the rule is switched off, or for an ADMIN account the policy exempts. */
  applies: boolean;
  idleSince: Date | null;
  /** Whole days the account has been quiet; null when the rule does not cover it. */
  daysIdle: number | null;
  due: boolean;
}

/** The most recent of the instants an account can be read as live at; `createdAt` is the floor. */
function lastLiveAt(account: Pick<User, 'lastLoginAt' | 'passwordChangedAt' | 'createdAt'>): Date {
  return [account.lastLoginAt, account.passwordChangedAt].reduce<Date>(
    (latest, value) => (value !== null && value.getTime() > latest.getTime() ? value : latest),
    account.createdAt,
  );
}

export function idleLockDue(
  policy: Pick<AccountSecurityPolicy, 'idleLockDays' | 'applyToAdminAccounts'>,
  account: Pick<User, 'role' | 'lastLoginAt' | 'passwordChangedAt' | 'createdAt'>,
  now: Date = new Date(),
): IdleLockStatus {
  const applies = policy.idleLockDays > 0 && (policy.applyToAdminAccounts || account.role !== UserRole.ADMIN);
  if (!applies) return { applies: false, idleSince: null, daysIdle: null, due: false };
  const idleSince = lastLiveAt(account);
  const idleMs = now.getTime() - idleSince.getTime();
  return {
    applies: true,
    idleSince,
    daysIdle: Math.floor(idleMs / DAY_MS),
    due: idleMs >= policy.idleLockDays * DAY_MS,
  };
}

/** Why the idle rule leaves an account alone, said out loud rather than left as a missing lock. */
function idleExemptReason(policy: AccountSecurityPolicy, account: Pick<User, 'role'>): string {
  if (policy.idleLockDays === 0) return 'idle rule switched off (idleLockDays = 0)';
  if (account.role === UserRole.ADMIN) return 'ADMIN account while applyToAdminAccounts is off';
  return 'the idle rule does not cover this account';
}

/**
 * Whether the armed job should look at the book now.
 *
 * `idleLockPollHours` is read from system_config on every heartbeat, so an ADMIN change takes effect
 * without a restart. The caller only moves the stamp after a pass that actually ran: while the switch
 * is off nothing is stamped, which is what makes turning it on take effect on the next heartbeat
 * instead of part-way through a window counted while the job was asleep.
 */
export function idleSweepDue(
  policy: Pick<AccountSecurityPolicy, 'idleLockJobEnabled' | 'idleLockPollHours'>,
  lastRunAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!policy.idleLockJobEnabled) return false;
  if (!lastRunAt) return true;
  return now.getTime() - lastRunAt.getTime() >= Math.max(1, policy.idleLockPollHours) * HOUR_MS;
}

export interface IdleSweepOptions {
  asOf?: Date;
  /** Read from system_config when omitted; the job's beat and a test override share this entry point. */
  policy?: AccountSecurityPolicy;
  /** Narrow the pass to named accounts — what an ADMIN asks for from the user screen. */
  userIds?: string[];
  /** Report the decisions the job would act on, touching nothing: no lock, no audit row. */
  dryRun?: boolean;
}

export interface IdleSweepOutcome {
  /** The username, or the id when a named account does not exist. */
  account: string;
  idleSince?: string;
  daysIdle?: number;
  reason?: string;
}

export interface IdleSweepRunResult {
  asOf: Date;
  enabled: boolean;
  idleLockDays: number;
  dryRun: boolean;
  scanned: number;
  /** What a dry run would have locked. Empty on a real pass. */
  planned: IdleSweepOutcome[];
  locked: IdleSweepOutcome[];
  /** Filled only for a pass that named accounts or asked to see the decisions; a quiet account is not news. */
  skipped: IdleSweepOutcome[];
  failed: IdleSweepOutcome[];
}

function idleOutcome(account: Pick<User, 'username'>, status: IdleLockStatus): IdleSweepOutcome {
  return {
    account: account.username,
    idleSince: status.idleSince ? status.idleSince.toISOString() : undefined,
    daysIdle: status.daysIdle ?? undefined,
  };
}

/**
 * The idle-lock pass: every account the quiet rule now covers gets locked, with one audit line per
 * lock written.
 *
 * One transaction per account, each opening by write-locking that row, so a sweep racing a
 * wrong-password lock leaves exactly one lock and one reason instead of two writes overwriting each
 * other. A whole-book pass obeys the switch; naming accounts is ADMIN authorisation and a dry run
 * writes nothing, so both proceed while the job is off — the same discipline as auto-debit.
 */
export async function sweepIdleLocks(options: IdleSweepOptions = {}): Promise<IdleSweepRunResult> {
  const asOf = options.asOf ?? new Date();
  const dryRun = Boolean(options.dryRun);
  const ds = getDataSource();
  const policy = options.policy ?? (await getAccountSecurityPolicy(ds.manager));
  const userIds = options.userIds ?? [];
  const scoped = userIds.length > 0;
  const reportSkips = scoped || dryRun;
  const result: IdleSweepRunResult = {
    asOf,
    enabled: policy.idleLockJobEnabled,
    idleLockDays: policy.idleLockDays,
    dryRun,
    scanned: 0,
    planned: [],
    locked: [],
    skipped: [],
    failed: [],
  };

  if (!dryRun && !scoped && (!policy.idleLockJobEnabled || policy.idleLockDays === 0)) return result;

  const em = ds.manager;
  const candidates = scoped
    ? await em.find(User, { where: { id: In(userIds) }, order: { username: 'ASC' } })
    : await em.find(User, { where: { lockedAt: IsNull(), isActive: true }, order: { username: 'ASC' } });
  result.scanned = candidates.length;

  const found = new Set(candidates.map((account) => account.id));
  for (const id of userIds) {
    if (!found.has(id)) result.skipped.push({ account: id, reason: 'no such account' });
  }

  if (dryRun) {
    for (const account of candidates) {
      if (account.lockedAt) {
        result.skipped.push({
          account: account.username,
          reason: `already locked (${account.lockReason ?? 'no reason recorded'})`,
        });
        continue;
      }
      const status = idleLockDue(policy, account, asOf);
      if (!status.applies) {
        result.skipped.push({ account: account.username, reason: idleExemptReason(policy, account) });
        continue;
      }
      if (!status.due) continue;
      result.planned.push(idleOutcome(account, status));
    }
    return result;
  }

  for (const candidate of candidates) {
    try {
      const outcome: { skip?: IdleSweepOutcome; lock?: IdleSweepOutcome } | null = await ds.transaction(
        async (trx) => {
          // Write-lock the account before reading how quiet it is: a guess reaching the failure limit
          // here waits, and then sees this lock instead of writing a second one.
          const account = await trx.findOne(User, {
            where: { id: candidate.id },
            lock: { mode: 'pessimistic_write' },
          });
          if (!account) return null;
          if (account.lockedAt) {
            return {
              skip: {
                account: account.username,
                reason: `already locked (${account.lockReason ?? 'no reason recorded'})`,
              },
            };
          }
          const status = idleLockDue(policy, account, asOf);
          if (!status.applies) {
            return { skip: { account: account.username, reason: idleExemptReason(policy, account) } };
          }
          if (!status.due) return null;
          // `asOf` only decides the due math; the lock is stamped with the real instant, so a back-dated
          // pass cannot rewrite when an account was actually stopped.
          const tripped = await lockAccount(trx, account.id, AccountLockReason.IDLE);
          if (!tripped) return null;
          await writeAudit(trx, {
            action: 'USER_ACCOUNT_LOCKED',
            userId: account.id,
            newStatus: AccountLockReason.IDLE,
            reason:
              `Idle lock: no sign-in or password event since ${status.idleSince?.toISOString() ?? 'never recorded'} ` +
              `(${status.daysIdle} day(s), window ${policy.idleLockDays}) — ADMIN unlock required`,
            userAgent: 'idle-lock-job',
          });
          return { lock: idleOutcome(account, status) };
        },
      );

      if (!outcome) continue;
      if (outcome.skip) {
        if (reportSkips) result.skipped.push(outcome.skip);
        continue;
      }
      if (outcome.lock) result.locked.push(outcome.lock);
    } catch (error) {
      // One account failing cannot carry the rest of the book down with it; the next beat retries it.
      result.failed.push({
        account: candidate.username,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (result.locked.length > 0 || result.failed.length > 0) {
    logger.info(
      `[idle-lock] sweep locked ${result.locked.length} account(s), ${result.failed.length} failure(s) ` +
        `over ${result.scanned} candidate(s), window ${result.idleLockDays} day(s)`,
    );
  }
  return result;
}

/**
 * The heartbeat is a fixed short interval while the cadence it enforces and the switch that runs it
 * come from system_config on every beat, so the job obeys an ADMIN change without a restart and spends
 * one config read per heartbeat.
 */
const IDLE_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;

let idleTimer: NodeJS.Timeout | null = null;
let idleInFlight = false;
let lastIdleSweepAt: Date | null = null;

async function idleTick(): Promise<void> {
  if (idleInFlight) return;
  idleInFlight = true;
  try {
    const policy = await getAccountSecurityPolicy(getDataSource().manager);
    if (!idleSweepDue(policy, lastIdleSweepAt)) return;
    await sweepIdleLocks({ policy });
    lastIdleSweepAt = new Date();
  } catch (error) {
    logger.error('[idle-lock] sweep tick failed', error);
  } finally {
    idleInFlight = false;
  }
}

export function startIdleLockJob(): void {
  if (idleTimer) return;
  idleTimer = setInterval(() => void idleTick(), IDLE_LOCK_HEARTBEAT_MS);
  idleTimer.unref();
  logger.info(
    `[idle-lock] job armed: heartbeat every ${IDLE_LOCK_HEARTBEAT_MS / 60000} min, ` +
      'window, cadence and switch in system_config',
  );
}

export async function stopIdleLockJob(): Promise<void> {
  if (idleTimer) clearInterval(idleTimer);
  idleTimer = null;
  lastIdleSweepAt = null;
}

/**
 * What a locked person is told. The address to ask is the point of the message, so it names ADMIN and
 * says what happens after the unlock instead of leaving them to try the password again.
 */
export function accountLockedMessage(reason: AccountLockReason | null): string {
  const why =
    reason === AccountLockReason.IDLE
      ? 'because it has not signed in for a long time'
      : 'after too many failed sign-in attempts';
  return (
    `This account is locked ${why}. Contact ADMIN to unlock it — ` +
    'once unlocked the system emails a link so you can choose a new password.'
  );
}
