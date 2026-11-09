import { DEFAULT_PENALTY_POLICY, PenaltyMode, PenaltyPolicy, PeriodUnit } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { num, round2 } from '../utils/money';
import { DAYS_PER_UNIT } from '../utils/period';

/**
 * Penalty policy handling for loan products.
 *
 * Same central-configuration rule as the KYC policy and the approval thresholds: one shape,
 * one default, one merge point, one validator. Products store it as a column and loans snapshot
 * it at disbursement, so changing a product never re-prices an existing loan.
 */

export const PENALTY_PERIOD_OPTIONS: PeriodUnit[] = [
  PeriodUnit.DAY,
  PeriodUnit.WEEK,
  PeriodUnit.MONTH,
  PeriodUnit.YEAR,
];

/** Layer a partial update over the stored policy, ignoring fields the caller did not send. */
export function mergePenaltyPolicy(
  current: PenaltyPolicy | null | undefined,
  patch: Partial<PenaltyPolicy>,
): PenaltyPolicy {
  const base = current ?? DEFAULT_PENALTY_POLICY;
  const merged: PenaltyPolicy = { ...base };
  for (const [field, value] of Object.entries(patch) as Array<[keyof PenaltyPolicy, unknown]>) {
    if (value !== undefined) merged[field] = value as never;
  }
  return merged;
}

/** A policy is only meaningful if the mode's own input is present and sane. */
export function assertPenaltyPolicyMakesSense(policy: PenaltyPolicy): void {
  if (policy.mode === PenaltyMode.PERCENT_OF_OVERDUE && num(policy.ratePercent) <= 0) {
    throw unprocessable('PERCENT_OF_OVERDUE penalties need a ratePercent above 0');
  }
  if (policy.mode === PenaltyMode.FIXED_PER_PERIOD && num(policy.amount) <= 0) {
    throw unprocessable('FIXED_PER_PERIOD penalties need an amount above 0');
  }
  if (num(policy.maxPercentOfPrincipal) > 0 && num(policy.maxPercentOfPrincipal) < 0.01) {
    throw unprocessable('maxPercentOfPrincipal, when set, must be at least 0.01');
  }
  if (policy.mode !== PenaltyMode.NONE && DAYS_PER_UNIT[policy.period] <= 0) {
    throw unprocessable(`Unknown penalty period unit: ${String(policy.period)}`);
  }
}

/**
 * The loan's own penalty ceiling in money, or 0 when the policy sets no ceiling.
 * One formula for both paths that can bill a penalty: the accrual schedule trims its suggestion
 * to it and the posting engine refuses a manual charge that would cross it.
 */
export function penaltyCeilingOf(policy: PenaltyPolicy, principalAmount: number): number {
  const capPercent = num(policy.maxPercentOfPrincipal);
  if (capPercent <= 0) return 0;
  return round2((num(principalAmount) * capPercent) / 100);
}

/** One-line human-readable summary, used for audit reasons and the product table. */
const PERIOD_LABEL: Record<PeriodUnit, string> = {
  [PeriodUnit.DAY]: 'per day',
  [PeriodUnit.WEEK]: 'per week',
  [PeriodUnit.MONTH]: 'per month',
  [PeriodUnit.YEAR]: 'per year',
};

export function describePenaltyPolicy(policy: PenaltyPolicy): string {
  if (policy.mode === PenaltyMode.NONE) return 'no penalty';
  const unit = PERIOD_LABEL[policy.period];
  const base =
    policy.mode === PenaltyMode.PERCENT_OF_OVERDUE
      ? `${num(policy.ratePercent)}% of overdue ${unit}`
      : `${num(policy.amount)} fixed ${unit}`;
  const grace = num(policy.graceDays) > 0 ? `, after ${num(policy.graceDays)} grace days` : '';
  const cap = num(policy.maxPercentOfPrincipal) > 0 ? `, capped at ${num(policy.maxPercentOfPrincipal)}% of principal` : '';
  return `${base}${grace}${cap}`;
}
