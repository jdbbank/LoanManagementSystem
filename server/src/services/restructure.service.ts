import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { KycDocument } from '../entities/kyc-document.entity';
import { Loan } from '../entities/loan.entity';
import { LoanParty } from '../entities/loan-party.entity';
import { RestructureRequest } from '../entities/restructure-request.entity';
import {
  ApprovalLevel,
  ApprovalSubjectType,
  CollateralCoverageSnapshot,
  CollateralPolicy,
  LoanPartyRole,
  LoanPartyStatus,
  LoanStatus,
  LoanTermSnapshot,
  PeriodUnit,
  RestructureChangeType,
  RestructureStatus,
  TransactionStatus,
  TransactionType,
} from '../entities/types';
import { AuthUser } from '../middleware/auth';
import { badRequest, conflict, notFound, unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';
import { createWorkflow } from './approval.service';
import { writeAudit } from './audit.service';
import { assertCoverageAllowsRestructure, computeCollateralCoverage, findCollaterals, loanOutstanding } from './collateral.service';
import { getCollateralPolicy } from './collateral-policy.service';
import {
  activePayerOf,
  assertPartyEffective,
  findParties,
  partyKycState,
  registerParty,
  releaseParty,
  type PartyKycState,
} from './loan-party.service';
import { nextRestructureNo, nextTransactionNo } from './reference.service';
import {
  notifyPartyRegistered,
  notifyPartyReleased,
  notifyRestructureApplied,
  notifyRestructureRequested,
} from './notification-events.service';

/** The longest hardship plan the paper allows, matching the term ceiling a loan is drawn with. */
export const MAX_RESTRUCTURED_TERM_MONTHS = 600;

export interface RestructureProposalInput {
  changeTypes: RestructureChangeType[];
  newInterestRate: number | null;
  newTermMonths: number | null;
  newPayerCustomerId: string | null;
  interestReliefAmount: number;
}

/** The person the addendum wants to pay, and the engagement their KYC was verified against. */
export interface ProposedPayer {
  customerId: string;
  fullName: string;
  party: LoanParty;
  kyc: PartyKycState;
}

export interface RestructureContext {
  outstanding: number;
  accruedInterest: number;
  before: LoanTermSnapshot;
  coverage: CollateralCoverageSnapshot;
  policy: CollateralPolicy;
  proposedPayer: ProposedPayer | null;
}

export function termsOf(loan: Loan, payerCustomerId: string | null): LoanTermSnapshot {
  return {
    interestRate: num(loan.interestRate),
    interestRatePeriod: loan.interestRatePeriod,
    interestMethod: loan.interestMethod,
    termMonths: num(loan.termMonths),
    payerCustomerId,
  };
}

/**
 * Everything the addendum asks for, decided before any of it is approved.
 *
 * The checks are deliberately boring: a rate only ever goes down, a term only ever goes up, relief can
 * only cancel interest the ledger still says is owed, and the security plus the payer's KYC have to
 * stand up on the day the paper is written. Nothing here writes, so a rejected proposal leaves no trace
 * beyond its own row.
 */
export function validateProposal(input: RestructureProposalInput, ctx: RestructureContext): void {
  const asked = new Set(input.changeTypes);
  if (asked.size !== input.changeTypes.length) {
    throw badRequest('changeTypes contains a duplicate');
  }

  if (asked.has(RestructureChangeType.INTEREST_RATE_REDUCTION)) {
    const rate = num(input.newInterestRate ?? 0);
    if (rate <= EPS) throw unprocessable('A rate reduction needs the new rate, greater than zero');
    if (rate >= num(ctx.before.interestRate)) {
      throw unprocessable(
        `The new rate (${rate}) is not below the rate the loan carries (${num(ctx.before.interestRate)}) — ` +
          `this paper relieves a borrower, it does not re-price them upward`,
      );
    }
  } else if (input.newInterestRate !== null) {
    throw unprocessable('A new rate was sent without asking for a rate reduction');
  }

  if (asked.has(RestructureChangeType.TERM_EXTENSION)) {
    const months = num(input.newTermMonths ?? 0);
    if (!Number.isInteger(months) || months <= ctx.before.termMonths) {
      throw unprocessable(
        `An extension needs a whole number of months above the current term (${ctx.before.termMonths})`,
      );
    }
    if (months > MAX_RESTRUCTURED_TERM_MONTHS) {
      throw unprocessable(`A restructured term cannot exceed ${MAX_RESTRUCTURED_TERM_MONTHS} months`);
    }
  } else if (input.newTermMonths !== null) {
    throw unprocessable('A new term was sent without asking for an extension');
  }

  if (asked.has(RestructureChangeType.PAYER_CHANGE)) {
    if (!input.newPayerCustomerId) {
      throw unprocessable('A payer change needs the customer who will pay from now on');
    }
    if (!ctx.proposedPayer) {
      throw unprocessable(
        'The proposed payer is not an active party on this loan — register them as a guarantor or payer first',
      );
    }
    assertPartyEffective(ctx.proposedPayer.kyc, { role: LoanPartyRole.PAYER });
  } else if (input.newPayerCustomerId) {
    throw unprocessable('A new payer was sent without asking for a payer change');
  }

  const relief = round2(num(input.interestReliefAmount));
  if (asked.has(RestructureChangeType.INTEREST_RELIEF)) {
    if (relief <= EPS) throw unprocessable('Interest relief needs an amount greater than zero');
    if (relief - num(ctx.accruedInterest) > EPS) {
      throw unprocessable(
        `Relief (${relief}) cannot cancel more interest than is still owed (${num(ctx.accruedInterest)})`,
      );
    }
  } else if (relief > EPS) {
    throw unprocessable('An interest relief amount was sent without asking for relief');
  }

  assertCoverageAllowsRestructure(ctx.coverage, ctx.policy);
}

/** The contract as it will read once this paper is applied. */
export function proposeAfterTerms(
  before: LoanTermSnapshot,
  input: RestructureProposalInput,
): LoanTermSnapshot {
  const asked = new Set(input.changeTypes);
  return {
    // Scale 6 is what the loan column keeps, so a per-day rate is not rounded away on its way in.
    interestRate: asked.has(RestructureChangeType.INTEREST_RATE_REDUCTION)
      ? num(input.newInterestRate ?? 0)
      : before.interestRate,
    interestRatePeriod: before.interestRatePeriod,
    interestMethod: before.interestMethod,
    termMonths: asked.has(RestructureChangeType.TERM_EXTENSION)
      ? num(input.newTermMonths ?? 0)
      : before.termMonths,
    payerCustomerId: asked.has(RestructureChangeType.PAYER_CHANGE)
      ? (input.newPayerCustomerId ?? null)
      : before.payerCustomerId,
  };
}

/**
 * The party row whose engagement the payer's KYC was verified against. A person can hold several roles
 * on one loan over time, so the row that is actually honoured is the one used, and its date is what the
 * new payer engagement inherits.
 */
async function resolveProposedPayer(
  em: EntityManager,
  loanId: string,
  customerId: string,
): Promise<ProposedPayer | null> {
  const rows = await em.find(LoanParty, {
    where: { loanId, customerId, status: LoanPartyStatus.ACTIVE },
    order: { engagedAt: 'DESC' },
  });
  if (rows.length === 0) return null;

  const customer = await em.findOne(Customer, { where: { id: customerId } });
  if (!customer) throw notFound('Proposed payer');
  const documentCount = await em.count(KycDocument, { where: { customerId } });

  const states = rows.map((party) => ({ party, kyc: partyKycState(party, customer, documentCount) }));
  const honoured =
    states.find((s) => s.kyc.effective && s.party.role === LoanPartyRole.PAYER) ??
    states.find((s) => s.kyc.effective) ??
    // Nothing is honoured yet: report the most recent engagement, because that is the one staff must fix.
    states[0];

  return { customerId, fullName: customer.fullName, party: honoured.party, kyc: honoured.kyc };
}

/**
 * What the loan looks like to a hardship decision right now: the balance, the security against it, the
 * contract on file, and who would pay. Submission and application both read this, so the same rules are
 * checked on the same evidence at both ends.
 */
export async function loadRestructureContext(
  em: EntityManager,
  loan: Loan,
  newPayerCustomerId: string | null,
): Promise<RestructureContext> {
  const [policy, collaterals, activePayer] = await Promise.all([
    getCollateralPolicy(em),
    findCollaterals(em, loan.id),
    activePayerOf(em, loan.id),
  ]);
  const outstanding = loanOutstanding(loan);

  return {
    outstanding,
    accruedInterest: num(loan.outstandingPastInterest),
    before: termsOf(loan, activePayer?.customerId ?? null),
    coverage: computeCollateralCoverage(collaterals, outstanding, policy),
    policy,
    proposedPayer: newPayerCustomerId
      ? await resolveProposedPayer(em, loan.id, newPayerCustomerId)
      : null,
  };
}

export interface CreateRestructureInput extends RestructureProposalInput {
  loanId: string;
  hardshipReason: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes the addendum and puts it in front of the approval engine with a Checker and a Head as its
 * floor: re-papering a signed contract is never a two-person job between a maker and one checker,
 * whatever the amount. The approval levels still come from the balance being re-priced, so a large loan
 * can need the Admin above the Head.
 */
export async function createRestructureRequest(
  em: EntityManager,
  input: CreateRestructureInput,
): Promise<RestructureRequest> {
  const loan = await em.findOne(Loan, { where: { id: input.loanId }, lock: { mode: 'pessimistic_write' } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — a hardship addendum rewrites a live contract`);
  }

  const ctx = await loadRestructureContext(em, loan, input.newPayerCustomerId);
  validateProposal(input, ctx);

  const after = proposeAfterTerms(ctx.before, input);
  const relief = round2(num(input.interestReliefAmount));

  const request = em.create(RestructureRequest, {
    requestNo: await nextRestructureNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    status: RestructureStatus.PENDING_APPROVAL,
    hardshipReason: input.hardshipReason,
    changeTypes: input.changeTypes,
    newInterestRate: askedFor(input.changeTypes, RestructureChangeType.INTEREST_RATE_REDUCTION)
      ? num(input.newInterestRate ?? 0)
      : null,
    newTermMonths: askedFor(input.changeTypes, RestructureChangeType.TERM_EXTENSION)
      ? num(input.newTermMonths ?? 0)
      : null,
    newPayerCustomerId: askedFor(input.changeTypes, RestructureChangeType.PAYER_CHANGE)
      ? (input.newPayerCustomerId ?? null)
      : null,
    interestReliefAmount: relief,
    repricingAmount: round2(ctx.outstanding),
    currency: loan.currency,
    beforeTerms: ctx.before,
    afterTerms: after,
    collateralSnapshot: ctx.coverage,
    createdBy: input.userId,
  });
  await em.save(RestructureRequest, request);

  await createWorkflow(em, {
    subjectType: ApprovalSubjectType.RESTRUCTURE_REQUEST,
    subjectId: request.id,
    amount: request.repricingAmount,
    currency: request.currency,
    makerUserId: input.userId,
    minimumLevels: [ApprovalLevel.CHECKER, ApprovalLevel.HEAD],
  });

  await writeAudit(em, {
    action: 'RESTRUCTURE_REQUESTED',
    loanId: loan.id,
    customerId: loan.customerId,
    userId: input.userId,
    newStatus: RestructureStatus.PENDING_APPROVAL,
    amount: request.repricingAmount,
    currency: request.currency,
    makerUserId: input.userId,
    reason:
      `Addendum ${request.requestNo} (${request.changeTypes.join(', ')}) for ${input.hardshipReason} — ` +
      `rate ${ctx.before.interestRate}${ctx.before.interestRatePeriod} -> ${after.interestRate}${after.interestRatePeriod}, ` +
      `term ${ctx.before.termMonths} -> ${after.termMonths} month(s), relief ${relief}, ` +
      `payer ${ctx.before.payerCustomerId ?? 'the borrower'} -> ${after.payerCustomerId ?? 'unchanged'}. ` +
      `Collateral covers ${ctx.coverage.coveragePercent}% of ${ctx.outstanding}.`,
    sourceRequestId: request.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  await notifyRestructureRequested(em, {
    loanId: loan.id,
    requestNo: request.requestNo,
    changeTypes: request.changeTypes,
    newInterestRate: request.newInterestRate,
    interestRatePeriod: ctx.before.interestRatePeriod,
    newTermMonths: request.newTermMonths,
    reliefAmount: relief,
    currency: request.currency,
  });

  return request;
}

function askedFor(changeTypes: RestructureChangeType[], wanted: RestructureChangeType): boolean {
  return changeTypes.includes(wanted);
}

export interface ApplyRestructureInput {
  requestId: string;
  user: AuthUser;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AppliedRestructure {
  request: RestructureRequest;
  loan: Loan;
  waiverTransactionId: string | null;
}

/**
 * Puts an approved addendum into force. Two things happen and nothing else: the loan's own snapshot
 * terms are rewritten, and the interest relief is drafted as a WAIVER transaction that goes through the
 * normal approval and posting engine like every other waiver. The outstanding balances move only when
 * that waiver is posted, so the ledger still explains every figure on the loan.
 */
export async function applyRestructure(
  em: EntityManager,
  input: ApplyRestructureInput,
): Promise<AppliedRestructure> {
  const request = await em.findOne(RestructureRequest, {
    where: { id: input.requestId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!request) throw notFound('Restructure request');
  if (request.status === RestructureStatus.APPLIED) {
    throw conflict(`Addendum ${request.requestNo} has already been applied`);
  }
  if (request.status !== RestructureStatus.APPROVED) {
    throw unprocessable(
      `Addendum ${request.requestNo} is ${request.status} — only an approved one can be applied`,
    );
  }

  const loan = await em.findOne(Loan, { where: { id: request.loanId }, lock: { mode: 'pessimistic_write' } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(
      `Loan is ${loan.status} — the contract this addendum rewrites is no longer live`,
    );
  }

  const ctx = await loadRestructureContext(em, loan, request.newPayerCustomerId);
  assertTermsUnchangedSinceApproval(request, ctx.before);
  validateProposal(proposalOf(request), ctx);

  const beforeBalance = {
    interestRate: num(loan.interestRate),
    termMonths: num(loan.termMonths),
    outstanding: ctx.outstanding,
  };

  const after = request.afterTerms;
  loan.interestRate = after.interestRate;
  loan.interestRatePeriod = after.interestRatePeriod;
  if (after.termMonths !== num(loan.termMonths)) {
    loan.termValue = after.termMonths;
    loan.termUnit = PeriodUnit.MONTH;
    loan.termMonths = after.termMonths;
  }
  await em.save(Loan, loan);

  const payerChanged =
    !!request.newPayerCustomerId && request.newPayerCustomerId !== ctx.before.payerCustomerId;
  if (payerChanged) await swapPayer(em, request, loan, ctx, input.user.id);

  const relief = round2(num(request.interestReliefAmount));
  const waiverTransactionId =
    relief > EPS
      ? (await draftReliefWaiver(em, request, loan, relief, input)).id
      : null;

  request.status = RestructureStatus.APPLIED;
  request.appliedBy = input.user.id;
  request.appliedAt = new Date();
  request.waiverTransactionId = waiverTransactionId;
  await em.save(RestructureRequest, request);

  await writeAudit(em, {
    action: 'RESTRUCTURE_APPLIED',
    loanId: loan.id,
    customerId: loan.customerId,
    userId: input.user.id,
    amount: relief > EPS ? relief : beforeBalance.outstanding,
    currency: loan.currency,
    makerUserId: input.user.id,
    checkerUserId: request.decidedBy,
    previousStatus: RestructureStatus.APPROVED,
    newStatus: RestructureStatus.APPLIED,
    reason:
      `Addendum ${request.requestNo} applied: rate ${beforeBalance.interestRate} -> ${after.interestRate}, ` +
      `term ${beforeBalance.termMonths} -> ${after.termMonths} month(s)` +
      `${payerChanged ? `, payer now ${ctx.proposedPayer?.fullName ?? request.newPayerCustomerId}` : ''}` +
      `${waiverTransactionId ? `, interest relief of ${relief} drafted as a waiver to approve and post` : ''}`,
    sourceRequestId: request.id,
    referenceTransactionId: waiverTransactionId,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  await notifyRestructureApplied(em, {
    loanId: loan.id,
    requestNo: request.requestNo,
    newInterestRate: num(after.interestRate),
    interestRatePeriod: after.interestRatePeriod,
    newTermMonths: num(after.termMonths),
    reliefAmount: relief,
    currency: loan.currency,
    appliedAt: request.appliedAt ?? new Date(),
    makerUserId: request.createdBy,
  });

  return { request, loan, waiverTransactionId };
}

/**
 * The contract must still be the one the approver signed. A payment, an accrual or a second addendum in
 * between changes what the paper means, so it is withdrawn and rewritten rather than applied blind.
 */
function assertTermsUnchangedSinceApproval(request: RestructureRequest, current: LoanTermSnapshot): void {
  const on = request.beforeTerms;
  const drifted =
    num(on.interestRate) !== num(current.interestRate) ||
    on.interestRatePeriod !== current.interestRatePeriod ||
    num(on.termMonths) !== num(current.termMonths) ||
    on.payerCustomerId !== current.payerCustomerId;
  if (!drifted) return;
  throw unprocessable(
    `The loan no longer carries the terms this addendum was approved against ` +
      `(rate ${num(on.interestRate)} ${on.interestRatePeriod}, ${on.termMonths} month(s), ` +
      `payer ${on.payerCustomerId ?? 'the borrower'}; now rate ${num(current.interestRate)} ` +
      `${current.interestRatePeriod}, ${num(current.termMonths)} month(s), ` +
      `payer ${current.payerCustomerId ?? 'the borrower'}) — withdraw it and write a new one`,
  );
}

function proposalOf(request: RestructureRequest): RestructureProposalInput {
  return {
    changeTypes: request.changeTypes,
    newInterestRate: request.newInterestRate,
    newTermMonths: request.newTermMonths,
    newPayerCustomerId: request.newPayerCustomerId,
    interestReliefAmount: num(request.interestReliefAmount),
  };
}

/**
 * The approved replacement pays from now on, so the outgoing payer is released first and the new one
 * takes up the PAYER role on the engagement date their KYC was verified against. A release never erases
 * what the old payer owed while they held the role.
 */
async function swapPayer(
  em: EntityManager,
  request: RestructureRequest,
  loan: Loan,
  ctx: RestructureContext,
  userId: string,
): Promise<void> {
  const incoming = ctx.proposedPayer;
  if (!incoming) {
    throw unprocessable('The payer named in this addendum is no longer an active party on the loan');
  }

  const outgoing = (await em.find(LoanParty, { where: { loanId: loan.id } })).filter(
    (party) =>
      party.role === LoanPartyRole.PAYER &&
      party.status === LoanPartyStatus.ACTIVE &&
      party.customerId !== incoming.customerId,
  );
  for (const party of outgoing) {
    const reason = `Replaced as payer by addendum ${request.requestNo}`;
    const released = await releaseParty(em, { partyId: party.id, reason, userId });
    await notifyPartyReleased(em, {
      loanId: loan.id,
      partyCustomerId: party.customerId,
      role: party.role,
      reason,
      releasedAt: released.releasedAt ?? new Date(),
    });
  }

  const payer = await registerParty(em, {
    loanId: loan.id,
    customerId: incoming.customerId,
    role: LoanPartyRole.PAYER,
    relationship: incoming.party.relationship,
    note: `Named as payer by addendum ${request.requestNo}`,
    engagedAt: incoming.party.engagedAt,
    userId,
  });
  await notifyPartyRegistered(em, {
    loanId: loan.id,
    partyCustomerId: payer.customerId,
    role: payer.role,
    engagedAt: payer.engagedAt,
  });
}

/**
 * The relief as a draft waiver on the loan's own outstanding interest. It is created PENDING_APPROVAL
 * with its own maker-checker trail rather than posted here, because nothing in this system may move
 * money outside the approval and posting engine — the addendum approves the decision, this row carries
 * it into the ledger.
 */
async function draftReliefWaiver(
  em: EntityManager,
  request: RestructureRequest,
  loan: Loan,
  relief: number,
  input: ApplyRestructureInput,
): Promise<FinancialTransaction> {
  const outstanding = num(loan.outstandingPastInterest);
  if (relief - outstanding > EPS) {
    throw unprocessable(
      `Interest still owed (${outstanding}) no longer covers the ${relief} this addendum relieves`,
    );
  }

  const tx = em.create(FinancialTransaction, {
    referenceNo: await nextTransactionNo(em),
    loanId: loan.id,
    customerId: loan.customerId,
    transactionType: TransactionType.WAIVER,
    status: TransactionStatus.PENDING_APPROVAL,
    amount: relief,
    currency: loan.currency,
    componentAmounts: { PENALTY: 0, PAST_INTEREST: relief, PAST_PRINCIPAL: 0 },
    reason: `Interest relief under addendum ${request.requestNo}: ${request.hardshipReason}`,
    createdBy: input.user.id,
  });
  await em.save(FinancialTransaction, tx);

  await createWorkflow(em, {
    subjectType: ApprovalSubjectType.FINANCIAL_TRANSACTION,
    subjectId: tx.id,
    amount: relief,
    currency: tx.currency,
    makerUserId: input.user.id,
  });

  await writeAudit(em, {
    action: 'TRANSACTION_CREATED',
    transactionId: tx.id,
    transactionType: tx.transactionType,
    loanId: loan.id,
    customerId: loan.customerId,
    userId: input.user.id,
    previousStatus: 'DRAFT',
    newStatus: TransactionStatus.PENDING_APPROVAL,
    amount: tx.amount,
    currency: tx.currency,
    makerUserId: input.user.id,
    reason: tx.reason,
    sourceRequestId: request.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return tx;
}

/** The addendum plus the paper around it: who approved it, what it relieved, and what it costs now. */
export async function restructureState(em: EntityManager, request: RestructureRequest) {
  const [loan, waiver] = await Promise.all([
    em.findOne(Loan, { where: { id: request.loanId } }),
    request.waiverTransactionId
      ? em.findOne(FinancialTransaction, { where: { id: request.waiverTransactionId } })
      : Promise.resolve(null),
  ]);
  if (!loan) throw notFound('Loan');

  const parties = await findParties(em, loan.id);
  return {
    request,
    loan: {
      id: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      interestRate: num(loan.interestRate),
      interestRatePeriod: loan.interestRatePeriod,
      termMonths: num(loan.termMonths),
      outstanding: loanOutstanding(loan),
    },
    waiver,
    parties: parties.map((party) => ({ id: party.id, role: party.role, status: party.status })),
  };
}
