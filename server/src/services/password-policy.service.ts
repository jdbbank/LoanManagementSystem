import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { PasswordPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { readConfigRows, writeConfigRow } from './system-config.service';

/**
 * Password rules are central configuration, exactly like the KYC policy: env defaults
 * overridden by `password.*` rows in system_config, read through this one service.
 */
type BooleanRuleField = 'requireDigit' | 'requireUppercase' | 'requireLowercase' | 'requireSymbol';

const PASSWORD_CONFIG_KEYS: Record<
  keyof PasswordPolicy,
  { key: string; kind: 'number' | 'boolean'; description: string }
> = {
  minLength: { key: 'password.minLength', kind: 'number', description: 'Shortest password the system accepts' },
  maxLength: { key: 'password.maxLength', kind: 'number', description: 'Longest password the system accepts' },
  requireDigit: { key: 'password.requireDigit', kind: 'boolean', description: 'Password must contain at least one digit' },
  requireUppercase: { key: 'password.requireUppercase', kind: 'boolean', description: 'Password must contain an uppercase letter' },
  requireLowercase: { key: 'password.requireLowercase', kind: 'boolean', description: 'Password must contain a lowercase letter' },
  requireSymbol: { key: 'password.requireSymbol', kind: 'boolean', description: 'Password must contain a non-alphanumeric symbol' },
};

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: env.password.minLength,
  maxLength: env.password.maxLength,
  requireDigit: env.password.requireDigit,
  requireUppercase: env.password.requireUppercase,
  requireLowercase: env.password.requireLowercase,
  requireSymbol: env.password.requireSymbol,
};

/** Machine-readable rule names: the UI translates them, the audit log stores them. */
export type PasswordViolation =
  | 'TOO_SHORT'
  | 'TOO_LONG'
  | 'MISSING_DIGIT'
  | 'MISSING_UPPERCASE'
  | 'MISSING_LOWERCASE'
  | 'MISSING_SYMBOL';

const RULES: Array<{ violation: PasswordViolation; field: BooleanRuleField; label: string; regex: RegExp }> = [
  { violation: 'MISSING_DIGIT', field: 'requireDigit', label: 'digit', regex: /[0-9]/ },
  { violation: 'MISSING_UPPERCASE', field: 'requireUppercase', label: 'uppercase', regex: /[A-Z]/ },
  { violation: 'MISSING_LOWERCASE', field: 'requireLowercase', label: 'lowercase', regex: /[a-z]/ },
  { violation: 'MISSING_SYMBOL', field: 'requireSymbol', label: 'symbol', regex: /[^A-Za-z0-9]/ },
];

function overlay(rows: Map<string, { value: number; valueText: string | null }>): PasswordPolicy {
  const policy: PasswordPolicy = { ...DEFAULT_PASSWORD_POLICY };
  for (const field of Object.keys(PASSWORD_CONFIG_KEYS) as (keyof PasswordPolicy)[]) {
    const row = rows.get(PASSWORD_CONFIG_KEYS[field].key);
    if (!row) continue;
    if (PASSWORD_CONFIG_KEYS[field].kind === 'number') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) (policy[field] as number) = n;
    } else {
      (policy[field] as boolean) = Number(row.value) === 1;
    }
  }
  // A misconfigured pair (min above max) would reject every password, so it self-heals.
  if (policy.minLength > policy.maxLength) policy.minLength = policy.maxLength;
  return policy;
}

export async function getPasswordPolicy(em: EntityManager): Promise<PasswordPolicy> {
  const keys = Object.values(PASSWORD_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export function passwordViolations(policy: PasswordPolicy, password: string): PasswordViolation[] {
  const violations: PasswordViolation[] = [];
  if (password.length < policy.minLength) violations.push('TOO_SHORT');
  if (password.length > policy.maxLength) violations.push('TOO_LONG');
  for (const rule of RULES) {
    if (policy[rule.field] && !rule.regex.test(password)) violations.push(rule.violation);
  }
  return violations;
}

/** The single entry point every password write must pass through. */
export function assertPasswordAllowed(policy: PasswordPolicy, password: string): void {
  const violations = passwordViolations(policy, password);
  if (violations.length > 0) {
    throw unprocessable(
      `Password does not meet the policy (${describePasswordPolicy(policy)}): ${violations.join(', ')}`,
    );
  }
}

export function describePasswordPolicy(policy: PasswordPolicy): string {
  const rules = RULES.filter((rule) => policy[rule.field]).map((rule) => rule.label);
  return `length ${policy.minLength}-${policy.maxLength}${rules.length > 0 ? `, ${rules.join('|')}` : ''}`;
}

export function passwordPolicyChecksum(policy: PasswordPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export type PasswordPolicyPatch = Partial<PasswordPolicy>;

function assertPolicyMakesSense(policy: PasswordPolicy): void {
  if (policy.minLength < 4 || policy.minLength > 64) {
    throw unprocessable('minLength must be between 4 and 64');
  }
  if (policy.maxLength < policy.minLength || policy.maxLength > 128) {
    throw unprocessable(`maxLength must be between ${policy.minLength} and 128`);
  }
  if (!RULES.some((rule) => policy[rule.field])) {
    throw unprocessable('At least one character rule must stay enabled');
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updatePasswordPolicy(
  em: EntityManager,
  patch: PasswordPolicyPatch,
  userId: string,
): Promise<{ previous: PasswordPolicy; updated: PasswordPolicy }> {
  const previous = await getPasswordPolicy(em);
  const candidate: PasswordPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof PasswordPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(PASSWORD_CONFIG_KEYS) as (keyof PasswordPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = PASSWORD_CONFIG_KEYS[field];
    const numeric =
      kind === 'number' ? Number(candidate[field]) : ((candidate[field] as boolean) ? 1 : 0);
    await writeConfigRow(em, { key, value: numeric, valueText: null, description, updatedBy: userId });
  }

  const updated = await getPasswordPolicy(em);
  return { previous, updated };
}

export { PASSWORD_CONFIG_KEYS };
