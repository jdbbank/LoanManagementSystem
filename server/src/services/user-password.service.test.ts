import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import bcrypt from 'bcryptjs';
import { User } from '../entities/user.entity';
import { SystemConfig } from '../entities/system-config.entity';
import { AccountSecurityPolicy, UserRole } from '../entities/types';
import { DEFAULT_ACCOUNT_SECURITY_POLICY } from './account-security-policy.service';
import { AppError } from '../utils/errors';
import {
  passwordExpiry,
  passwordExpiryPayload,
  passwordExpiredMessage,
  prepareNewPassword,
  recordPasswordHistory,
  writeNewPassword,
} from './user-password.service';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The composition rules pinned for every case, so a test says what it means even when the machine it
 * runs on has different `PASSWORD_*` defaults than the one it was written on.
 */
const PASSWORD_ROWS: Array<[key: string, value: number]> = [
  ['password.minLength', 6],
  ['password.maxLength', 64],
  ['password.requireDigit', 1],
  ['password.requireUppercase', 1],
  ['password.requireLowercase', 1],
  ['password.requireSymbol', 0],
];

const configWith = (rows: Array<[key: string, value: number]>): Array<[key: string, value: number]> => {
  const merged = new Map(PASSWORD_ROWS);
  for (const [key, value] of rows) merged.set(key, value);
  return [...merged.entries()];
};

/** `2026-01-01T00:00:00Z` — every case below is decided relative to this instant. */
const NOW = new Date('2026-01-01T00:00:00.000Z');

const security = (overrides: Partial<AccountSecurityPolicy> = {}): AccountSecurityPolicy => ({
  ...DEFAULT_ACCOUNT_SECURITY_POLICY,
  passwordMaxAgeDays: 30,
  passwordExpiryWarnDays: 7,
  passwordHistoryCount: 5,
  applyToAdminAccounts: true,
  ...overrides,
});

const account = (overrides: Partial<User> = {}): User =>
  ({
    id: 'u1',
    username: 'maker1',
    passwordHash: '',
    fullName: 'Maker One',
    email: null,
    isEmailVerified: false,
    role: UserRole.MAKER,
    isActive: true,
    lastLoginAt: null,
    failedLoginAttempts: 0,
    lockedAt: null,
    lockReason: null,
    passwordChangedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    deletedAt: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  }) as User;

/** A `system_config` table plus, optionally, the password history rows a reuse check would read. */
function fakeManager(
  config: Array<[key: string, value: number]> = [],
  history: Array<{ id: string; passwordHash: string }> = [],
): EntityManager {
  const rows = configWith(config);
  return {
    find: async (target: { name?: string }, options?: { take?: number }) => {
      if (target?.name === SystemConfig.name) {
        return rows.map(([key, value]) => ({ key, value, valueText: null }));
      }
      return history.slice(0, options?.take ?? history.length);
    },
  } as unknown as EntityManager;
}

/** A history table that the write path can insert into and trim, recording what it asked to delete. */
type HistoryRow = { id: string; passwordHash: string; createdAt: Date; userId?: string };

function fakeWriterStore(initial: HistoryRow[] = []) {
  const rows: HistoryRow[] = [...initial];
  const trims: Array<{ kept: number }> = [];
  const chain = {
    delete: () => chain,
    from: () => chain,
    where: (_sql: string, _params: unknown) => chain,
    andWhere: (_sql: string, params: { keep: string[] }) => {
      trims.push({ kept: params.keep.length });
      return chain;
    },
    execute: async () => ({ affected: 0 }),
  };
  const em = {
    save: async (_target: unknown, entity: unknown) => entity,
    insert: async (_target: unknown, row: { userId: string; passwordHash: string }) => {
      rows.push({ id: `row${rows.length + 1}`, createdAt: new Date(), ...row });
      return { identifiers: [{ id: `row${rows.length + 1}` }] };
    },
    find: async (target: { name?: string }, options?: { take?: number; order?: unknown }) => {
      if (target?.name === SystemConfig.name) return [];
      const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return sorted.slice(0, options?.take ?? sorted.length);
    },
    createQueryBuilder: () => chain,
  } as unknown as EntityManager;
  return { em, rows, trims };
}

