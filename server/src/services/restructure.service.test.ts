import { describe, expect, it } from 'vitest';
import {
  CollateralStatus,
  InterestMethod,
  KycStatus,
  LoanPartyRole,
  PeriodUnit,
  RestructureChangeType,
} from '../entities/types';
import type { CollateralPolicy, LoanTermSnapshot } from '../entities/types';
import type { LoanCollateral } from '../entities/loan-collateral.entity';
import type { LoanParty } from '../entities/loan-party.entity';
import { computeCollateralCoverage } from './collateral.service';
import type { PartyKycState } from './loan-party.service';
import {
  MAX_RESTRUCTURED_TERM_MONTHS,
  proposeAfterTerms,
  validateProposal,
  type RestructureContext,
  type RestructureProposalInput,
} from './restructure.service';

const NOW = new Date('2026-10-15T08:00:00.000Z');

const policy: CollateralPolicy = {
  minCoveragePercent: 100,
  maxValuationAgeDays: 365,
  requirePledgeForRestructure: true,
};

function pledge(appraisedValue: number): LoanCollateral {
  return {
    status: CollateralStatus.PLEDGED,
    description: 'Title deed 4417',
    appraisedValue,
    valuedAt: new Date('2026-09-01'),
  } as LoanCollateral;
}

const before: LoanTermSnapshot = {
  interestRate: 0.015,
  interestRatePeriod: PeriodUnit.MONTH,
  interestMethod: InterestMethod.FLAT,
  termMonths: 12,
  payerCustomerId: null,
};

function context(overrides: Partial<RestructureContext> = {}): RestructureContext {
  return {
    outstanding: 1000000,
    accruedInterest: 50000,
    before,
    coverage: computeCollateralCoverage([pledge(1000000)], 1000000, policy, NOW),
    policy,
    proposedPayer: null,
    ...overrides,
  };
}

function proposal(overrides: Partial<RestructureProposalInput> = {}): RestructureProposalInput {
  return {
    changeTypes: [],
    newInterestRate: null,
    newTermMonths: null,
    newPayerCustomerId: null,
    interestReliefAmount: 0,
    ...overrides,
  };
}

function payer(effective: boolean): RestructureContext['proposedPayer'] {
  const party = { id: 'party-1', customerId: 'payer-1', role: LoanPartyRole.GUARANTOR, engagedAt: NOW } as LoanParty;
  const kyc: PartyKycState = {
    status: KycStatus.VERIFIED,
    reviewedAt: NOW,
    requiredFrom: NOW,
    effective,
    nextAction: effective ? 'NONE' : 'AWAIT_REVIEW',
    hint: effective ? 'Verified for this payer engagement' : 'A checker still has to verify the payer',
  };
  return { customerId: 'payer-1', fullName: 'Ms Somchai', party, kyc };
}

