import { describe, expect, it } from 'vitest';
import { CollateralStatus, CollateralType, type CollateralPolicy } from '../entities/types';
import type { LoanCollateral } from '../entities/loan-collateral.entity';
import { computeCollateralCoverage } from './collateral.service';

const NOW = new Date('2026-10-15T08:00:00.000Z');

const policy: CollateralPolicy = {
  minCoveragePercent: 100,
  maxValuationAgeDays: 365,
  requirePledgeForRestructure: true,
};

function pledge(overrides: Partial<LoanCollateral> = {}): LoanCollateral {
  return {
    type: CollateralType.LAND,
    status: CollateralStatus.PLEDGED,
    description: 'Title deed 4417',
    appraisedValue: 1000000,
    valuedAt: new Date('2026-09-01'),
    ...overrides,
  } as LoanCollateral;
}

describe('computeCollateralCoverage', () => {
  it('passes when in-date pledged value at least equals what is owed', () => {
    const coverage = computeCollateralCoverage([pledge()], 1000000, policy, NOW);
    expect(coverage).toMatchObject({
      pledgedCount: 1,
      appraisedTotal: 1000000,
      coveragePercent: 100,
      passed: true,
      reasons: [],
    });
  });

  it('reports the shortfall against the required floor', () => {
    const coverage = computeCollateralCoverage([pledge({ appraisedValue: 400000 })], 1000000, policy, NOW);
    expect(coverage.passed).toBe(false);
    expect(coverage.coveragePercent).toBe(40);
    expect(coverage.reasons.join(' ')).toMatch(/below the required 100% \(1000000\)/);
  });

  it('excludes an appraisal older than the policy allows and warns about it', () => {
    const coverage = computeCollateralCoverage(
      [pledge(), pledge({ description: 'Old title deed', appraisedValue: 900000, valuedAt: new Date('2020-01-01') })],
      1000000,
      policy,
      NOW,
    );
    expect(coverage.pledgedCount).toBe(2);
    expect(coverage.appraisedTotal).toBe(1000000);
    expect(coverage.reasons).toEqual([]);
    expect(coverage.warnings.join(' ')).toMatch(
      /1 appraisal\(s\) older than 365 day\(s\) are not counted: Old title deed/,
    );
    expect(coverage.passed).toBe(true);
  });

  it('fails when every pledge on record is out of date', () => {
    const coverage = computeCollateralCoverage(
      [pledge({ valuedAt: new Date('2019-05-05') })],
      1000000,
      policy,
      NOW,
    );
    expect(coverage.appraisedTotal).toBe(0);
    expect(coverage.coveragePercent).toBe(0);
    expect(coverage.oldestValuedAt).toBeNull();
    expect(coverage.passed).toBe(false);
    expect(coverage.reasons.join(' ')).toMatch(/nothing counts as coverage/);
  });

  it('never expires appraisals when the age limit is zero', () => {
    const coverage = computeCollateralCoverage(
      [pledge({ valuedAt: new Date('2001-01-01') })],
      1000000,
      { ...policy, maxValuationAgeDays: 0 },
      NOW,
    );
    expect(coverage.appraisedTotal).toBe(1000000);
    expect(coverage.passed).toBe(true);
  });

  it('ignores released items entirely', () => {
    const coverage = computeCollateralCoverage(
      [pledge(), pledge({ status: CollateralStatus.RELEASED, appraisedValue: 5000000 })],
      1000000,
      policy,
      NOW,
    );
    expect(coverage.pledgedCount).toBe(1);
    expect(coverage.appraisedTotal).toBe(1000000);
  });

  it('treats a settled loan as fully covered by what is still pledged', () => {
    const coverage = computeCollateralCoverage([pledge()], 0, policy, NOW);
    expect(coverage.coveragePercent).toBe(100);
    expect(coverage.passed).toBe(true);
  });

  it('says so when a loan has no collateral at all', () => {
    const coverage = computeCollateralCoverage([], 500000, policy, NOW);
    expect(coverage.passed).toBe(false);
    expect(coverage.reasons).toContain('This loan has no pledged collateral on record');
  });

  it('rounds the total to the cent the ledger keeps', () => {
    const coverage = computeCollateralCoverage(
      [pledge({ appraisedValue: 333333.334 }), pledge({ appraisedValue: 333333.334 })],
      666666.66,
      policy,
      NOW,
    );
    expect(coverage.appraisedTotal).toBe(666666.67);
    expect(coverage.coveragePercent).toBe(100.00);
  });
});