describe('passwordExpiry', () => {
  it('says nothing applies when the rotation rule is off', () => {
    const expiry = passwordExpiry(security({ passwordMaxAgeDays: 0 }), account(), NOW);
    expect(expiry).toEqual({ applies: false, expiresAt: null, daysLeft: null, expired: false, warn: false });
  });

  it('exempts ADMIN only when the policy says so', () => {
    const admin = account({ role: UserRole.ADMIN, passwordChangedAt: new Date(NOW.getTime() - 400 * DAY_MS) });
    expect(passwordExpiry(security(), admin, NOW).expired).toBe(true);
    expect(passwordExpiry(security({ applyToAdminAccounts: false }), admin, NOW).applies).toBe(false);
  });

  it('counts down from the day the password was set', () => {
    const expiry = passwordExpiry(security({ passwordMaxAgeDays: 30 }), account(), NOW);
    expect(expiry.applies).toBe(true);
    expect(expiry.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() + 20 * DAY_MS).toISOString());
    expect(expiry.daysLeft).toBe(20);
    expect(expiry.expired).toBe(false);
  });

  it('reads the instant the limit is reached as already expired', () => {
    const changed = new Date(NOW.getTime() - 30 * DAY_MS);
    expect(passwordExpiry(security(), account({ passwordChangedAt: changed }), NOW).expired).toBe(true);
    expect(passwordExpiry(security(), account({ passwordChangedAt: new Date(NOW.getTime() - 29 * DAY_MS) }), NOW).expired).toBe(
      false,
    );
  });

  it('warns inside the warning window and treats warn=0 as "only once due"', () => {
    const dueInFiveDays = account({ passwordChangedAt: new Date(NOW.getTime() - 25 * DAY_MS) });
    expect(passwordExpiry(security({ passwordExpiryWarnDays: 7 }), dueInFiveDays, NOW).warn).toBe(true);
    expect(passwordExpiry(security({ passwordExpiryWarnDays: 3 }), dueInFiveDays, NOW).warn).toBe(false);
    // 0 means the warning is not "early", it is not switched off: an expired password still warns.
    expect(passwordExpiry(security({ passwordExpiryWarnDays: 0 }), dueInFiveDays, NOW).warn).toBe(false);
    const alreadyDue = account({ passwordChangedAt: new Date(NOW.getTime() - 31 * DAY_MS) });
    expect(passwordExpiry(security({ passwordExpiryWarnDays: 0 }), alreadyDue, NOW).warn).toBe(true);
  });

  it('falls back to the account age when no password change is recorded', () => {
    const legacy = account({ passwordChangedAt: null, createdAt: new Date(NOW.getTime() - 40 * DAY_MS) });
    const expiry = passwordExpiry(security(), legacy, NOW);
    // A row predating the rule must not sit outside it forever.
    expect(expiry.expired).toBe(true);
    expect(expiry.expiresAt?.toISOString()).toBe(new Date(NOW.getTime() - 10 * DAY_MS).toISOString());
  });

  it('serialises to the shape the API carries', () => {
    expect(passwordExpiryPayload(passwordExpiry(security(), account(), NOW))).toEqual({
      applies: true,
      expiresAt: new Date(NOW.getTime() + 20 * DAY_MS).toISOString(),
      daysLeft: 20,
      expired: false,
      warn: false,
    });
  });
});

describe('passwordExpiredMessage', () => {
  it('names the way out and the no-repeat rule', () => {
    expect(passwordExpiredMessage(0)).toContain('must be replaced before you sign in');
    expect(passwordExpiredMessage(0)).not.toContain('overdue for 0');
    expect(passwordExpiredMessage(1)).toContain('overdue for 1 day.');
    expect(passwordExpiredMessage(3)).toContain('overdue for 3 days.');
  });
});

