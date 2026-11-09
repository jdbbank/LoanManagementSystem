import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { PaymentPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { readConfigRows, writeConfigRow } from './system-config.service';

/**
 * Repayment-collection rules are central configuration, exactly like the KYC and password
 * policies: env defaults overridden by `payment.*` rows in system_config, read through this
 * one service. The auto-debit job re-reads the policy on every tick, so an ADMIN can turn
 * it on or off without a restart.
 */
export const MAX_AUTO_DEBIT_LEAD_DAYS = 90;

const PAYMENT_CONFIG_KEYS: Record<
  keyof PaymentPolicy,
  { key: string; kind: 'number' | 'boolean'; description: string; zeroIsValue?: boolean }
> = {
  autoDebitLeadDays: {
    key: 'payment.autoDebitLeadDays',
    kind: 'number',
    description: 'Days before an instalment falls due that the job settles it from the customer credit',
    // 0 means "debit on the due date", which is a real setting rather than an absent one.
    zeroIsValue: true,
  },
  autoDebitEnabled: {
    key: 'payment.autoDebitEnabled',
    kind: 'boolean',
    description: 'Global switch for the auto-debit job; off until an ADMIN turns it on',
  },
};

export const DEFAULT_PAYMENT_POLICY: PaymentPolicy = {
  autoDebitLeadDays: env.payment.autoDebitLeadDays,
  autoDebitEnabled: env.payment.autoDebitEnabled,
};

function overlay(rows: Map<string, { value: number; valueText: string | null }>): PaymentPolicy {
  const policy: PaymentPolicy = { ...DEFAULT_PAYMENT_POLICY };
  for (const field of Object.keys(PAYMENT_CONFIG_KEYS) as (keyof PaymentPolicy)[]) {
    const row = rows.get(PAYMENT_CONFIG_KEYS[field].key);
    if (!row) continue;
    if (PAYMENT_CONFIG_KEYS[field].kind === 'number') {
      const n = Number(row.value);
      const zeroAccepted = PAYMENT_CONFIG_KEYS[field].zeroIsValue === true;
      if (Number.isFinite(n) && (n > 0 || (n === 0 && zeroAccepted))) (policy[field] as number) = n;
    } else {
      (policy[field] as boolean) = Number(row.value) === 1;
    }
  }
  return policy;
}

export async function getPaymentPolicy(em: EntityManager): Promise<PaymentPolicy> {
  const keys = Object.values(PAYMENT_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export function describePaymentPolicy(policy: PaymentPolicy): string {
  return `autoDebit=${policy.autoDebitEnabled ? 'on' : 'off'},leadDays=${policy.autoDebitLeadDays}`;
}

export function paymentPolicyChecksum(policy: PaymentPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export type PaymentPolicyPatch = Partial<PaymentPolicy>;

/** Business rules for the policy itself — the shape check lives in the router's zod schema. */
function assertPolicyMakesSense(policy: PaymentPolicy): void {
  if (policy.autoDebitLeadDays < 0 || policy.autoDebitLeadDays > MAX_AUTO_DEBIT_LEAD_DAYS) {
    throw unprocessable(`autoDebitLeadDays must be between 0 and ${MAX_AUTO_DEBIT_LEAD_DAYS}`);
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updatePaymentPolicy(
  em: EntityManager,
  patch: PaymentPolicyPatch,
  userId: string,
): Promise<{ previous: PaymentPolicy; updated: PaymentPolicy }> {
  const previous = await getPaymentPolicy(em);
  const candidate: PaymentPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof PaymentPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(PAYMENT_CONFIG_KEYS) as (keyof PaymentPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = PAYMENT_CONFIG_KEYS[field];
    const numeric =
      kind === 'number' ? Number(candidate[field]) : ((candidate[field] as boolean) ? 1 : 0);
    await writeConfigRow(em, { key, value: numeric, valueText: null, description, updatedBy: userId });
  }

  const updated = await getPaymentPolicy(em);
  return { previous, updated };
}

export { PAYMENT_CONFIG_KEYS };
