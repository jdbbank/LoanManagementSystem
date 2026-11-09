import { createHash } from 'crypto';
import { EntityManager, In } from 'typeorm';
import { env } from '../config/env';
import { SystemConfig } from '../entities/system-config.entity';
import { KycDocumentType, KycPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';

/**
 * The ONE global KYC policy configuration (same central-configuration rule as the
 * approval thresholds in approval.service). Every module reads it here.
 *
 * Layering: env defaults  ->  overridden by `kyc.*` rows in system_config.
 */
const DOC_TYPES = Object.values(KycDocumentType) as KycDocumentType[];

/** Only real image signatures are accepted; PDF is intentionally not supported. */
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function parseDocTypes(raw: string): KycDocumentType[] {
  return parseCsv(raw).filter((v): v is KycDocumentType => (DOC_TYPES as string[]).includes(v));
}

export const DEFAULT_KYC_POLICY: KycPolicy = {
  maxFileSizeKb: env.kyc.maxFileSizeKb,
  maxFilesPerRequest: env.kyc.maxFilesPerRequest,
  allowedMimeTypes: parseCsv(env.kyc.allowedMimeTypes),
  allowedDocumentTypes: parseDocTypes(env.kyc.allowedDocumentTypes),
  requiredIdentityTypes: parseDocTypes(env.kyc.requiredIdentityTypes),
  requireSelfieWithId: env.kyc.requireSelfieWithId,
  requireSignature: env.kyc.requireSignature,
  requireFamilyBook: env.kyc.requireFamilyBook,
  acceptExpiredDocuments: env.kyc.acceptExpiredDocuments,
  expiryWarningDays: env.kyc.expiryWarningDays,
  maxTotalBytesPerCustomer: env.kyc.maxTotalBytesPerCustomer,
  blockDisbursementUntilVerified: env.kyc.blockDisbursementUntilVerified,
  reverifyOnDocumentChange: env.kyc.reverifyOnDocumentChange,
};

type FieldKind = 'number' | 'boolean' | 'csv' | 'docTypes';

interface KycConfigKey {
  key: string;
  kind: FieldKind;
  description: string;
  /**
   * A number row of 0 otherwise means "no value stored" (csv/docTypes rows keep 0 in the shared
   * numeric column), so it is ignored on read. Set this only where 0 is a real setting.
   */
  zeroIsValue?: boolean;
}

/** Single registry: config key, storage kind and description per policy field. */
const KYC_CONFIG_KEYS: Record<keyof KycPolicy, KycConfigKey> = {
  maxFileSizeKb: {
    key: 'kyc.upload.maxFileSizeKb',
    kind: 'number',
    description: 'Maximum size of one uploaded KYC image, in KB',
  },
  maxFilesPerRequest: {
    key: 'kyc.upload.maxFilesPerRequest',
    kind: 'number',
    description: 'Maximum number of files accepted per upload request',
  },
  allowedMimeTypes: {
    key: 'kyc.upload.allowedMimeTypes',
    kind: 'csv',
    description: 'Comma separated image mime types that may be uploaded',
  },
  allowedDocumentTypes: {
    key: 'kyc.allowedDocumentTypes',
    kind: 'docTypes',
    description: 'KYC document types this branch accepts at all',
  },
  requiredIdentityTypes: {
    key: 'kyc.requiredIdentityTypes',
    kind: 'docTypes',
    description: 'At least one document of these types must be present',
  },
  requireSelfieWithId: {
    key: 'kyc.requireSelfieWithId',
    kind: 'boolean',
    description: 'Photo of the customer holding their ID document is mandatory',
  },
  requireSignature: {
    key: 'kyc.requireSignature',
    kind: 'boolean',
    description: 'Signature image is mandatory',
  },
  requireFamilyBook: {
    key: 'kyc.requireFamilyBook',
    kind: 'boolean',
    description: 'Family book / house registration is mandatory',
  },
  acceptExpiredDocuments: {
    key: 'kyc.acceptExpiredDocuments',
    kind: 'boolean',
    description: 'Allow documents whose expiry date has passed',
  },
  expiryWarningDays: {
    key: 'kyc.expiryWarningDays',
    kind: 'number',
    description: 'Warn in the UI when a document expires within this many days',
    zeroIsValue: true,
  },
  maxTotalBytesPerCustomer: {
    key: 'kyc.maxTotalBytesPerCustomer',
    kind: 'number',
    description: 'Total stored KYC bytes allowed per customer',
  },
  blockDisbursementUntilVerified: {
    key: 'kyc.blockDisbursementUntilVerified',
    kind: 'boolean',
    description: 'Reject loan disbursement unless customer KYC is VERIFIED',
  },
  reverifyOnDocumentChange: {
    key: 'kyc.reverifyOnDocumentChange',
    kind: 'boolean',
    description: 'Uploading or deleting a document after VERIFIED sends the customer back to PENDING',
  },
};

type ConfigRow = { key: string; value: number; valueText: string | null };

function readRow(rows: Map<string, ConfigRow>, field: keyof KycPolicy): ConfigRow | undefined {
  return rows.get(KYC_CONFIG_KEYS[field].key);
}

function overlay(defaults: KycPolicy, rows: Map<string, ConfigRow>): KycPolicy {
  const policy: KycPolicy = { ...defaults };
  for (const field of Object.keys(KYC_CONFIG_KEYS) as (keyof KycPolicy)[]) {
    const row = readRow(rows, field);
    if (!row) continue;
    const kind = KYC_CONFIG_KEYS[field].kind;
    if (kind === 'number') {
      const n = Number(row.value);
      const zeroAccepted = KYC_CONFIG_KEYS[field].zeroIsValue === true;
      if (Number.isFinite(n) && (n > 0 || (n === 0 && zeroAccepted))) (policy[field] as number) = n;
    } else if (kind === 'boolean') {
      (policy[field] as boolean) = Number(row.value) === 1;
    } else if (kind === 'csv') {
      const list = row.valueText ? parseCsv(row.valueText) : [];
      if (list.length > 0) (policy[field] as string[]) = list;
    } else {
      const list = row.valueText ? parseDocTypes(row.valueText) : [];
      if (list.length > 0) (policy[field] as KycDocumentType[]) = list;
    }
  }

  // A required identity type that is globally disabled can never be satisfied.
  policy.requiredIdentityTypes = policy.requiredIdentityTypes.filter((t) =>
    policy.allowedDocumentTypes.includes(t),
  );
  policy.allowedMimeTypes = policy.allowedMimeTypes.filter((m) =>
    (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (policy.allowedMimeTypes.length === 0) {
    policy.allowedMimeTypes = [...SUPPORTED_IMAGE_MIME_TYPES];
  }
  return policy;
}

export async function getKycPolicy(em: EntityManager): Promise<KycPolicy> {
  const rows = await em.find(SystemConfig, { where: { key: In(Object.values(KYC_CONFIG_KEYS).map((c) => c.key)) } });
  const map = new Map<string, ConfigRow>(
    rows.map((r) => [r.key, { key: r.key, value: Number(r.value), valueText: r.valueText ?? null }]),
  );
  return overlay(DEFAULT_KYC_POLICY, map);
}

export interface KycPolicyPatch {
  maxFileSizeKb?: number;
  maxFilesPerRequest?: number;
  allowedMimeTypes?: string[];
  allowedDocumentTypes?: KycDocumentType[];
  requiredIdentityTypes?: KycDocumentType[];
  requireSelfieWithId?: boolean;
  requireSignature?: boolean;
  requireFamilyBook?: boolean;
  acceptExpiredDocuments?: boolean;
  expiryWarningDays?: number;
  maxTotalBytesPerCustomer?: number;
  blockDisbursementUntilVerified?: boolean;
  reverifyOnDocumentChange?: boolean;
}

/** Business rules for the policy itself — the shape check lives in the router's zod schema. */
function assertPolicyMakesSense(policy: KycPolicy): void {
  if (policy.maxFileSizeKb < 1 || policy.maxFileSizeKb > 102_400) {
    throw unprocessable('maxFileSizeKb must be between 1 and 102400');
  }
  if (policy.maxFilesPerRequest < 1 || policy.maxFilesPerRequest > 10) {
    throw unprocessable('maxFilesPerRequest must be between 1 and 10');
  }
  if (policy.allowedDocumentTypes.length === 0) {
    throw unprocessable('At least one KYC document type must stay enabled');
  }
  if (policy.requiredIdentityTypes.length === 0) {
    throw unprocessable('At least one identity document type must be required');
  }
  if (!policy.requiredIdentityTypes.every((t) => policy.allowedDocumentTypes.includes(t))) {
    throw unprocessable('requiredIdentityTypes must be a subset of allowedDocumentTypes');
  }
  const unsupported = policy.allowedMimeTypes.filter(
    (m) => !(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (unsupported.length > 0) {
    throw unprocessable(`Only image uploads are supported; rejected: ${unsupported.join(', ')}`);
  }
  if (policy.maxTotalBytesPerCustomer < policy.maxFileSizeKb * 1024) {
    throw unprocessable('maxTotalBytesPerCustomer must allow at least one maximum-size document');
  }
  if (policy.expiryWarningDays < 0 || policy.expiryWarningDays > 3650) {
    throw unprocessable('expiryWarningDays must be between 0 and 3650');
  }
}

export function kycPolicyChecksum(policy: KycPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updateKycPolicy(
  em: EntityManager,
  patch: KycPolicyPatch,
  userId: string,
): Promise<{ previous: KycPolicy; updated: KycPolicy }> {
  const previous = await getKycPolicy(em);
  const candidate: KycPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof KycPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(KYC_CONFIG_KEYS) as (keyof KycPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = KYC_CONFIG_KEYS[field];
    const existing = await em.findOne(SystemConfig, { where: { key } });
    const numeric = kind === 'number' ? Number(candidate[field]) : kind === 'boolean' ? ((candidate[field] as boolean) ? 1 : 0) : existing ? Number(existing.value) : 0;
    const text = kind === 'csv' || kind === 'docTypes' ? (candidate[field] as string[]).join(',') : existing?.valueText ?? null;
    if (existing) {
      existing.value = numeric;
      existing.valueText = text;
      existing.description = description;
      existing.updatedBy = userId;
      await em.save(SystemConfig, existing);
    } else {
      await em.save(SystemConfig, em.create(SystemConfig, { key, value: numeric, valueText: text, description, updatedBy: userId }));
    }
  }

  const updated = await getKycPolicy(em);
  return { previous, updated };
}

export function describeKycPolicy(policy: KycPolicy): string {
  return [
    `files<=${policy.maxFileSizeKb}KB`,
    `mime=${policy.allowedMimeTypes.join('|')}`,
    `identity=${policy.requiredIdentityTypes.join('|')}`,
    `selfie=${policy.requireSelfieWithId ? '1' : '0'}`,
    `signature=${policy.requireSignature ? '1' : '0'}`,
    `familyBook=${policy.requireFamilyBook ? '1' : '0'}`,
    `acceptExpired=${policy.acceptExpiredDocuments ? '1' : '0'}`,
    `quota=${policy.maxTotalBytesPerCustomer}`,
    `gate=${policy.blockDisbursementUntilVerified ? '1' : '0'}`,
  ].join(',');
}

export { KYC_CONFIG_KEYS };
