import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import { DEFAULT_ACCOUNT_SECURITY_POLICY } from './account-security-policy.service';
import type { User } from '../entities/user.entity';
import {
  accountLockedMessage,
  clearLoginLock,
  idleLockDue,
  idleSweepDue,
  lockAccount,
  locksOnFailedAttempts,
  registerFailedLogin,
  registerSuccessfulLogin,
} from './account-lock.service';
import { AccountLockReason, AccountSecurityPolicy, UserRole } from '../entities/types';

type Row = {
  id: string;
  failedLoginAttempts: number;
  lockedAt: Date | null;
  lockReason: AccountLockReason | null;
  lastLoginAt: Date | null;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'u1',
  failedLoginAttempts: 0,
  lockedAt: null,
  lockReason: null,
  lastLoginAt: null,
  ...overrides,
});

const policy = (overrides: Partial<AccountSecurityPolicy> = {}): AccountSecurityPolicy => ({
  ...DEFAULT_ACCOUNT_SECURITY_POLICY,
  maxFailedAttempts: 3,
  ...overrides,
});

type Write = { set: Record<string, unknown>; guards: string[] };

/**
 * The guards the service writes are the point of the fake, so it honours them instead of accepting any
 * update — and an unknown guard fails loudly rather than being skipped silently.
 */
const guardsHold = (guards: string[], target: Row): boolean =>
  guards.every((guard) => {
    if (guard === 'lockedAt IS NULL') return target.lockedAt === null;
    if (guard === 'lockedAt IS NOT NULL') return target.lockedAt !== null;
    throw new Error(`fake users table does not understand the guard: ${guard}`);
  });

/** Applies a `set()` the way MySQL would: an SQL expression increments, a literal assigns. */
function applySet(target: Row, set: Record<string, unknown>): void {
  for (const [field, value] of Object.entries(set)) {
    const key = field as keyof Row;
    if (typeof value === 'function') {
      if (key !== 'failedLoginAttempts') throw new Error(`unexpected SQL expression on ${field}`);
      target.failedLoginAttempts += 1;
      continue;
    }
    (target[key] as unknown) = value ?? null;
  }
}

/** One `users` row behind the query-builder chain the service uses. */
function fakeUsers(rows: Row[]): { em: EntityManager; writes: Write[] } {
  const writes: Write[] = [];
  let step: { set: Record<string, unknown>; id?: string; guards: string[] } = { set: {}, guards: [] };

  const qb: Record<string, unknown> = {
    update: () => qb,
    set: (value: Record<string, unknown>) => {
      step.set = value;
      return qb;
    },
    where: (_condition: string, params: { id: string }) => {
      step.id = params.id;
      return qb;
    },
    andWhere: (condition: string) => {
      step.guards.push(condition);
      return qb;
    },
    execute: async () => {
      const { set, guards, id } = step;
      writes.push({ set, guards });
      const target = rows.find((r) => r.id === id);
      const applies = target !== undefined && guardsHold(guards, target);
      if (target && applies) applySet(target, set);
      step = { set: {}, guards: [] };
      return { affected: applies ? 1 : 0 };
    },
  };

  const em = {
    createQueryBuilder: () => qb,
    findOneByOrFail: async (_model: unknown, criteria: { id: string }) => {
      const found = rows.find((r) => r.id === criteria.id);
      if (!found) throw new Error('user row not found');
      return { ...found };
    },
  } as unknown as EntityManager;

  return { em, writes };
}

describe('which accounts the failure lock covers', () => {
  it('treats maxFailedAttempts 0 as the rule being off, not unset', () => {
    expect(locksOnFailedAttempts(policy({ maxFailedAttempts: 0 }))).toBe(false);
    expect(locksOnFailedAttempts(policy({ maxFailedAttempts: 3 }))).toBe(true);
  });

  it('is not switched off by applyToAdminAccounts', () => {
    // That switch protects ADMIN from the idle lock and the rotation gate; a guessed ADMIN password
    // is a different risk, so the failure lock keeps covering it.
    expect(locksOnFailedAttempts(policy({ applyToAdminAccounts: false }))).toBe(true);
  });
});

