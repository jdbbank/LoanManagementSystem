import bcrypt from 'bcryptjs';
import { EntityManager } from 'typeorm';
import { User } from '../entities/user.entity';
import { UserPasswordHistory } from '../entities/user-password-history.entity';
import { AccountSecurityPolicy, UserRole } from '../entities/types';
import { MAX_PASSWORD_HISTORY_COUNT, getAccountSecurityPolicy } from './account-security-policy.service';
import { assertPasswordAllowed, getPasswordPolicy } from './password-policy.service';
import { unprocessable } from '../utils/errors';

/**
 * Where a password becomes a stored one, and where "this password is old" is decided.
 *
 * Every write of `users.passwordHash` goes through `prepareNewPassword` + `writeNewPassword`, so the
 * composition policy, the no-repeat rule and the history row can never be skipped by one caller — an
 * ADMIN setting a password from the user screen was the hole. Hashing happens outside the transaction
 * because bcrypt must not hold a row locked while it works.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

/**
 * The reuse rule can only ever read this deep, because the policy ceiling is what it asks for, so
 * keeping the newest `MAX_PASSWORD_HISTORY_COUNT` rows loses nothing the rule could look at.
 */
const HISTORY_RETENTION = MAX_PASSWORD_HISTORY_COUNT;

export interface PasswordExpiry {
  /** False when rotation is switched off, or when this is an ADMIN account the policy exempts. */
  applies: boolean;
  expiresAt: Date | null;
  /** Whole days left before the change is due; zero or below once it is due. */
  daysLeft: number | null;
  expired: boolean;
  /** Inside the warning window, or already past it. `passwordExpiryWarnDays = 0` means "only when due". */
  warn: boolean;
}

/** The same facts in the shape an API response carries, so /users/me and login cannot drift apart. */
export function passwordExpiryPayload(expiry: PasswordExpiry): {
  applies: boolean;
  expiresAt: string | null;
  daysLeft: number | null;
  expired: boolean;
  warn: boolean;
} {
  return {
    applies: expiry.applies,
    expiresAt: expiry.expiresAt ? expiry.expiresAt.toISOString() : null,
    daysLeft: expiry.daysLeft,
    expired: expiry.expired,
    warn: expiry.warn,
  };
}

/**
 * How old the account's password is, measured from the moment it was set.
 *
 * An account predating the rotation rule has no change date recorded, so its password is read as at
 * least as old as the account itself rather than as never expiring — otherwise a legacy row would sit
 * outside the rule forever, which is the opposite of what an expiry is for.
 */
export function passwordExpiry(
  policy: Pick<AccountSecurityPolicy, 'passwordMaxAgeDays' | 'passwordExpiryWarnDays' | 'applyToAdminAccounts'>,
  account: Pick<User, 'role' | 'passwordChangedAt' | 'createdAt'>,
  now: Date = new Date(),
): PasswordExpiry {
  const applies =
    policy.passwordMaxAgeDays > 0 && (policy.applyToAdminAccounts || account.role !== UserRole.ADMIN);
  if (!applies) return { applies: false, expiresAt: null, daysLeft: null, expired: false, warn: false };

  const basis = account.passwordChangedAt ?? account.createdAt;
  const expiresAt = new Date(basis.getTime() + policy.passwordMaxAgeDays * DAY_MS);
  const remainingMs = expiresAt.getTime() - now.getTime();
  const expired = remainingMs <= 0;
  return {
    applies: true,
    expiresAt,
    daysLeft: Math.floor(remainingMs / DAY_MS),
    expired,
    warn: expired || remainingMs <= policy.passwordExpiryWarnDays * DAY_MS,
  };
}

/**
 * What an expired person is told. The gate is self-service and happens at the login form, so the
 * message says what to do next rather than only that they are stopped.
 */
export function passwordExpiredMessage(daysOverdue: number): string {
  const overdue = daysOverdue > 0 ? ` It has been overdue for ${daysOverdue} day${daysOverdue === 1 ? '' : 's'}.` : '';
  return (
    'Your password has expired and must be replaced before you sign in.' +
    `${overdue} Choose a new one now — it cannot repeat a password this account has already used.`
  );
}

/**
 * Checks the live composition policy and the no-repeat rule, then hashes. `account` is null only for
 * an account that does not exist yet, where there is no password to repeat.
 */
export async function prepareNewPassword(
  manager: EntityManager,
  account: Pick<User, 'id' | 'passwordHash'> | null,
  plaintext: string,
): Promise<string> {
  assertPasswordAllowed(await getPasswordPolicy(manager), plaintext);
  if (account) await assertNotReused(manager, account, plaintext);
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

/**
 * `security.passwordHistoryCount` previous passwords may not come back, and the password being held
 * right now may never come back either. Hashes are one-way, so the only way to ask is to compare
 * against each stored hash; the newest history row is the current password, which the first compare
 * already covers, so it is skipped rather than spent twice.
 */
async function assertNotReused(
  manager: EntityManager,
  account: Pick<User, 'id' | 'passwordHash'>,
  plaintext: string,
): Promise<void> {
  if (await bcrypt.compare(plaintext, account.passwordHash)) {
    throw unprocessable('New password must be different from the current one', { code: 'PASSWORD_REUSED' });
  }

  const { passwordHistoryCount } = await getAccountSecurityPolicy(manager);
  if (passwordHistoryCount === 0) return;

  const rows = await manager.find(UserPasswordHistory, {
    where: { userId: account.id },
    order: { createdAt: 'DESC' },
    take: passwordHistoryCount + 1,
  });
  const previous = rows.filter((row) => row.passwordHash !== account.passwordHash).slice(0, passwordHistoryCount);
  for (const row of previous) {
    if (await bcrypt.compare(plaintext, row.passwordHash)) {
      throw unprocessable(
        `This account already used this password — the last ${passwordHistoryCount} passwords cannot be repeated`,
        { code: 'PASSWORD_REUSED' },
      );
    }
  }
}

/**
 * Stores a hash prepared by `prepareNewPassword` and records it, so the next rotation has this one to
 * compare against. The caller owns the audit line.
 */
export async function writeNewPassword(
  em: EntityManager,
  user: User,
  passwordHash: string,
  at: Date = new Date(),
): Promise<void> {
  user.passwordHash = passwordHash;
  user.passwordChangedAt = at;
  await em.save(User, user);
  await recordPasswordHistory(em, user.id, passwordHash);
}

/**
 * History is written wherever a password is first given, including account creation — a row only for
 * changed passwords would leave the very first one unremembered and make A -> B -> A legal.
 */
export async function recordPasswordHistory(em: EntityManager, userId: string, passwordHash: string): Promise<void> {
  await em.insert(UserPasswordHistory, { userId, passwordHash });
  await trimPasswordHistory(em, userId);
}

/** Keeps the table bounded without a job: only the rows the reuse rule can read are worth storing. */
async function trimPasswordHistory(em: EntityManager, userId: string): Promise<void> {
  const keep = await em.find(UserPasswordHistory, {
    where: { userId },
    order: { createdAt: 'DESC' },
    select: { id: true },
    take: HISTORY_RETENTION,
  });
  if (keep.length < HISTORY_RETENTION) return;
  await em
    .createQueryBuilder()
    .delete()
    .from(UserPasswordHistory)
    .where('userId = :userId', { userId })
    .andWhere('id NOT IN (:...keep)', { keep: keep.map((row) => row.id) })
    .execute();
}