describe('prepareNewPassword', () => {
  it('rejects a password the composition policy does not accept, before anything else', async () => {
    const em = fakeManager([
      ['password.minLength', 12],
      ['security.passwordHistoryCount', 5],
    ]);
    await expect(prepareNewPassword(em, account({ passwordHash: await bcrypt.hash('S3cure!pass', 4) }), 'Ab1!')).rejects.toThrow(
      AppError,
    );
  });

  it('rejects repeating the password the account is holding with the wording callers assert', async () => {
    const hash = await bcrypt.hash('S3cure!pass', 4);
    const em = fakeManager([['security.passwordHistoryCount', 5]]);
    const error = await prepareNewPassword(em, account({ passwordHash: hash }), 'S3cure!pass').catch((e) => e);
    expect((error as AppError).message).toBe('New password must be different from the current one');
    expect((error as AppError).details).toEqual({ code: 'PASSWORD_REUSED' });
  });

  it('rejects repeating an older password from the remembered depth', async () => {
    const old = await bcrypt.hash('Ol3c!Password', 4);
    const current = await bcrypt.hash('N3w#Password', 4);
    const em = fakeManager(
      [['security.passwordHistoryCount', 5]],
      [{ id: 'h1', passwordHash: current }, { id: 'h2', passwordHash: old }],
    );
    const error = await prepareNewPassword(em, account({ passwordHash: current }), 'Ol3c!Password').catch((e) => e);
    expect((error as AppError).message).toContain('already used this password');
    expect((error as AppError).details).toEqual({ code: 'PASSWORD_REUSED' });
  });

  it('only remembers the depth the policy asks for, so a password older than it comes back', async () => {
    const forgotten = await bcrypt.hash('Ol3c!Password', 4);
    const current = await bcrypt.hash('N3w#Password', 4);
    const history = [
      { id: 'h0', passwordHash: current },
      // The newest row is the password being held, which the first compare already covers.
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `h${n}`, passwordHash: `filler-${n}` })),
      { id: 'h9', passwordHash: forgotten },
    ];
    const em = fakeManager([['security.passwordHistoryCount', 5]], history);
    // Depth 5 reads six rows and drops the current one, so `forgotten` is never compared.
    await expect(prepareNewPassword(em, account({ passwordHash: current }), 'Ol3c!Password')).resolves.toMatch(
      /^\$2[aby]\$/,
    );
  });

  it('remembers one more password when the policy depth grows', async () => {
    const justInside = await bcrypt.hash('Ol3c!Password', 4);
    const current = await bcrypt.hash('N3w#Password', 4);
    const em = fakeManager(
      [['security.passwordHistoryCount', 1]],
      [{ id: 'h0', passwordHash: current }, { id: 'h1', passwordHash: justInside }],
    );
    await expect(prepareNewPassword(em, account({ passwordHash: current }), 'Ol3c!Password')).rejects.toThrow(
      'already used this password',
    );
  });

  it('compares nothing from history when the policy only forbids the current password', async () => {
    const previous = await bcrypt.hash('Ol3c!Password', 4);
    const current = await bcrypt.hash('N3w#Password', 4);
    const em = fakeManager([['security.passwordHistoryCount', 0]], [{ id: 'h1', passwordHash: previous }]);
    await expect(prepareNewPassword(em, account({ passwordHash: current }), 'Ol3c!Password')).resolves.toBeTruthy();
  });

  it('accepts any password for an account that does not exist yet', async () => {
    const em = fakeManager([['security.passwordHistoryCount', 5]]);
    await expect(prepareNewPassword(em, null, 'FirstS3t!')).resolves.toMatch(/^\$2[aby]\$/);
  });
});

describe('writeNewPassword', () => {
  it('moves the password, the clock and the history together', async () => {
    const { em, rows } = fakeWriterStore();
    const user = account();
    const hash = await bcrypt.hash('N3w#Password', 4);
    const at = new Date('2026-02-02T02:02:02.000Z');

    await writeNewPassword(em, user, hash, at);

    expect(user.passwordHash).toBe(hash);
    expect(user.passwordChangedAt).toEqual(at);
    // The rotation clock and the reuse memory must say the same thing, or the next check is a guess.
    expect(rows.map((row) => row.passwordHash)).toEqual([hash]);
  });

  it('records the first password of a new account, so coming back to it is still a repeat', async () => {
    const { em, rows } = fakeWriterStore();
    const hash = await bcrypt.hash('Cr3@ted1', 4);
    await recordPasswordHistory(em, 'u1', hash);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('u1');
  });

  it('trims to the deepest history any policy can ask for', async () => {
    const seed = Array.from({ length: 24 }, (_, index) => ({
      id: `h${index}`,
      passwordHash: `hash-${index}`,
      createdAt: new Date(NOW.getTime() - index * 1000),
    }));
    const { em, trims } = fakeWriterStore(seed);

    await recordPasswordHistory(em, 'u1', 'hash-new');

    // 24 kept rows is the ceiling of `security.passwordHistoryCount`, so nothing readable is lost.
    expect(trims).toEqual([{ kept: 24 }]);
  });

  it('leaves the table alone while it is still shorter than the retention', async () => {
    const { em, trims } = fakeWriterStore([
      { id: 'h0', passwordHash: 'hash-0', createdAt: new Date(NOW.getTime() - 1000) },
    ]);
    await recordPasswordHistory(em, 'u1', 'hash-1');
    expect(trims).toEqual([]);
  });
});
