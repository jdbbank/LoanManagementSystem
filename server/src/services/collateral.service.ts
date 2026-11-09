import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { Loan } from '../entities/loan.entity';
import { LoanCollateral } from '../entities/loan-collateral.entity';
import { LoanParty } from '../entities/loan-party.entity';
import {
  CollateralCoverageSnapshot,
  CollateralPolicy,
  CollateralStatus,
  CollateralType,
  LoanPartyStatus,
  LoanStatus,
} from '../entities/types';
import { EPS, num, round2 } from '../utils/money';
import { notFound, unprocessable } from '../utils/errors';
import { getBalances, totalOutstanding } from './loan-balance.service';
import { writeAudit } from './audit.service';

const DAY_MS = 86_400_000;

/** Midnight UTC of the day `now` falls in, so an age in days never depends on the clock time. */
function startOfTodayUtc(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function ageInDays(valuedAt: Date | string, now: Date): number {
  const day = new Date(valuedAt).getTime();
  return Math.floor((startOfTodayUtc(now) - day) / DAY_MS);
}

/**
 * A pledge counts only while it is pledged AND its appraisal is in date. An old valuation is not
 * coverage — it is a number somebody wrote down years ago — so it is excluded from the total and
 * named in the warnings instead of quietly inflating what the security is worth. Warnings explain;
 * only the reasons decide.
 */
export function computeCollateralCoverage(
  collaterals: LoanCollateral[],
  outstanding: number,
  policy: CollateralPolicy,
  now = new Date(),
): CollateralCoverageSnapshot {
  const pledged = collaterals.filter((c) => c.status === CollateralStatus.PLEDGED);

  const counted: LoanCollateral[] = [];
  const stale: LoanCollateral[] = [];
  for (const item of pledged) {
    const outOfDate =
      policy.maxValuationAgeDays > 0 && ageInDays(item.valuedAt, now) > policy.maxValuationAgeDays;
    (outOfDate ? stale : counted).push(item);
  }

  const appraisedTotal = round2(counted.reduce((total, item) => total + num(item.appraisedValue), 0));
  const owed = Math.max(0, num(outstanding));
  const coveragePercent = owed > EPS ? round2((appraisedTotal / owed) * 100) : 100;

  const reasons: string[] = [];
  const warnings: string[] = [];
  if (pledged.length === 0) {
    reasons.push('This loan has no pledged collateral on record');
  } else if (stale.length > 0) {
    warnings.push(
      `${stale.length} appraisal(s) older than ${policy.maxValuationAgeDays} day(s) are not counted: ` +
        stale.map((s) => `${s.description} (${String(s.valuedAt).slice(0, 10)})`).join(', '),
    );
  }

  if (pledged.length > 0 && counted.length === 0) {
    reasons.push('Every pledge on record is out of date, so nothing counts as coverage');
  } else if (coveragePercent + EPS < policy.minCoveragePercent) {
    reasons.push(
      `Coverage ${coveragePercent}% of the outstanding ${owed} is below the required ` +
        `${policy.minCoveragePercent}% (${round2((owed * policy.minCoveragePercent) / 100)})`,
    );
  }

  const oldestValuedAt =
    counted.length === 0
      ? null
      : counted
          .map((c) => String(c.valuedAt).slice(0, 10))
          .sort()
          .at(0)!;

  return {
    pledgedCount: pledged.length,
    appraisedTotal,
    outstanding: owed,
    coveragePercent,
    requiredCoveragePercent: policy.minCoveragePercent,
    oldestValuedAt,
    valuationMaxAgeDays: policy.maxValuationAgeDays,
    passed: reasons.length === 0,
    reasons,
    warnings,
  };
}

/** The gate the restructure submission uses: no coverage, no addendum. */
export function assertCollateralCoverage(coverage: CollateralCoverageSnapshot): void {
  if (coverage.passed) return;
  throw unprocessable(`Collateral check failed — ${coverage.reasons.join('; ')}`);
}

/**
 * What a hardship addendum has to clear. An ADMIN can switch the pledge requirement off for a book that
 * lends unsecured, but once anything is pledged against the loan its value still has to cover the debt —
 * switching the requirement off does not make stale security worth what it is not.
 */
export function assertCoverageAllowsRestructure(
  coverage: CollateralCoverageSnapshot,
  policy: CollateralPolicy,
): void {
  if (coverage.pledgedCount === 0 && !policy.requirePledgeForRestructure) return;
  assertCollateralCoverage(coverage);
}

export interface RegisterCollateralInput {
  loanId: string;
  type: CollateralType;
  description: string;
  certificateNo?: string | null;
  appraisedValue: number;
  valuedAt: Date;
  ownerCustomerId?: string | null;
  note?: string | null;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function registerCollateral(
  em: EntityManager,
  input: RegisterCollateralInput,
): Promise<LoanCollateral> {
  const loan = await em.findOne(Loan, { where: { id: input.loanId } });
  if (!loan) throw notFound('Loan');
  if (loan.status !== LoanStatus.ACTIVE) {
    throw unprocessable(`Loan is ${loan.status} — collateral is pledged against an ACTIVE loan`);
  }
  if (num(input.appraisedValue) <= EPS) {
    throw unprocessable('An appraisal of zero pledges nothing');
  }
  if (input.valuedAt.getTime() > Date.now()) {
    throw unprocessable('valuedAt cannot be in the future');
  }

  let ownerCustomerId = input.ownerCustomerId ?? null;
  if (ownerCustomerId) {
    const owner = await em.findOne(Customer, { where: { id: ownerCustomerId } });
    if (!owner) throw notFound('Collateral owner');
    if (owner.id !== loan.customerId) {
      const parties = await em.find(LoanParty, { where: { loanId: loan.id } });
      if (!parties.some((p) => p.customerId === owner.id && p.status === LoanPartyStatus.ACTIVE)) {
        throw unprocessable(
          `${owner.fullName} holds no active role on this loan, so their property cannot be pledged against it`,
        );
      }
    }
  }

  const item = em.create(LoanCollateral, {
    loanId: loan.id,
    ownerCustomerId,
    type: input.type,
    status: CollateralStatus.PLEDGED,
    description: input.description,
    certificateNo: input.certificateNo ?? null,
    appraisedValue: round2(num(input.appraisedValue)),
    valuedAt: input.valuedAt,
    note: input.note ?? null,
    createdBy: input.userId,
  });
  await em.save(LoanCollateral, item);

  await writeAudit(em, {
    action: 'LOAN_COLLATERAL_PLEDGED',
    loanId: loan.id,
    customerId: loan.customerId,
    userId: input.userId,
    newStatus: CollateralStatus.PLEDGED,
    amount: num(item.appraisedValue),
    currency: loan.currency,
    makerUserId: input.userId,
    reason:
      `${item.type} pledged: ${item.description}` +
      `${item.certificateNo ? ` (${item.certificateNo})` : ''} appraised ${num(item.appraisedValue)} ` +
      `on ${String(item.valuedAt).slice(0, 10)}`,
    sourceRequestId: item.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return item;
}

export interface ReleaseCollateralInput {
  collateralId: string;
  reason: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

export async function releaseCollateral(
  em: EntityManager,
  input: ReleaseCollateralInput,
): Promise<LoanCollateral> {
  const item = await em.findOne(LoanCollateral, {
    where: { id: input.collateralId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!item) throw notFound('Collateral');
  if (item.status !== CollateralStatus.PLEDGED) {
    throw unprocessable(`Collateral is ${item.status} — only a PLEDGED item can be released`);
  }

  item.status = CollateralStatus.RELEASED;
  item.releasedAt = new Date();
  item.releaseReason = input.reason;
  await em.save(LoanCollateral, item);

  const loan = await em.findOne(Loan, { where: { id: item.loanId } });
  await writeAudit(em, {
    action: 'LOAN_COLLATERAL_RELEASED',
    loanId: item.loanId,
    customerId: loan?.customerId ?? null,
    userId: input.userId,
    previousStatus: CollateralStatus.PLEDGED,
    newStatus: CollateralStatus.RELEASED,
    amount: num(item.appraisedValue),
    currency: loan?.currency ?? null,
    makerUserId: input.userId,
    reason: `${item.type} released: ${item.description} — ${input.reason}`,
    sourceRequestId: item.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return item;
}

export function findCollaterals(em: EntityManager, loanId: string): Promise<LoanCollateral[]> {
  return em.find(LoanCollateral, { where: { loanId }, order: { valuedAt: 'DESC' } });
}

/** What the loan owes right now, in the same components the ledger keeps. */
export function loanOutstanding(loan: Loan): number {
  return totalOutstanding(getBalances(loan));
}