describe('validateProposal', () => {
  it('accepts a rate reduction the security covers', () => {
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.INTEREST_RATE_REDUCTION], newInterestRate: 0.009 }),
        context(),
      ),
    ).not.toThrow();
  });

  it('refuses a rate that is not actually lower', () => {
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.INTEREST_RATE_REDUCTION], newInterestRate: 0.02 }),
        context(),
      ),
    ).toThrow(/not below the rate the loan carries/);
  });

  it('keeps a per-day rate at full scale instead of rounding it into the current one', () => {
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.INTEREST_RATE_REDUCTION], newInterestRate: 0.014999 }),
        context(),
      ),
    ).not.toThrow();
  });

  it('refuses a rate sent without asking for a reduction', () => {
    expect(() => validateProposal(proposal({ newInterestRate: 0.005 }), context())).toThrow(
      /without asking for a rate reduction/,
    );
  });

  it('requires an extension to be a whole number of longer months', () => {
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.TERM_EXTENSION], newTermMonths: 12 }),
        context(),
      ),
    ).toThrow(/above the current term \(12\)/);
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.TERM_EXTENSION], newTermMonths: 18.5 }),
        context(),
      ),
    ).toThrow(/whole number of months/);
  });

  it('caps how far a hardship plan may stretch', () => {
    expect(() =>
      validateProposal(
        proposal({
          changeTypes: [RestructureChangeType.TERM_EXTENSION],
          newTermMonths: MAX_RESTRUCTURED_TERM_MONTHS + 1,
        }),
        context(),
      ),
    ).toThrow(/cannot exceed 600 months/);
  });

  it('will not hand the payments to someone whose KYC does not honour the engagement', () => {
    const input = proposal({
      changeTypes: [RestructureChangeType.PAYER_CHANGE],
      newPayerCustomerId: 'payer-1',
    });
    expect(() => validateProposal(input, context({ proposedPayer: payer(false) }))).toThrow(
      /PAYER KYC is not verified for this engagement/,
    );
    expect(() => validateProposal(input, context({ proposedPayer: payer(true) }))).not.toThrow();
    expect(() => validateProposal(input, context())).toThrow(/not an active party on this loan/);
  });

  it('refuses relief larger than the interest the ledger still says is owed', () => {
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.INTEREST_RELIEF], interestReliefAmount: 50000 }),
        context(),
      ),
    ).not.toThrow();
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.INTEREST_RELIEF], interestReliefAmount: 50000.01 }),
        context(),
      ),
    ).toThrow(/cannot cancel more interest than is still owed/);
  });

  it('refuses an amount of relief that nobody asked for', () => {
    expect(() => validateProposal(proposal({ interestReliefAmount: 10000 }), context())).toThrow(
      /without asking for relief/,
    );
  });

  it('rejects the same change listed twice', () => {
    expect(() =>
      validateProposal(
        proposal({
          changeTypes: [RestructureChangeType.TERM_EXTENSION, RestructureChangeType.TERM_EXTENSION],
          newTermMonths: 24,
        }),
        context(),
      ),
    ).toThrow(/duplicate/);
  });

  it('blocks the paper when the security no longer covers the debt', () => {
    const ctx = context({
      coverage: computeCollateralCoverage([pledge(400000)], 1000000, policy, NOW),
    });
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.TERM_EXTENSION], newTermMonths: 24 }),
        ctx,
      ),
    ).toThrow(/Collateral check failed/);
  });

  it('still blocks stale security when the pledge requirement is switched off', () => {
    const ctx = context({
      policy: { ...policy, requirePledgeForRestructure: false },
      coverage: computeCollateralCoverage(
        [{ ...pledge(1000000), valuedAt: new Date('2019-01-01') } as LoanCollateral],
        1000000,
        policy,
        NOW,
      ),
    });
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.TERM_EXTENSION], newTermMonths: 24 }),
        ctx,
      ),
    ).toThrow(/out of date, so nothing counts as coverage/);
  });

  it('lets an unsecured book restructure when the pledge requirement is off', () => {
    const ctx = context({
      policy: { ...policy, requirePledgeForRestructure: false },
      coverage: computeCollateralCoverage([], 1000000, policy, NOW),
    });
    expect(() =>
      validateProposal(
        proposal({ changeTypes: [RestructureChangeType.TERM_EXTENSION], newTermMonths: 24 }),
        ctx,
      ),
    ).not.toThrow();
  });
});

describe('proposeAfterTerms', () => {
  it('changes only what the addendum asks for', () => {
    const after = proposeAfterTerms(
      before,
      proposal({ changeTypes: [RestructureChangeType.INTEREST_RATE_REDUCTION], newInterestRate: 0.008 }),
    );
    expect(after).toEqual({ ...before, interestRate: 0.008 });
  });

  it('applies every requested change at once', () => {
    const after = proposeAfterTerms(
      { ...before, payerCustomerId: 'old-payer' },
      proposal({
        changeTypes: [
          RestructureChangeType.INTEREST_RATE_REDUCTION,
          RestructureChangeType.TERM_EXTENSION,
          RestructureChangeType.PAYER_CHANGE,
        ],
        newInterestRate: 0.0075,
        newTermMonths: 36,
        newPayerCustomerId: 'payer-1',
      }),
    );
    expect(after).toEqual({
      interestRate: 0.0075,
      interestRatePeriod: PeriodUnit.MONTH,
      interestMethod: InterestMethod.FLAT,
      termMonths: 36,
      payerCustomerId: 'payer-1',
    });
  });

  it('keeps the scale-6 rate exactly as written', () => {
    const after = proposeAfterTerms(
      { ...before, interestRate: 0.000123 },
      proposal({ changeTypes: [RestructureChangeType.INTEREST_RATE_REDUCTION], newInterestRate: 0.000091 }),
    );
    expect(after.interestRate).toBe(0.000091);
  });
});