describe('registerFailedLogin', () => {
  it('counts up to the limit and locks on the guess that reaches it', async () => {
    const account = row();
    const { em } = fakeUsers([account]);
    const p = policy({ maxFailedAttempts: 3 });

    expect(await registerFailedLogin(em, 'u1', p)).toEqual({ kind: 'counted', attempts: 1 });
    expect(await registerFailedLogin(em, 'u1', p)).toEqual({ kind: 'counted', attempts: 2 });
    expect(account.lockedAt).toBeNull();
    expect(await registerFailedLogin(em, 'u1', p)).toEqual({ kind: 'locked', attempts: 3 });
    expect(account.lockReason).toBe(AccountLockReason.FAILED_ATTEMPTS);
    expect(account.lockedAt).toBeInstanceOf(Date);
  });

  it('locks at the configured limit, not at three', async () => {
    const account = row();
    const { em } = fakeUsers([account]);
    const p = policy({ maxFailedAttempts: 5 });
    for (let i = 1; i <= 4; i += 1) {
      expect((await registerFailedLogin(em, 'u1', p)).kind).toBe('counted');
    }
    expect((await registerFailedLogin(em, 'u1', p)).kind).toBe('locked');
  });

  it('never locks while the rule is off, however many guesses arrive', async () => {
    const account = row();
    const { em } = fakeUsers([account]);
    const p = policy({ maxFailedAttempts: 0 });
    for (let i = 1; i <= 5; i += 1) {
      expect((await registerFailedLogin(em, 'u1', p)).kind).toBe('counted');
    }
    expect(account.lockedAt).toBeNull();
  });

  it('says already-locked once the account is locked, and writes only the counter', async () => {
    const locked = row({
      failedLoginAttempts: 3,
      lockedAt: new Date('2026-10-17T01:00:00.000Z'),
      lockReason: AccountLockReason.FAILED_ATTEMPTS,
    });
    const { em, writes } = fakeUsers([locked]);

    const outcome = await registerFailedLogin(em, 'u1', policy({ maxFailedAttempts: 3 }));
    expect(outcome).toEqual({ kind: 'already-locked', attempts: 4 });
    expect(writes).toHaveLength(1);
    expect(locked.lockReason).toBe(AccountLockReason.FAILED_ATTEMPTS);
  });

  it('raises the count in SQL and guards the lock write, so parallel guesses cannot both trip it', async () => {
    const account = row({ failedLoginAttempts: 2 });
    const { em, writes } = fakeUsers([account]);
    const p = policy({ maxFailedAttempts: 3 });

    expect((await registerFailedLogin(em, 'u1', p)).kind).toBe('locked');
    expect((await registerFailedLogin(em, 'u1', p)).kind).toBe('already-locked');
    expect(writes[0].set.failedLoginAttempts).toBeInstanceOf(Function);
    expect(writes[1].guards).toContain('lockedAt IS NULL');
  });
});

describe('lockAccount', () => {
  it('reports which call did the locking and keeps the reason of the winner', async () => {
    const account = row();
    const { em } = fakeUsers([account]);

    expect(await lockAccount(em, 'u1', AccountLockReason.FAILED_ATTEMPTS)).toBe(true);
    expect(account.lockReason).toBe(AccountLockReason.FAILED_ATTEMPTS);
    // The idle sweep firing afterwards must not rewrite a lock that already exists.
    expect(await lockAccount(em, 'u1', AccountLockReason.IDLE)).toBe(false);
    expect(account.lockReason).toBe(AccountLockReason.FAILED_ATTEMPTS);
  });
});

describe('clearLoginLock', () => {
  it('clears the lock, the reason and the counter together', async () => {
    const account = row({
      failedLoginAttempts: 3,
      lockedAt: new Date('2026-10-17T01:00:00.000Z'),
      lockReason: AccountLockReason.IDLE,
    });
    const { em } = fakeUsers([account]);

    expect(await clearLoginLock(em, 'u1')).toBe(true);
    expect(account).toEqual(row({ lastLoginAt: null }));
  });

  it('refuses to write when the account is not locked, so a double unlock is not a second clear', async () => {
    const account = row({
      lockedAt: new Date('2026-10-17T01:00:00.000Z'),
      lockReason: AccountLockReason.FAILED_ATTEMPTS,
    });
    const { em, writes } = fakeUsers([account]);

    expect(await clearLoginLock(em, 'u1')).toBe(true);
    expect(await clearLoginLock(em, 'u1')).toBe(false);
    expect(writes).toHaveLength(2);
    expect(writes[1].guards).toContain('lockedAt IS NOT NULL');
  });
});

describe('registerSuccessfulLogin', () => {
  it('writes the last-login instant and spends the counter in one statement', async () => {
    const account = row({ failedLoginAttempts: 2 });
    const { em, writes } = fakeUsers([account]);
    const at = new Date('2026-10-17T02:00:00.000Z');

    await registerSuccessfulLogin(em, 'u1', at);
    expect(writes).toHaveLength(1);
    expect(account.failedLoginAttempts).toBe(0);
    expect(account.lastLoginAt).toEqual(at);
  });
});

