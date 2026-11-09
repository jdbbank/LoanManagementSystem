import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { AccountSecurityPolicy } from '../entities/types';
import {
  ACCOUNT_SECURITY_CONFIG_KEYS,
  DEFAULT_ACCOUNT_SECURITY_POLICY,
  MAX_FAILED_ATTEMPTS,
  MAX_IDLE_LOCK_POLL_HOURS,
  MAX_PASSWORD_HISTORY_COUNT,
  accountSecurityPolicyChecksum,
  describeAccountSecurityPolicy,
  getAccountSecurityPolicy,
  updateAccountSecurityPolicy,
} from './account-security-policy.service';

/** Resolves the policy from a fake `system_config` table — the same read path login uses. */
function policyFrom(rows: Array<[key: string, value: number]>): Promise<AccountSecurityPolicy> {
  const em = {
    find: async () => rows.map(([key, value]) => ({ key, value, valueText: null })),
  } as unknown as EntityManager;
  return getAccountSecurityPolicy(em);
}

/** A `system_config` table the writer actually writes into, so the re-read reflects the patch. */
function fakeWriter(rows: Array<{ key: string; value: number; valueText: string | null }>): EntityManager {
  return {
    find: async () => rows,
    findOne: async (_entity: unknown, criteria: { where: { key: string } }) =>
      rows.find((row) => row.key === criteria.where.key) ?? null,
    create: (_entity: unknown, row: { key: string; value: number; valueText: string | null }) => row,
    save: async (_entity: unknown, row: { key: string; value: number; valueText: string | null }) => {
      const existing = rows.findIndex((r) => r.key === row.key);
      if (existing >= 0) rows[existing] = row;
      else rows.push(row);
      return row;
    },
  } as unknown as EntityManager;
}

describe('account security configuration registry', () => {
  it('has a system_config key for every policy field', () => {
    const fields = Object.keys(DEFAULT_ACCOUNT_SECURITY_POLICY) as (keyof AccountSecurityPolicy)[];
    expect(Object.keys(ACCOUNT_SECURITY_CONFIG_KEYS).sort()).toEqual(fields.sort());
  });

  it('names every key with the security. prefix and no duplicates', () => {
    const keys = Object.values(ACCOUNT_SECURITY_CONFIG_KEYS).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith('security.'))).toBe(true);
  });

  it('ships the requested numbers, with the idle-lock job off', () => {
    // Regression guard: these are the policy the branch asked for, not placeholders.
    expect(DEFAULT_ACCOUNT_SECURITY_POLICY.maxFailedAttempts).toBe(3);
    expect(DEFAULT_ACCOUNT_SECURITY_POLICY.idleLockDays).toBe(90);
    expect(DEFAULT_ACCOUNT_SECURITY_POLICY.passwordMaxAgeDays).toBe(30);
    expect(DEFAULT_ACCOUNT_SECURITY_POLICY.passwordHistoryCount).toBe(5);
    expect(DEFAULT_ACCOUNT_SECURITY_POLICY.idleLockJobEnabled).toBe(false);
  });
});

describe('getAccountSecurityPolicy overlay', () => {
  it('falls back to the env defaults when no row is stored', async () => {
    expect(await policyFrom([])).toEqual(DEFAULT_ACCOUNT_SECURITY_POLICY);
  });

  it('honours 0 on every rule — 0 means "this rule is off", not "unset"', async () => {
    const policy = await policyFrom([
      ['security.maxFailedAttempts', 0],
      ['security.idleLockDays', 0],
      ['security.passwordMaxAgeDays', 0],
      ['security.passwordHistoryCount', 0],
    ]);
    expect(policy.maxFailedAttempts).toBe(0);
    expect(policy.idleLockDays).toBe(0);
    expect(policy.passwordMaxAgeDays).toBe(0);
    expect(policy.passwordHistoryCount).toBe(0);
  });

  it('reads the two switches in both directions', async () => {
    expect((await policyFrom([['security.idleLockJobEnabled', 1]])).idleLockJobEnabled).toBe(true);
    expect((await policyFrom([['security.applyToAdminAccounts', 0]])).applyToAdminAccounts).toBe(false);
  });

  it('ignores a non-numeric or negative row instead of disabling a guard by accident', async () => {
    const em = {
      find: async () => [
        { key: 'security.maxFailedAttempts', value: 'abc', valueText: null },
        { key: 'security.idleLockDays', value: -5, valueText: null },
      ],
    } as unknown as EntityManager;
    const policy = await getAccountSecurityPolicy(em);
    expect(policy.maxFailedAttempts).toBe(DEFAULT_ACCOUNT_SECURITY_POLICY.maxFailedAttempts);
    expect(policy.idleLockDays).toBe(DEFAULT_ACCOUNT_SECURITY_POLICY.idleLockDays);
  });
});

