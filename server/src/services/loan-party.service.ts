import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { Loan } from '../entities/loan.entity';
import { LoanParty } from '../entities/loan-party.entity';
import { KycStatus, LoanPartyRole, LoanPartyStatus, LoanStatus } from '../entities/types';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { writeAudit } from './audit.service';

/**
 * Guarantors and replacement payers are ordinary customers, so their identity evidence goes through the
 * existing KYC pipeline unchanged. What this service adds is the engagement rule: the verification
 * decision must be dated at or after the moment the person took on THIS role for THIS loan
 * (`engagedAt`). Being verified for somebody else's loan years ago proves nothing here, so every new
 * engagement forces a fresh submission and a fresh review.
 */

/** The next thing staff must do before this engagement is honoured. */
export type PartyKycAction = 'NONE' | 'UPLOAD_DOCUMENTS' | 'SUBMIT' | 'AWAIT_REVIEW' | 'REOPEN_AND_RESUBMIT';

export interface PartyKycState {
  status: KycStatus;
  reviewedAt: Date | null;
  requiredFrom: Date;
  /** True when the person may act in this role on this loan. */
  effective: boolean;
  nextAction: PartyKycAction;
  hint: string;
}

const ROLE_LABEL: Record<LoanPartyRole, string> = {
  [LoanPartyRole.GUARANTOR]: 'guarantor',
  [LoanPartyRole.PAYER]: 'payer',
};

export function partyKycState(
  party: Pick<LoanParty, 'engagedAt' | 'role'>,
  customer: Pick<Customer, 'kycStatus' | 'kycReviewedAt' | 'kycSubmittedAt' | 'kycRejectionReason'>,
  documentCount: number,
): PartyKycState {
  const status = customer.kycStatus;
  const reviewedAt = customer.kycReviewedAt ?? null;
  const requiredFrom = party.engagedAt;
  const role = ROLE_LABEL[party.role];

  const reviewedForThisEngagement =
    status === KycStatus.VERIFIED && reviewedAt !== null && reviewedAt.getTime() >= requiredFrom.getTime();

  if (reviewedForThisEngagement) {
    return {
      status,
      reviewedAt,
      requiredFrom,
      effective: true,
      nextAction: 'NONE',
      hint: `Verified for this ${role} engagement`,
    };
  }

  if (status === KycStatus.VERIFIED) {
    return {
      status,
      reviewedAt,
      requiredFrom,
      effective: false,
      nextAction: 'REOPEN_AND_RESUBMIT',
      hint: `KYC was verified before this engagement — an ADMIN reopens it, then the documents are submitted and reviewed again`,
    };
  }

  if (status === KycStatus.PENDING) {
    return customer.kycSubmittedAt === null
      ? {
          status,
          reviewedAt,
          requiredFrom,
          effective: false,
          nextAction: 'SUBMIT',
          hint: `KYC documents are uploaded but not submitted for the ${role} review`,
        }
      : {
          status,
          reviewedAt,
          requiredFrom,
          effective: false,
          nextAction: 'AWAIT_REVIEW',
          hint: `A checker or head approver still has to verify the ${role}`,
        };
  }

  if (status === KycStatus.REJECTED) {
    return {
      status,
      reviewedAt,
      requiredFrom,
      effective: false,
      nextAction: 'UPLOAD_DOCUMENTS',
      hint: `KYC was rejected${customer.kycRejectionReason ? `: ${customer.kycRejectionReason}` : ''} — new evidence is needed`,
    };
  }

  return {
    status,
    reviewedAt,
    requiredFrom,
    effective: false,
    nextAction: documentCount > 0 ? 'SUBMIT' : 'UPLOAD_DOCUMENTS',
    hint:
      documentCount > 0
        ? `Upload is done; submit the ${role}'s KYC for review`
        : `No KYC documents on file for the ${role}`,
  };
}

/** Refuse anything that needs a real guarantor or payer before their KYC honours the engagement. */
export function assertPartyEffective(state: PartyKycState, party: Pick<LoanParty, 'role'>): void {
  if (state.effective) return;
  throw unprocessable(
    `${ROLE_LABEL[party.role].toUpperCase()} KYC is not verified for this engagement — ${state.hint}`,
  );
}

