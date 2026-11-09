import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { AccountSecurityPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { readConfigRows, writeConfigRow } from './system-config.service';

/**
 * Account-lifetime rules are central configuration, exactly like the password and payment
 * policies: env defaults overridden by `security.*` rows in system_config, read through this
 * one service. Login, the idle sweep and every password write all re-read it per request, so an
 * ADMIN change takes effect without a restart.
 */
export const MAX_FAILED_ATTEMPTS = 100;
export const MAX_IDLE_LOCK_DAYS = 3650;
export const MAX_IDLE_LOCK_POLL_HOURS = 168;
export const MAX_PASSWORD_AGE_DAYS = 3650;
export const MAX_PASSWORD_HISTORY_COUNT = 24;

const ACCOUNT_SECURITY_CONFIG_KEYS: Record<
  keyof AccountSecurityPolicy,
  { key: string; kind: 'number' | 'boolean'; description: string }
> = {
  maxFailedAttempts: {
    key: 'security.maxFailedAttempts',
    kind: 'number',
    description: 'Consecutive wrong passwords that lock an account; 0 = never lock on failures',
  },
  idleLockDays: {
    key: 'security.idleLockDays',
    kind: 'number',
    description: 'Days without a successful login that lock an account; 0 = accounts never expire',
  },
  idleLockJobEnabled: {
    key: 'security.idleLockJobEnabled',
    kind: 'boolean',
    description: 'Global switch for the idle-lock job; off until an ADMIN turns it on',
  },
  idleLockPollHours: {
    key: 'security.idleLockPollHours',
    kind: 'number',
    description: 'How often the idle-lock job looks for accounts past the idle window',
  },
  passwordMaxAgeDays: {
    key: 'security.passwordMaxAgeDays',
    kind: 'number',
    description: 'Days a password stays valid before its owner must replace it; 0 = no rotation',
  },
  passwordExpiryWarnDays: {
    key: 'security.passwordExpiryWarnDays',
    kind: 'number',
    description: 'Days before expiry that the owner is warned; 0 = warn only once the password is due',
  },
  passwordHistoryCount: {
    key: 'security.passwordHistoryCount',
    kind: 'number',
    description: 'How many previous passwords a new one must not repeat; 0 = only the current one',
  },
  applyToAdminAccounts: {
    key: 'security.applyToAdminAccounts',
    kind: 'boolean',
    description: 'Whether ADMIN accounts obey the idle lock and the rotation gate too',
  },
};

export const DEFAULT_ACCOUNT_SECURITY_POLICY: AccountSecurityPolicy = {
  maxFailedAttempts: env.security.maxFailedAttempts,
  idleLockDays: env.security.idleLockDays,
  idleLockJobEnabled: env.security.idleLockJobEnabled,
  idleLockPollHours: env.security.idleLockPollHours,
  passwordMaxAgeDays: env.security.passwordMaxAgeDays,
  passwordExpiryWarnDays: env.security.passwordExpiryWarnDays,
  passwordHistoryCount: env.security.passwordHistoryCount,
  applyToAdminAccounts: env.security.applyToAdminAccounts,
};

function overlay(rows: Map<string, { value: number; valueText: string | null }>): AccountSecurityPolicy {
  const policy: AccountSecurityPolicy = { ...DEFAULT_ACCOUNT_SECURITY_POLICY };
  for (const field of Object.keys(ACCOUNT_SECURITY_CONFIG_KEYS) as (keyof AccountSecurityPolicy)[]) {
    const row = rows.get(ACCOUNT_SECURITY_CONFIG_KEYS[field].key);
    if (!row) continue;
    if (ACCOUNT_SECURITY_CONFIG_KEYS[field].kind === 'number') {
      // 0 switches these rules off, so it is a value rather than a missing row (F-CFG-1).
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) (policy[field] as number) = n;
    } else {
      (policy[field] as boolean) = Number(row.value) === 1;
    }
  }
  return policy;
}

export async function getAccountSecurityPolicy(em: EntityManager): Promise<AccountSecurityPolicy> {
  const keys = Object.values(ACCOUNT_SECURITY_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export function describeAccountSecurityPolicy(policy: AccountSecurityPolicy): string {
  // 0 reads as "off" here because that is what it means for these three rules.
  const days = (value: number): string => (value === 0 ? 'off' : `${value}d`);
  return (
    `failLock=${policy.maxFailedAttempts || 'off'},` +
    `idle=${days(policy.idleLockDays)}(job=${policy.idleLockJobEnabled ? 'on' : 'off'}/` +
    `${policy.idleLockPollHours}h),` +
    `age=${days(policy.passwordMaxAgeDays)}(warn=${policy.passwordExpiryWarnDays}d),` +
    `history=${policy.passwordHistoryCount},adminIncluded=${policy.applyToAdminAccounts ? '1' : '0'}`
  );
}

export function accountSecurityPolicyChecksum(policy: AccountSecurityPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export type AccountSecurityPolicyPatch = Partial<AccountSecurityPolicy>;

/** Business rules for the policy itself — the shape check lives in the router's zod schema. */
function assertPolicyMakesSense(policy: AccountSecurityPolicy): void {
  if (policy.maxFailedAttempts > MAX_FAILED_ATTEMPTS) {
    throw unprocessable(`maxFailedAttempts must be between 0 and ${MAX_FAILED_ATTEMPTS}`);
  }
  if (policy.idleLockDays > MAX_IDLE_LOCK_DAYS) {
    throw unprocessable(`idleLockDays must be between 0 and ${MAX_IDLE_LOCK_DAYS}`);
  }
  if (policy.idleLockPollHours < 1 || policy.idleLockPollHours > MAX_IDLE_LOCK_POLL_HOURS) {
    throw unprocessable(`idleLockPollHours must be between 1 and ${MAX_IDLE_LOCK_POLL_HOURS}`);
  }
  if (policy.passwordMaxAgeDays > MAX_PASSWORD_AGE_DAYS) {
    throw unprocessable(`passwordMaxAgeDays must be between 0 and ${MAX_PASSWORD_AGE_DAYS}`);
  }
  if (policy.passwordHistoryCount > MAX_PASSWORD_HISTORY_COUNT) {
    throw unprocessable(`passwordHistoryCount must be between 0 and ${MAX_PASSWORD_HISTORY_COUNT}`);
  }
  // An account cannot be expected to warn about an expiry it has already passed by more than the window.
  if (policy.passwordMaxAgeDays > 0 && policy.passwordExpiryWarnDays > policy.passwordMaxAgeDays) {
    throw unprocessable('passwordExpiryWarnDays must not exceed passwordMaxAgeDays');
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updateAccountSecurityPolicy(
  em: EntityManager,
  patch: AccountSecurityPolicyPatch,
  userId: string,
): Promise<{ previous: AccountSecurityPolicy; updated: AccountSecurityPolicy }> {
  const previous = await getAccountSecurityPolicy(em);
  const candidate: AccountSecurityPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof AccountSecurityPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(ACCOUNT_SECURITY_CONFIG_KEYS) as (keyof AccountSecurityPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = ACCOUNT_SECURITY_CONFIG_KEYS[field];
    const numeric =
      kind === 'number' ? Number(candidate[field]) : ((candidate[field] as boolean) ? 1 : 0);
    await writeConfigRow(em, { key, value: numeric, valueText: null, description, updatedBy: userId });
  }

  const updated = await getAccountSecurityPolicy(em);
  return { previous, updated };
}

export { ACCOUNT_SECURITY_CONFIG_KEYS };