describe('updateAccountSecurityPolicy', () => {
  const adminId = '00000000-0000-4000-8000-000000000001';

  it('writes only the patched field and keeps the other defaults', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    const { updated } = await updateAccountSecurityPolicy(fakeWriter(rows), { maxFailedAttempts: 5 }, adminId);
    expect(updated.maxFailedAttempts).toBe(5);
    expect(updated.idleLockDays).toBe(DEFAULT_ACCOUNT_SECURITY_POLICY.idleLockDays);
    expect(rows.map((row) => row.key)).toEqual(['security.maxFailedAttempts']);
  });

  it('stores 0 as a value so a rule can be switched off from the UI', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    const { updated } = await updateAccountSecurityPolicy(fakeWriter(rows), { passwordMaxAgeDays: 0 }, adminId);
    expect(updated.passwordMaxAgeDays).toBe(0);
    expect(rows[0].value).toBe(0);
  });

  it('refuses a warning dated after the password already expired', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    await expect(
      updateAccountSecurityPolicy(
        fakeWriter(rows),
        { passwordMaxAgeDays: 30, passwordExpiryWarnDays: 45 },
        adminId,
      ),
    ).rejects.toThrow(/passwordExpiryWarnDays/);
    expect(rows).toHaveLength(0);
  });

  it('refuses a sweep interval of zero hours and a counter above the ceiling', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    await expect(
      updateAccountSecurityPolicy(fakeWriter(rows), { idleLockPollHours: 0 }, adminId),
    ).rejects.toThrow(/idleLockPollHours/);
    await expect(
      updateAccountSecurityPolicy(
        fakeWriter(rows),
        { maxFailedAttempts: MAX_FAILED_ATTEMPTS + 1 },
        adminId,
      ),
    ).rejects.toThrow(/maxFailedAttempts/);
    await expect(
      updateAccountSecurityPolicy(
        fakeWriter(rows),
        { passwordHistoryCount: MAX_PASSWORD_HISTORY_COUNT + 1 },
        adminId,
      ),
    ).rejects.toThrow(/passwordHistoryCount/);
    expect(rows).toHaveLength(0);
  });
});

describe('describeAccountSecurityPolicy', () => {
  it('names every guard so the audit line reads as a setting change', () => {
    expect(
      describeAccountSecurityPolicy({
        maxFailedAttempts: 3,
        idleLockDays: 90,
        idleLockJobEnabled: false,
        idleLockPollHours: MAX_IDLE_LOCK_POLL_HOURS,
        passwordMaxAgeDays: 30,
        passwordExpiryWarnDays: 7,
        passwordHistoryCount: 5,
        applyToAdminAccounts: true,
      }),
    ).toBe(
      'failLock=3,idle=90d(job=off/168h),age=30d(warn=7d),history=5,adminIncluded=1',
    );
  });

  it('says "off" instead of 0 where a 0 means the guard is disabled', () => {
    const described = describeAccountSecurityPolicy({
      ...DEFAULT_ACCOUNT_SECURITY_POLICY,
      maxFailedAttempts: 0,
      idleLockDays: 0,
      passwordMaxAgeDays: 0,
    });
    expect(described).toContain('failLock=off');
    expect(described).toContain('idle=off');
    expect(described).toContain('age=off');
  });

  it('checksums the same policy identically and a changed one differently', () => {
    expect(accountSecurityPolicyChecksum(DEFAULT_ACCOUNT_SECURITY_POLICY)).toBe(
      accountSecurityPolicyChecksum({ ...DEFAULT_ACCOUNT_SECURITY_POLICY }),
    );
    expect(accountSecurityPolicyChecksum(DEFAULT_ACCOUNT_SECURITY_POLICY)).not.toBe(
      accountSecurityPolicyChecksum({ ...DEFAULT_ACCOUNT_SECURITY_POLICY, maxFailedAttempts: 4 }),
    );
  });
});
