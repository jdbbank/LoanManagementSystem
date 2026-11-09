import { describe, expect, it } from 'vitest';
import type { Customer } from '../entities/customer.entity';
import { KycStatus, LoanPartyRole } from '../entities/types';
import { assertPartyEffective, partyKycState, type PartyKycState } from './loan-party.service';

const ENGAGED_AT = new Date('2026-10-01T09:30:00.000Z');

type KycCustomer = Pick<Customer, 'kycStatus' | 'kycReviewedAt' | 'kycSubmittedAt' | 'kycRejectionReason'>;

function customer(overrides: Partial<KycCustomer> = {}): KycCustomer {
  return {
    kycStatus: KycStatus.NOT_VERIFIED,
    kycReviewedAt: null,
    kycSubmittedAt: null,
    kycRejectionReason: null,
    ...overrides,
  };
}

function stateFor(overrides: Partial<KycCustomer>, documentCount = 0): PartyKycState {
  return partyKycState({ engagedAt: ENGAGED_AT, role: LoanPartyRole.GUARANTOR }, customer(overrides), documentCount);
}

describe('partyKycState', () => {
  it('honours a verification dated at or after the engagement', () => {
    const state = stateFor({ kycStatus: KycStatus.VERIFIED, kycReviewedAt: new Date('2026-10-02T00:00:00.000Z') });
    expect(state).toMatchObject({ effective: true, nextAction: 'NONE' });
  });

  it('refuses a verification from before the engagement, even when the person is VERIFIED', () => {
    const state = stateFor({ kycStatus: KycStatus.VERIFIED, kycReviewedAt: new Date('2024-03-01T00:00:00.000Z') });
    expect(state.effective).toBe(false);
    expect(state.nextAction).toBe('REOPEN_AND_RESUBMIT');
    expect(state.hint).toMatch(/before this engagement/);
  });

  it('treats the exact instant of review as honoured, not a second behind it', () => {
    const state = stateFor({ kycStatus: KycStatus.VERIFIED, kycReviewedAt: ENGAGED_AT });
    expect(state.effective).toBe(true);
    const justBefore = stateFor({
      kycStatus: KycStatus.VERIFIED,
      kycReviewedAt: new Date(ENGAGED_AT.getTime() - 1),
    });
    expect(justBefore.effective).toBe(false);
  });

  it('asks for a submission when documents exist but nobody has submitted them', () => {
    const state = stateFor({ kycStatus: KycStatus.PENDING });
    expect(state.nextAction).toBe('SUBMIT');
  });

  it('waits on the reviewer once the KYC has been submitted', () => {
    const state = stateFor({ kycStatus: KycStatus.PENDING, kycSubmittedAt: new Date('2026-10-03T00:00:00.000Z') });
    expect(state.nextAction).toBe('AWAIT_REVIEW');
    expect(state.hint).toMatch(/checker or head approver/);
  });

  it('asks for new evidence after a rejection, carrying the reason', () => {
    const state = stateFor({
      kycStatus: KycStatus.REJECTED,
      kycRejectionReason: 'The selfie is unreadable',
    });
    expect(state.nextAction).toBe('UPLOAD_DOCUMENTS');
    expect(state.hint).toMatch(/The selfie is unreadable/);
  });

  it('starts at upload for a person with nothing on file and at submit once they have documents', () => {
    expect(stateFor({}).nextAction).toBe('UPLOAD_DOCUMENTS');
    expect(stateFor({}, 2).nextAction).toBe('SUBMIT');
  });
});

describe('assertPartyEffective', () => {
  it('lets an honoured engagement through', () => {
    const state = stateFor({ kycStatus: KycStatus.VERIFIED, kycReviewedAt: ENGAGED_AT });
    expect(() => assertPartyEffective(state, { role: LoanPartyRole.GUARANTOR })).not.toThrow();
  });

  it('names the role and the missing step otherwise', () => {
    const state = stateFor({ kycStatus: KycStatus.PENDING, kycSubmittedAt: new Date('2026-10-03T00:00:00.000Z') });
    expect(() => assertPartyEffective(state, { role: LoanPartyRole.PAYER })).toThrow(
      /PAYER KYC is not verified for this engagement/,
    );
  });
});
