import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { CollateralPolicy } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { readConfigRows, writeConfigRow } from './system-config.service';

/**
 * Collateral rules are central configuration, exactly like the KYC and payment policies: env defaults
 * overridden by `collateral.*` rows in system_config, read through this one service. A restructure
 * check re-reads the policy when it runs, so an ADMIN can raise the coverage floor without a restart.
 */
export const MAX_COVERAGE_PERCENT = 1000;
export const MAX_VALUATION_AGE_DAYS = 3650;

const COLLATERAL_CONFIG_KEYS: Record<
  keyof CollateralPolicy,
  { key: string; kind: 'number' | 'boolean'; description: string; zeroIsValue?: boolean }
> = {
  minCoveragePercent: {
    key: 'collateral.minCoveragePercent',
    kind: 'number',
    description: 'Pledged value must cover at least this percent of what is still owed',
    // 0 means "no coverage floor at all", which is a real setting rather than an absent one.
    zeroIsValue: true,
  },
  maxValuationAgeDays: {
    key: 'collateral.maxValuationAgeDays',
    kind: 'number',
    description: 'An appraisal older than this many days no longer counts as coverage; 0 = never expires',
    zeroIsValue: true,
  },
  requirePledgeForRestructure: {
    key: 'collateral.requirePledgeForRestructure',
    kind: 'boolean',
    description: 'Refuse a hardship addendum on a loan that has no in-date pledged item at all',
  },
};

export const DEFAULT_COLLATERAL_POLICY: CollateralPolicy = {
  minCoveragePercent: env.collateral.minCoveragePercent,
  maxValuationAgeDays: env.collateral.maxValuationAgeDays,
  requirePledgeForRestructure: env.collateral.requirePledgeForRestructure,
};

function overlay(rows: Map<string, { value: number; valueText: string | null }>): CollateralPolicy {
  const policy: CollateralPolicy = { ...DEFAULT_COLLATERAL_POLICY };
  for (const field of Object.keys(COLLATERAL_CONFIG_KEYS) as (keyof CollateralPolicy)[]) {
    const row = rows.get(COLLATERAL_CONFIG_KEYS[field].key);
    if (!row) continue;
    if (COLLATERAL_CONFIG_KEYS[field].kind === 'number') {
      const n = Number(row.value);
      const zeroAccepted = COLLATERAL_CONFIG_KEYS[field].zeroIsValue === true;
      if (Number.isFinite(n) && (n > 0 || (n === 0 && zeroAccepted))) (policy[field] as number) = n;
    } else {
      (policy[field] as boolean) = Number(row.value) === 1;
    }
  }
  return policy;
}

export async function getCollateralPolicy(em: EntityManager): Promise<CollateralPolicy> {
  const keys = Object.values(COLLATERAL_CONFIG_KEYS).map((c) => c.key);
  return overlay(await readConfigRows(em, keys));
}

export function describeCollateralPolicy(policy: CollateralPolicy): string {
  return (
    `minCoverage=${policy.minCoveragePercent}%,` +
    `valuationMaxAge=${policy.maxValuationAgeDays}d,` +
    `pledgeRequired=${policy.requirePledgeForRestructure ? '1' : '0'}`
  );
}

export function collateralPolicyChecksum(policy: CollateralPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex').slice(0, 16);
}

export type CollateralPolicyPatch = Partial<CollateralPolicy>;

/** Business rules for the policy itself — the shape check lives in the router's zod schema. */
function assertPolicyMakesSense(policy: CollateralPolicy): void {
  if (policy.minCoveragePercent < 0 || policy.minCoveragePercent > MAX_COVERAGE_PERCENT) {
    throw unprocessable(`minCoveragePercent must be between 0 and ${MAX_COVERAGE_PERCENT}`);
  }
  if (policy.maxValuationAgeDays < 0 || policy.maxValuationAgeDays > MAX_VALUATION_AGE_DAYS) {
    throw unprocessable(`maxValuationAgeDays must be between 0 and ${MAX_VALUATION_AGE_DAYS}`);
  }
}

/** Applies a patch to system_config and returns the previous and resolved policies. */
export async function updateCollateralPolicy(
  em: EntityManager,
  patch: CollateralPolicyPatch,
  userId: string,
): Promise<{ previous: CollateralPolicy; updated: CollateralPolicy }> {
  const previous = await getCollateralPolicy(em);
  const candidate: CollateralPolicy = { ...previous };
  for (const [field, value] of Object.entries(patch) as [keyof CollateralPolicy, unknown][]) {
    if (value !== undefined) (candidate[field] as unknown) = value;
  }
  assertPolicyMakesSense(candidate);

  for (const field of Object.keys(COLLATERAL_CONFIG_KEYS) as (keyof CollateralPolicy)[]) {
    if (patch[field] === undefined) continue;
    const { key, kind, description } = COLLATERAL_CONFIG_KEYS[field];
    const numeric =
      kind === 'number' ? Number(candidate[field]) : ((candidate[field] as boolean) ? 1 : 0);
    await writeConfigRow(em, { key, value: numeric, valueText: null, description, updatedBy: userId });
  }

  const updated = await getCollateralPolicy(em);
  return { previous, updated };
}

export { COLLATERAL_CONFIG_KEYS };
