import type { TFunction } from 'i18next';
import { formatLak, PenaltyMode, type PenaltyPolicy } from '../api/types';

/** One sentence describing what a penalty policy charges, for tables and summaries. */
export const describePenalty = (t: TFunction, policy: PenaltyPolicy | null): string => {
  if (!policy || policy.mode === PenaltyMode.NONE) return t('products.penaltyNone');
  const unit = t(`units.${policy.period}`);
  const parts = [
    policy.mode === PenaltyMode.PERCENT_OF_OVERDUE
      ? t('products.penaltyPercentDisplay', { rate: policy.ratePercent, unit })
      : t('products.penaltyFixedDisplay', { amount: formatLak(policy.amount), unit }),
  ];
  if (policy.graceDays > 0) parts.push(t('schedule.graceDays', { days: policy.graceDays }));
  if (policy.maxPercentOfPrincipal > 0) {
    parts.push(t('schedule.penaltyCap', { percent: policy.maxPercentOfPrincipal }));
  }
  return parts.join(' · ');
};
