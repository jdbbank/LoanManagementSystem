import { describe, expect, it } from 'vitest';
import { KycDocumentType, type KycPolicy } from '../entities/types';
import {
  DEFAULT_KYC_POLICY,
  KYC_CONFIG_KEYS,
  SUPPORTED_IMAGE_MIME_TYPES,
  describeKycPolicy,
  kycPolicyChecksum,
} from './kyc-policy.service';

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
