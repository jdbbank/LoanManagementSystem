import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { AvatarPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { SUPPORTED_IMAGE_MIME_TYPES } from './kyc-policy.service';
import { parseCsv, readConfigRows, writeConfigRow } from './system-config.service';

/**
 * Avatar upload limits, configured at runtime the same way as the KYC upload policy:
 * env defaults overridden by `avatar.*` rows in system_config.
 */
const AVATAR_CONFIG_KEYS: Record<
  keyof AvatarPolicy,
  { key: string; kind: 'boolean' | 'number' | 'csv'; description: string }
> = {
  enabled: { key: 'avatar.enabled', kind: 'boolean', description: 'Staff avatars are available at all' },
  maxFileSizeKb: { key: 'avatar.maxFileSizeKb', kind: 'number', description: 'Maximum size of one avatar image, in KB' },
  allowedMimeTypes: { key: 'avatar.allowedMimeTypes', kind: 'csv', description: 'Image mime types an avatar may use' },
};

export const DEFAULT_AVATAR_POLICY: AvatarPolicy = {
  enabled: env.avatar.enabled,
  maxFileSizeKb: env.avatar.maxFileSizeKb,
  allowedMimeTypes: parseCsv(env.avatar.allowedMimeTypes),
};

function overlay(rows: Map<string, { value: number; valueText: string | null }>): AvatarPolicy {
  const policy: AvatarPolicy = { ...DEFAULT_AVATAR_POLICY };
  for (const field of Object.keys(AVATAR_CONFIG_KEYS) as (keyof AvatarPolicy)[]) {
    const row = rows.get(AVATAR_CONFIG_KEYS[field].key);
    if (!row) continue;
    const kind = AVATAR_CONFIG_KEYS[field].kind;
    if (kind === 'number') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n > 0) (policy[field] as number) = n;
    } else if (kind === 'boolean') {
      (policy[field] as boolean) = Number(row.value) === 1;
    } else {
      const list = parseCsv(row.valueText);
      if (list.length > 0) (policy[field] as string[]) = list;
    }
  }
  // Avatars are images only; anything else in the allowlist is silently dropped.
  policy.allowedMimeTypes = policy.allowedMimeTypes.filter((m) =>
    (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (policy.allowedMimeTypes.length === 0) policy.allowedMimeTypes = [...SUPPORTED_IMAGE_MIME_TYPES];
  return policy;
}

export async function getAvatarPolicy(em: EntityManager): Promise<AvatarPolicy> {
  const keys = Object.values(AVATAR_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export type AvatarPolicyPatch = Partial<AvatarPolicy>;

function assertPolicyMakesSense(policy: AvatarPolicy): void {
  if (policy.maxFileSizeKb < 1 || policy.maxFileSizeKb > 10_240) {
    throw unprocessable('maxFileSizeKb must be between 1 and 10240');
  }
  if (policy.allowedMimeTypes.length === 0) {
    throw unprocessable('At least one image type must stay allowed');
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updateAvatarPolicy(
  em: EntityManager,
  patch: AvatarPolicyPatch,
  userId: string,
): Promise<{ previous: AvatarPolicy; updated: AvatarPolicy }> {
  const previous = await getAvatarPolicy(em);
  const candidate: AvatarPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof AvatarPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  const unsupported = candidate.allowedMimeTypes.filter(
    (m) => !(SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(m),
  );
  if (unsupported.length > 0) {
    throw unprocessable(`Only image uploads are supported; rejected: ${unsupported.join(', ')}`);
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(AVATAR_CONFIG_KEYS) as (keyof AvatarPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = AVATAR_CONFIG_KEYS[field];
    const numeric =
      kind === 'number'
        ? Number(candidate[field])
        : kind === 'boolean'
          ? ((candidate[field] as boolean) ? 1 : 0)
          : Number(previous.maxFileSizeKb);
    const text = kind === 'csv' ? candidate.allowedMimeTypes.join(',') : null;
    await writeConfigRow(em, { key, value: numeric, valueText: text, description, updatedBy: userId });
  }

  const updated = await getAvatarPolicy(em);
  return { previous, updated };
}

export { AVATAR_CONFIG_KEYS };
