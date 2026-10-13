import { describe, expect, it } from 'vitest';
import { ApprovalLevel } from '../entities/types';
import { computeRequiredLevels } from './approval.service';

const thresholds = { checkerThreshold: 1_000_000, headThreshold: 10_000_000 };

describe('computeRequiredLevels', () => {
  it('requires checker approval at or below the checker threshold', () => {
    expect(computeRequiredLevels(1_000_000, thresholds)).toEqual([ApprovalLevel.CHECKER]);
  });

  it('requires head approval above the checker threshold through the head threshold', () => {
    expect(computeRequiredLevels(1_000_001, thresholds)).toEqual([
      ApprovalLevel.CHECKER,
      ApprovalLevel.HEAD,
    ]);
    expect(computeRequiredLevels(10_000_000, thresholds)).toEqual([
      ApprovalLevel.CHECKER,
      ApprovalLevel.HEAD,
    ]);
  });

  it('requires admin final approval above the head threshold', () => {
    expect(computeRequiredLevels(10_000_001, thresholds)).toEqual([
      ApprovalLevel.CHECKER,
      ApprovalLevel.HEAD,
      ApprovalLevel.ADMIN,
    ]);
  });
});
