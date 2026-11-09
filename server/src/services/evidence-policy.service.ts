import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { EvidencePolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { parseCsv, readConfigRows, writeConfigRow } from './system-config.service';
import { SUPPORTED_IMAGE_MIME_TYPES } from './kyc-policy.service';

/**
 * Financial evidence (bank proofs, transfer slips) is central configuration exactly like the KYC and
 * collateral policies: env defaults overridden by `evidence.*` rows in system_config, read through this
 * one service. It is a SEPARATE policy from the KYC one on purpose — sharing it would pull a payment
 * proof into the KYC checklist, whose re-verify rule sends the customer back to PENDING and stops the
 * next disbursement.
 */
export const MAX_EVIDENCE_FILE_SIZE_KB = 102_400;
export const MAX_EVIDENCE_FILES_PER_REQUEST = 10;

const EVIDENCE_CONFIG_KEYS: Record<
  keyof EvidencePolicy,
  { key: string; kind: 'number' | 'csv'; description: string }
> = {
  maxFileSizeKb: {
    key: 'evidence.maxFileSizeKb',
    kind: 'number',
    description: 'Maximum size of one uploaded evidence image, in KB',
  },
  maxFilesPerRequest: {
    key: 'evidence.maxFilesPerRequest',
    kind: 'number',
    description: 'Maximum number of files accepted per evidence upload request',
  },
  allowedMimeTypes: {
    key: 'evidence.allowedMimeTypes',
    kind: 'csv',
    description: 'Comma separated image mime types that may be uploaded as evidence',
  },
  maxTotalBytesPerOwner: {
    key: 'evidence.maxTotalBytesPerOwner',
    kind: 'number',
    description: 'Total stored evidence bytes allowed per customer or per loan',
  },
};

export const DEFAULT_EVIDENCE_POLICY: EvidencePolicy = {
  maxFileSizeKb: env.evidence.maxFileSizeKb,
  maxFilesPerRequest: env.evidence.maxFilesPerRequest,
  allowedMimeTypes: parseCsv(env.evidence.allowedMimeTypes),
  maxTotalBytesPerOwner: env.evidence.maxTotalBytesPerOwner,
};

function overlay(rows: Map<string, { value: number; valueText: string | null }>): EvidencePolicy {
  const policy: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY };
  for (const field of Object.keys(EVIDENCE_CONFIG_KEYS) as (keyof EvidencePolicy)[]) {
    const row = rows.get(EVIDENCE_CONFIG_KEYS[field].key);
    if (!row) continue;
    if (EVIDENCE_CONFIG_KEYS[field].kind === 'number') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) (policy[field] as number) = n;
    } else {
      const list = row.valueText ? parseCsv(row.valueText) : [];
      if (list.length > 0) (policy[field] as string[]) = list;
    }
  }

  // Same clamp as the KYC policy: only formats the sniffer can really recognise.
  policy.allowedMimeTypes = policy.allowedMimeTypes.filter((m) =>
    (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (policy.allowedMimeTypes.length === 0) {
    policy.allowedMimeTypes = [...SUPPORTED_IMAGE_MIME_TYPES];
  }
  return policy;
}

export async function getEvidencePolicy(em: EntityManager): Promise<EvidencePolicy> {
  const keys = Object.values(EVIDENCE_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export function describeEvidencePolicy(policy: EvidencePolicy): string {
  return (
    `files<=${policy.maxFileSizeKb}KB,` +
    `perRequest=${policy.maxFilesPerRequest},` +
    `mime=${policy.allowedMimeTypes.join('|')},` +
    `quota=${policy.maxTotalBytesPerOwner}`
  );
}

export function evidencePolicyChecksum(policy: EvidencePolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export type EvidencePolicyPatch = Partial<EvidencePolicy>;

/** Business rules for the policy itself — the shape check lives in the router's zod schema. */
function assertPolicyMakesSense(policy: EvidencePolicy): void {
  if (policy.maxFileSizeKb < 1 || policy.maxFileSizeKb > MAX_EVIDENCE_FILE_SIZE_KB) {
    throw unprocessable(`maxFileSizeKb must be between 1 and ${MAX_EVIDENCE_FILE_SIZE_KB}`);
  }
  if (policy.maxFilesPerRequest < 1 || policy.maxFilesPerRequest > MAX_EVIDENCE_FILES_PER_REQUEST) {
    throw unprocessable(`maxFilesPerRequest must be between 1 and ${MAX_EVIDENCE_FILES_PER_REQUEST}`);
  }
  if (policy.allowedMimeTypes.length === 0) {
    throw unprocessable('At least one image type must stay allowed');
  }
  const unsupported = policy.allowedMimeTypes.filter(
    (m) => !(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (unsupported.length > 0) {
    throw unprocessable(`Only image uploads are supported; rejected: ${unsupported.join(', ')}`);
  }
  if (policy.maxTotalBytesPerOwner < policy.maxFileSizeKb * 1024) {
    throw unprocessable('maxTotalBytesPerOwner must allow at least one maximum-size image');
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updateEvidencePolicy(
  em: EntityManager,
  patch: EvidencePolicyPatch,
  userId: string,
): Promise<{ previous: EvidencePolicy; updated: EvidencePolicy }> {
  const previous = await getEvidencePolicy(em);
  const candidate: EvidencePolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof EvidencePolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(EVIDENCE_CONFIG_KEYS) as (keyof EvidencePolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = EVIDENCE_CONFIG_KEYS[field];
    // A csv row carries its value in valueText; the shared numeric column stays unused.
    const numeric = kind === 'number' ? Number(candidate[field]) : 0;
    const text = kind === 'csv' ? (candidate[field] as string[]).join(',') : null;
    await writeConfigRow(em, { key, value: numeric, valueText: text, description, updatedBy: userId });
  }

  const updated = await getEvidencePolicy(em);
  return { previous, updated };
}

export { EVIDENCE_CONFIG_KEYS };
