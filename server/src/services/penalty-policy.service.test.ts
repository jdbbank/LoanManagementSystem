import { describe, expect, it } from 'vitest';
import { DEFAULT_PENALTY_POLICY, PenaltyMode, PeriodUnit, type PenaltyPolicy } from '../entities/types';
import { penaltyCeilingOf } from './penalty-policy.service';

const policy = (patch: Partial<PenaltyPolicy>): PenaltyPolicy => ({ ...DEFAULT_PENALTY_POLICY, ...patch });

describe('penaltyCeilingOf', () => {
  it('is 0 when the policy sets no ceiling', () => {
    expect(penaltyCeilingOf(policy({ mode: PenaltyMode.PERCENT_OF_OVERDUE, ratePercent: 2, period: PeriodUnit.MONTH, maxPercentOfPrincipal: 0 }), 1_000_000)).toBe(0);
  });

  it('reads the ceiling as a percent of the loan principal', () => {
    expect(penaltyCeilingOf(policy({ maxPercentOfPrincipal: 10 }), 1_000_000)).toBe(100_000);
    expect(penaltyCeilingOf(policy({ maxPercentOfPrincipal: 0.01 }), 1_000_000)).toBe(100);
  });

  it('rounds the ceiling to the kips the ledger stores', () => {
    expect(penaltyCeilingOf(policy({ maxPercentOfPrincipal: 5 }), 3333.35)).toBe(166.67);
  });
});