const NOW = new Date('2026-10-17T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS);

type Quiet = Pick<User, 'role' | 'lastLoginAt' | 'passwordChangedAt' | 'createdAt'>;

/** An account whose last live event was `days` back, with its creation kept behind that. */
const quietFor = (days: number, overrides: Partial<Quiet> = {}): Quiet => ({
  role: UserRole.MAKER,
  lastLoginAt: ago(days),
  passwordChangedAt: ago(days),
  createdAt: ago(days + 1),
  ...overrides,
});

describe('idleLockDue', () => {
  it('is off when the window is 0, however quiet the account is', () => {
    const status = idleLockDue(policy({ idleLockDays: 0 }), quietFor(5_000), NOW);
    expect(status).toEqual({ applies: false, idleSince: null, daysIdle: null, due: false });
  });

  it('measures from the event that last proved the account live, not from the oldest one', () => {
    // ADMIN unlocked this account and its password was reset yesterday; the person has not signed in
    // for 100 days. Reading the clock from the sign-in alone would lock them again on the very next
    // attempt, which is the door the unlock just opened slamming shut behind them.
    const status = idleLockDue(policy({ idleLockDays: 90 }), quietFor(100, { passwordChangedAt: ago(1) }), NOW);
    expect(status.idleSince).toEqual(ago(1));
    expect(status.daysIdle).toBe(1);
    expect(status.due).toBe(false);
  });

  it('locks on the day the window closes, and not one day before', () => {
    expect(idleLockDue(policy({ idleLockDays: 90 }), quietFor(89), NOW).due).toBe(false);
    expect(idleLockDue(policy({ idleLockDays: 90 }), quietFor(90), NOW).due).toBe(true);
  });

  it('falls back to creation for an account that never signed in and never changed its password', () => {
    const status = idleLockDue(
      policy({ idleLockDays: 90 }),
      { role: UserRole.MAKER, lastLoginAt: null, passwordChangedAt: null, createdAt: ago(120) },
      NOW,
    );
    expect(status.idleSince).toEqual(ago(120));
    expect(status.due).toBe(true);
  });

  it('covers ADMIN accounts only when the policy says so', () => {
    const admin = quietFor(120, { role: UserRole.ADMIN });
    expect(idleLockDue(policy({ idleLockDays: 90, applyToAdminAccounts: true }), admin, NOW).due).toBe(true);
    // The failure lock keeps covering ADMIN whatever this switch says; the switch is about an account
    // being quiet, which is a different risk from its password being guessed.
    expect(idleLockDue(policy({ idleLockDays: 90, applyToAdminAccounts: false }), admin, NOW)).toEqual({
      applies: false,
      idleSince: null,
      daysIdle: null,
      due: false,
    });
  });

  it('is not due when the account clock reads ahead of now', () => {
    expect(idleLockDue(policy({ idleLockDays: 90 }), quietFor(-5), NOW).due).toBe(false);
  });
});

describe('idleSweepDue', () => {
  it('never runs while the switch is off, however long the job has been asleep', () => {
    const p = policy({ idleLockJobEnabled: false, idleLockPollHours: 1 });
    expect(idleSweepDue(p, null, NOW)).toBe(false);
    expect(idleSweepDue(p, ago(10), NOW)).toBe(false);
  });

  it('runs on the first beat after boot', () => {
    const p = policy({ idleLockJobEnabled: true, idleLockPollHours: 24 });
    expect(idleSweepDue(p, null, NOW)).toBe(true);
  });

  it('waits out the cadence it reads from config, so a change needs no restart', () => {
    const p = policy({ idleLockJobEnabled: true, idleLockPollHours: 24 });
    expect(idleSweepDue(p, new Date(NOW.getTime() - 23 * HOUR_MS), NOW)).toBe(false);
    expect(idleSweepDue(p, new Date(NOW.getTime() - 24 * HOUR_MS), NOW)).toBe(true);
  });

  it('treats a cadence below one hour as one hour, so the sweep cannot spin', () => {
    const p = policy({ idleLockJobEnabled: true, idleLockPollHours: 0 });
    expect(idleSweepDue(p, new Date(NOW.getTime() - 30 * 60 * 1000), NOW)).toBe(false);
    expect(idleSweepDue(p, new Date(NOW.getTime() - 61 * 60 * 1000), NOW)).toBe(true);
  });
});

describe('accountLockedMessage', () => {
  it('names ADMIN and the new-password step for both rules', () => {
    for (const reason of [AccountLockReason.FAILED_ATTEMPTS, AccountLockReason.IDLE]) {
      const message = accountLockedMessage(reason);
      expect(message).toContain('ADMIN');
      expect(message).toContain('new password');
    }
  });

  it('says which rule fired so the person knows what to tell ADMIN', () => {
    expect(accountLockedMessage(AccountLockReason.FAILED_ATTEMPTS)).toContain('failed sign-in attempts');
    expect(accountLockedMessage(AccountLockReason.IDLE)).toContain('not signed in for a long time');
  });
});
