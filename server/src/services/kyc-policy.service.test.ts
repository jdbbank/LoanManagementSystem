import { describe, expect, it } from 'vitest';
import type { EntityManager } from 'typeorm';
import { KycDocumentType, type KycPolicy } from '../entities/types';
import {
  DEFAULT_KYC_POLICY,
  KYC_CONFIG_KEYS,
  SUPPORTED_IMAGE_MIME_TYPES,
  describeKycPolicy,
  getKycPolicy,
  kycPolicyChecksum,
} from './kyc-policy.service';

/** Resolves the policy from a fake `system_config` table, the same read path the API uses. */
function policyFrom(rows: Array<[key: string, value: number, valueText?: string | null]>): Promise<KycPolicy> {
  const em = {
    find: async () => rows.map(([key, value, valueText]) => ({ key, value, valueText })),
  } as unknown as EntityManager;
  return getKycPolicy(em);
}

describe('KYC configuration registry', () => {
  it('has a system_config key for every policy field', () => {
    const fields = Object.keys(DEFAULT_KYC_POLICY) as (keyof KycPolicy)[];
    expect(Object.keys(KYC_CONFIG_KEYS).sort()).toEqual(fields.sort());
  });

  it('names every key with the kyc. prefix and no duplicates', () => {
    const keys = Object.values(KYC_CONFIG_KEYS).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith('kyc.'))).toBe(true);
  });

  it('defaults to images only — PDF is never an accepted upload format', () => {
    const imageMimes: string[] = [...SUPPORTED_IMAGE_MIME_TYPES];
    expect(DEFAULT_KYC_POLICY.allowedMimeTypes.every((mime) => imageMimes.includes(mime))).toBe(true);
    expect(DEFAULT_KYC_POLICY.allowedMimeTypes).not.toContain('application/pdf');
  });

  it('requires identity evidence and the disbursement gate by default', () => {
    expect(DEFAULT_KYC_POLICY.requiredIdentityTypes.length).toBeGreaterThan(0);
    expect(DEFAULT_KYC_POLICY.blockDisbursementUntilVerified).toBe(true);
  });

  it('only requires identity types it also allows', () => {
    expect(
      DEFAULT_KYC_POLICY.requiredIdentityTypes.every((type) =>
        DEFAULT_KYC_POLICY.allowedDocumentTypes.includes(type),
      ),
    ).toBe(true);
  });
});

describe('stored number rows', () => {
  it('honours expiryWarningDays = 0 — 0 means "never warn", not "unset"', async () => {
    const policy = await policyFrom([['kyc.expiryWarningDays', 0]]);
    expect(policy.expiryWarningDays).toBe(0);
  });

  it('treats 0 as unset for limits where 0 would disable uploads', async () => {
    const policy = await policyFrom([
      ['kyc.upload.maxFileSizeKb', 0],
      ['kyc.maxTotalBytesPerCustomer', 0],
    ]);
    expect(policy.maxFileSizeKb).toBe(DEFAULT_KYC_POLICY.maxFileSizeKb);
    expect(policy.maxTotalBytesPerCustomer).toBe(DEFAULT_KYC_POLICY.maxTotalBytesPerCustomer);
  });

  it('still ignores negative numbers', async () => {
    const policy = await policyFrom([['kyc.expiryWarningDays', -1]]);
    expect(policy.expiryWarningDays).toBe(DEFAULT_KYC_POLICY.expiryWarningDays);
  });

  it('marks only that field as zero-legitimate in the registry', () => {
    const zeroFields = Object.keys(KYC_CONFIG_KEYS).filter((f) => KYC_CONFIG_KEYS[f as keyof KycPolicy].zeroIsValue);
    expect(zeroFields).toEqual(['expiryWarningDays']);
  });
});

describe('kycPolicyChecksum', () => {
  it('is stable for the same policy', () => {
    expect(kycPolicyChecksum(DEFAULT_KYC_POLICY)).toBe(kycPolicyChecksum({ ...DEFAULT_KYC_POLICY }));
  });

  it('changes when a single limit changes', () => {
    expect(kycPolicyChecksum({ ...DEFAULT_KYC_POLICY, maxFileSizeKb: DEFAULT_KYC_POLICY.maxFileSizeKb + 1 })).not.toBe(
      kycPolicyChecksum(DEFAULT_KYC_POLICY),
    );
    expect(
      kycPolicyChecksum({
        ...DEFAULT_KYC_POLICY,
        allowedDocumentTypes: [KycDocumentType.NATIONAL_ID],
      }),
    ).not.toBe(kycPolicyChecksum(DEFAULT_KYC_POLICY));
  });
});

describe('describeKycPolicy', () => {
  it('reports the limits an auditor needs to see', () => {
    const text = describeKycPolicy(DEFAULT_KYC_POLICY);
    expect(text).toContain(`files<=${DEFAULT_KYC_POLICY.maxFileSizeKb}KB`);
    expect(text).toContain(`gate=${DEFAULT_KYC_POLICY.blockDisbursementUntilVerified ? '1' : '0'}`);
    expect(text).toContain(DEFAULT_KYC_POLICY.allowedMimeTypes[0]);
  });
});