export interface RegisterPartyInput {
  loanId: string;
  customerId: string;
  role: LoanPartyRole;
  relationship?: string | null;
  note?: string | null;
  /**
   * When the engagement began. Only an approved hardship addendum sets this: it names a payer whose KYC
   * was already verified for the engagement they held on the loan, so the new role starts on that date
   * rather than the day the paper was applied — the verification still postdates the engagement.
   */
  engagedAt?: Date;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Attaches a person to a loan in a role. A released row is revived rather than duplicated, and the
 * revival moves `engagedAt` forward, so the KYC requirement restarts with the new engagement.
 * Only one payer may be active at a time — the person who is asked for money must not be ambiguous.
 */
export async function registerParty(em: EntityManager, input: RegisterPartyInput): Promise<LoanParty> {
  const loan = await em.findOne(Loan, { where: { id: input.loanId } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — a ${ROLE_LABEL[input.role]} needs an ACTIVE loan`);
  }

  const customer = await em.findOne(Customer, { where: { id: input.customerId } });
  if (!customer) throw notFound('Customer');
  if (input.role === LoanPartyRole.PAYER && customer.id === loan.customerId) {
    throw unprocessable('The borrower is already the payer of their own loan');
  }

  if (input.role === LoanPartyRole.PAYER) {
    const activePayer = await em.findOne(LoanParty, {
      where: { loanId: loan.id, role: LoanPartyRole.PAYER, status: LoanPartyStatus.ACTIVE },
    });
    if (activePayer && activePayer.customerId !== customer.id) {
      const holder = await em.findOne(Customer, { where: { id: activePayer.customerId } });
      throw unprocessable(
        `${holder?.fullName ?? activePayer.customerId} is already the active payer of this loan — ` +
          `release that payer before naming another one`,
      );
    }
  }

  const engagedAt = input.engagedAt ?? new Date();
  const existing = await em.findOne(LoanParty, {
    where: { loanId: loan.id, customerId: customer.id, role: input.role },
  });

  if (existing && existing.status === LoanPartyStatus.ACTIVE) {
    throw conflict(`${customer.fullName} is already a ${ROLE_LABEL[input.role]} of this loan`);
  }

  const party =
    existing ??
    em.create(LoanParty, {
      loanId: loan.id,
      customerId: customer.id,
      role: input.role,
      createdBy: input.userId,
    });

  party.status = LoanPartyStatus.ACTIVE;
  party.engagedAt = engagedAt;
  party.relationship = input.relationship ?? party.relationship ?? null;
  party.note = input.note ?? null;
  party.releasedAt = null;
  party.releaseReason = null;
  await em.save(LoanParty, party);

  await writeAudit(em, {
    action: existing ? 'LOAN_PARTY_REENGAGED' : 'LOAN_PARTY_REGISTERED',
    loanId: loan.id,
    customerId: customer.id,
    userId: input.userId,
    newStatus: LoanPartyStatus.ACTIVE,
    previousStatus: existing ? LoanPartyStatus.RELEASED : null,
    makerUserId: input.userId,
    reason:
      `${customer.fullName} (${customer.customerNumber}) engaged as ${ROLE_LABEL[input.role]} ` +
      `from ${engagedAt.toISOString()} — KYC must be verified for this engagement` +
      `${input.note ? ` — ${input.note}` : ''}`,
    sourceRequestId: party.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return party;
}

export interface ReleasePartyInput {
  partyId: string;
  reason: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function releaseParty(em: EntityManager, input: ReleasePartyInput): Promise<LoanParty> {
  const party = await em.findOne(LoanParty, { where: { id: input.partyId }, lock: { mode: 'pessimistic_write' } });
  if (!party) throw notFound('Loan party');
  if (party.status !== LoanPartyStatus.ACTIVE) {
    throw unprocessable(`Loan party is ${party.status} — only an ACTIVE one can be released`);
  }
  const customer = await em.findOne(Customer, { where: { id: party.customerId } });
  if (!customer) throw notFound('Customer');

  party.status = LoanPartyStatus.RELEASED;
  party.releasedAt = new Date();
  party.releaseReason = input.reason;
  await em.save(LoanParty, party);

  await writeAudit(em, {
    action: 'LOAN_PARTY_RELEASED',
    loanId: party.loanId,
    customerId: party.customerId,
    userId: input.userId,
    previousStatus: LoanPartyStatus.ACTIVE,
    newStatus: LoanPartyStatus.RELEASED,
    makerUserId: input.userId,
    reason:
      `${customer.fullName} released as ${ROLE_LABEL[party.role]} — ${input.reason}. ` +
      `Debt that arose while they held the role is untouched.`,
    sourceRequestId: party.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return party;
}

/** Every row of one role on one loan, newest engagement first. */
export function findParties(
  em: EntityManager,
  loanId: string,
  role?: LoanPartyRole,
): Promise<LoanParty[]> {
  return em.find(LoanParty, {
    where: role ? { loanId, role } : { loanId },
    order: { engagedAt: 'DESC' },
  });
}

/** The person who currently pays this loan, if the branch has named one. */
export function activePayerOf(em: EntityManager, loanId: string): Promise<LoanParty | null> {
  return em.findOne(LoanParty, {
    where: { loanId, role: LoanPartyRole.PAYER, status: LoanPartyStatus.ACTIVE },
    order: { engagedAt: 'DESC' },
  });
}
