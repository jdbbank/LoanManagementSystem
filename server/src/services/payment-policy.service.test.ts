import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import type { PaymentPolicy } from '../entities/types';
import {
  DEFAULT_PAYMENT_POLICY,
  MAX_AUTO_DEBIT_LEAD_DAYS,
  PAYMENT_CONFIG_KEYS,
  describePaymentPolicy,
  getPaymentPolicy,
  updatePaymentPolicy,
} from './payment-policy.service';

/** Resolves the policy from a fake `system_config` table, the same read path the job uses. */
function policyFrom(rows: Array<[key: string, value: number]>): Promise<PaymentPolicy> {
  const em = {
    find: async () => rows.map(([key, value]) => ({ key, value, valueText: null })),
  } as unknown as EntityManager;
  return getPaymentPolicy(em);
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

describe('payment configuration registry', () => {
  it('has a system_config key for every policy field', () => {
    const fields = Object.keys(DEFAULT_PAYMENT_POLICY) as (keyof PaymentPolicy)[];
    expect(Object.keys(PAYMENT_CONFIG_KEYS).sort()).toEqual(fields.sort());
  });

  it('names every key with the payment. prefix and no duplicates', () => {
    const keys = Object.values(PAYMENT_CONFIG_KEYS).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith('payment.'))).toBe(true);
  });

  it('defaults to off: money must not move by itself before an ADMIN turns the job on', () => {
    expect(DEFAULT_PAYMENT_POLICY.autoDebitEnabled).toBe(false);
    expect(DEFAULT_PAYMENT_POLICY.autoDebitLeadDays).toBe(3);
  });
});

describe('getPaymentPolicy overlay', () => {
  it('falls back to the env defaults when no row is stored', async () => {
    expect(await policyFrom([])).toEqual(DEFAULT_PAYMENT_POLICY);
  });

  it('reads the stored switch in both directions', async () => {
    expect((await policyFrom([['payment.autoDebitEnabled', 1]])).autoDebitEnabled).toBe(true);
    expect((await policyFrom([['payment.autoDebitEnabled', 0]])).autoDebitEnabled).toBe(false);
  });

  it('honours lead 0 — it means "debit on the due date", not "unset"', async () => {
    expect((await policyFrom([['payment.autoDebitLeadDays', 0]])).autoDebitLeadDays).toBe(0);
  });

  it('ignores a non-numeric lead row instead of banking on nothing', async () => {
    const em = {
      find: async () => [{ key: 'payment.autoDebitLeadDays', value: 'abc', valueText: null }],
    } as unknown as EntityManager;
    expect((await getPaymentPolicy(em)).autoDebitLeadDays).toBe(DEFAULT_PAYMENT_POLICY.autoDebitLeadDays);
  });
});

describe('updatePaymentPolicy', () => {
  const adminId = '00000000-0000-4000-8000-000000000001';

  it('writes only the patched field and keeps the other default', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    const { updated } = await updatePaymentPolicy(fakeWriter(rows), { autoDebitEnabled: true }, adminId);
    expect(updated.autoDebitEnabled).toBe(true);
    expect(updated.autoDebitLeadDays).toBe(DEFAULT_PAYMENT_POLICY.autoDebitLeadDays);
    expect(rows.map((row) => row.key)).toEqual(['payment.autoDebitEnabled']);
  });

  it('refuses a lead window wider than the ceiling', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    await expect(
      updatePaymentPolicy(fakeWriter(rows), { autoDebitLeadDays: MAX_AUTO_DEBIT_LEAD_DAYS + 1 }, adminId),
    ).rejects.toThrow(/autoDebitLeadDays/);
    expect(rows).toHaveLength(0);
  });

  it('refuses a negative lead window', async () => {
    const rows: Array<{ key: string; value: number; valueText: string | null }> = [];
    await expect(updatePaymentPolicy(fakeWriter(rows), { autoDebitLeadDays: -1 }, adminId)).rejects.toThrow(
      /autoDebitLeadDays/,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('describePaymentPolicy', () => {
  it('names the switch and the lead so the audit line reads as a setting', () => {
    expect(describePaymentPolicy({ autoDebitEnabled: true, autoDebitLeadDays: 5 })).toBe(
      'autoDebit=on,leadDays=5',
    );
  });
});
