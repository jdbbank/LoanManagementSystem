import { EntityManager, In } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { CustomerBankAccount } from '../entities/customer-bank-account.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { EvidenceDocument } from '../entities/evidence-document.entity';
import { Loan } from '../entities/loan.entity';
import { LoanParty } from '../entities/loan-party.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import { User } from '../entities/user.entity';
import {
  BankAccountStatus,
  ComponentAmounts,
  ComponentType,
  DisbursementChannel,
  InterestMethod,
  KycStatus,
  LoanPartyRole,
  LoanPartyStatus,
  NotificationEventType,
  NotificationRecipient,
  PaymentRequestPurpose,
  PeriodUnit,
  RestructureChangeType,
  UserRole,
} from '../entities/types';
import { formatAmount, num } from '../utils/money';
import { logger } from '../utils/logger';
import { maskAccountNumber } from './bank-account.service';
import { enqueueNotification, NotificationInput } from './notification.service';

/**
 * Translates a business fact into the payload its email template expects.
 * Everything here is best-effort: a notification must never roll back a posted
 * transaction, so queueing failures are logged and swallowed.
 */

const UNIT_LABEL: Record<PeriodUnit, string> = {
  DAY: 'ວັນ',
  WEEK: 'ອາທິດ',
  MONTH: 'ເດືອນ',
  YEAR: 'ປີ',
};

const COMPONENT_LABEL: Record<ComponentType, string> = {
  [ComponentType.PENALTY]: 'ຄ່າປັບ',
  [ComponentType.PAST_INTEREST]: 'ດອກເບ້ຍ',
  [ComponentType.PAST_PRINCIPAL]: 'ໜີ້ເງິນກູ້',
};

const AWAITING_APPROVAL = 'ກຳລັງລໍຖ້າອະນຸມັດ';

/** Channel and account are optional on a loan; an email must still say something readable. */
const NOT_RECORDED = 'ຍັງບໍ່ໄດ້ບັນທຶກ';

const KYC_LABEL: Record<KycStatus, string> = {
  [KycStatus.NOT_VERIFIED]: 'ຍັງບໍ່ທັນກວດສອບເອກະສານ',
  [KycStatus.PENDING]: 'ກຳລັງລໍຖ້າກວດສອບເອກະສານ',
  [KycStatus.VERIFIED]: 'ກວດສອບເອກະສານຜ່ານແລ້ວ',
  [KycStatus.REJECTED]: 'ເອກະສານຖືກປະຕິເສດ',
};

const INTEREST_METHOD_LABEL: Record<InterestMethod, string> = {
  [InterestMethod.FLAT]: 'ຄິດໄລ່ຈາກເງິນກູ້ທັງໝົດ (ດອກເບ້ຍເທົ່າກັນທຸກງວດ)',
  [InterestMethod.DECLINING]: 'ຄິດໄລ່ຈາກເງິນກູ້ທີ່ຍັງເຫຼືອ (ດອກເບ້ຍລຸ່ນໄລ່ລົງ)',
};

const CHANNEL_LABEL: Record<DisbursementChannel, string> = {
  [DisbursementChannel.BANK]: 'ໂອນເຂົ້າບັນຊີທະນາຄານ',
  [DisbursementChannel.CASH]: 'ເງິນສົດ',
};

const BANK_ACCOUNT_STATUS_LABEL: Record<BankAccountStatus, string> = {
  [BankAccountStatus.ACTIVE]: 'ໃຊ້ງານໄດ້',
  [BankAccountStatus.CLOSED]: 'ປິດໄປແລ້ວ',
};

const dateOnly = (value: Date): string => value.toISOString().slice(0, 10);

async function emit(em: EntityManager, input: NotificationInput): Promise<void> {
  try {
    await enqueueNotification(em, input);
  } catch (error) {
    logger.error(`[notify] could not queue ${input.type}`, error);
  }
}

async function customerRecipient(
  em: EntityManager,
  customerId: string | null | undefined,
): Promise<NotificationRecipient | null> {
  if (!customerId) return null;
  const customer = await em.findOne(Customer, { where: { id: customerId } });
  if (!customer?.email) return null;
  return { email: customer.email, fullName: customer.fullName };
}

interface LoanFacts {
  loanNumber: string;
  term: string;
  interestRate: string;
  currency: string;
  outstanding: number;
}

async function loanFacts(em: EntityManager, loanId: string | null | undefined): Promise<LoanFacts | null> {
  if (!loanId) return null;
  const loan = await em.findOne(Loan, { where: { id: loanId } });
  if (!loan) return null;
  return {
    loanNumber: loan.loanNumber,
    term: `${loan.termValue} ${UNIT_LABEL[loan.termUnit]}`,
    interestRate: `${num(loan.interestRate)}% / ${UNIT_LABEL[loan.interestRatePeriod]}`,
    currency: loan.currency,
    outstanding: num(loan.currentOutstanding),
  };
}

/** The components a movement touched, as one readable line. */
function allocationLine(allocation: ComponentAmounts | null | undefined, currency: string): string {
  if (!allocation) return '';
  return Object.values(ComponentType)
    .filter((component) => num(allocation[component]) > 0)
    .map((component) => `${COMPONENT_LABEL[component]} ${formatAmount(allocation[component], currency)}`)
    .join(', ');
}

/** Loan application taken in (this branch records the disbursement in the same step). */
export async function notifyLoanSubmitted(
  em: EntityManager,
  params: { loanId: string; customerId: string; productId: string; principalAmount: number },
): Promise<void> {
  const [to, facts, product] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
    em.findOne(LoanProduct, { where: { id: params.productId } }),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: NotificationEventType.LOAN_APPLICATION_SUBMITTED,
    to,
    customerId: params.customerId,
    loanId: params.loanId,
    payload: {
      loanCode: facts.loanNumber,
      productName: product?.name ?? '',
      amount: formatAmount(params.principalAmount, facts.currency),
      term: facts.term,
      status: 'ຮັບຄຳຮ້ອງແລ້ວ',
    },
  });
}

/** Final approval or rejection of a disbursement. */
export async function notifyLoanDecision(
  em: EntityManager,
  params: {
    loanId: string | null;
    customerId: string | null;
    amount: number;
    currency: string;
    approved: boolean;
    reason?: string | null;
  },
): Promise<void> {
  const [to, facts] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: params.approved
      ? NotificationEventType.LOAN_APPROVED
      : NotificationEventType.LOAN_REJECTED,
    to,
    customerId: params.customerId ?? undefined,
    loanId: params.loanId ?? undefined,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      term: facts.term,
      interestRate: facts.interestRate,
      decisionNote: params.reason?.trim() || (params.approved ? 'ອະນຸມັດ' : ''),
    },
  });
}

/** A payment that reached POSTED status — the only state worth telling a customer about. */
export async function notifyPaymentPosted(
  em: EntityManager,
  params: {
    loanId: string | null;
    customerId: string | null;
    amount: number;
    currency: string;
    paidAt: Date;
    allocation?: ComponentAmounts | null;
    remaining?: number | null;
  },
): Promise<void> {
  const [to, facts] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
  ]);
  if (!to || !facts) return;

  const allocation = allocationLine(params.allocation, params.currency);

  await emit(em, {
    type: NotificationEventType.PAYMENT_POSTED,
    to,
    customerId: params.customerId ?? undefined,
    loanId: params.loanId ?? undefined,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      paidDate: dateOnly(params.paidAt),
      allocation,
      remaining: formatAmount(params.remaining ?? facts.outstanding, params.currency),
    },
  });
}

/** Settlement (account closure) request taken in for approval. */
export async function notifySettlementRequested(
  em: EntityManager,
  params: {
    loanId: string;
    customerId: string;
    agreedAmount: number;
    currency: string;
  },
): Promise<void> {
  const [to, facts] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: NotificationEventType.SETTLEMENT_REQUESTED,
    to,
    customerId: params.customerId,
    loanId: params.loanId,
    payload: {
      loanCode: facts.loanNumber,
      settlementAmount: formatAmount(params.agreedAmount, params.currency),
      totalOutstanding: formatAmount(facts.outstanding, params.currency),
      status: AWAITING_APPROVAL,
    },
  });
}

/** Approval or rejection of a settlement agreement. */
export async function notifySettlementDecision(
  em: EntityManager,
  params: {
    loanId: string;
    customerId: string;
    agreedAmount: number;
    currency: string;
    approved: boolean;
    reason?: string | null;
    decidedAt?: Date | null;
  },
): Promise<void> {
  const [to, facts] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: NotificationEventType.SETTLEMENT_DECIDED,
    to,
    customerId: params.customerId,
    loanId: params.loanId,
    payload: {
      loanCode: facts.loanNumber,
      decision: params.approved ? 'ອະນຸມັດ' : 'ບໍ່ອະນຸມັດ',
      settlementAmount: formatAmount(params.agreedAmount, params.currency),
      dueDate: dateOnly(params.decidedAt ?? new Date()),
      decisionNote: params.reason?.trim() ?? '',
    },
  });
}

/** Welcome notice for a freshly created staff account. */
export async function notifyUserCreated(
  em: EntityManager,
  params: {
    userId: string;
    email: string | null;
    fullName: string;
    username: string;
    role: string;
    createdByName: string;
  },
): Promise<void> {
  await emit(em, {
    type: NotificationEventType.USER_CREATED,
    to: params.email ? { email: params.email, fullName: params.fullName } : null,
    userId: params.userId,
    payload: {
      username: params.username,
      role: params.role,
      createdByName: params.createdByName,
    },
  });
}

/**
 * Self-service OTP code. The plaintext code is passed straight into the email payload and
 * is never stored or logged by the notification layer.
 */
export async function notifyPasswordResetOtp(
  em: EntityManager,
  params: {
    userId: string;
    email: string | null;
    fullName: string;
    otp: string;
    expiresMinutes: number;
  },
): Promise<void> {
  await emit(em, {
    type: NotificationEventType.PASSWORD_RESET_OTP,
    to: params.email ? { email: params.email, fullName: params.fullName } : null,
    userId: params.userId,
    payload: {
      otp: params.otp,
      expiresMinutes: params.expiresMinutes,
    },
  });
}

/**
 * Admin-issued password reset link. The caller passes an already-built URL whose token
 * is a single-use secret; nothing here stores or logs it.
 */
export async function notifyPasswordResetLink(
  em: EntityManager,
  params: {
    userId: string;
    email: string | null;
    fullName: string;
    username: string;
    resetUrl: string;
    expiresMinutes: number;
  },
): Promise<void> {
  await emit(em, {
    type: NotificationEventType.PASSWORD_RESET_LINK,
    to: params.email ? { email: params.email, fullName: params.fullName } : null,
    userId: params.userId,
    payload: {
      username: params.username,
      resetUrl: params.resetUrl,
      expiresMinutes: params.expiresMinutes,
    },
  });
}

const APPROVER_ROLES: UserRole[] = [UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN];

const PARTY_ROLE_LABEL: Record<LoanPartyRole, string> = {
  [LoanPartyRole.GUARANTOR]: 'ຜູ້ຄ້ຳປະກັນ',
  [LoanPartyRole.PAYER]: 'ຜູ້ຊຳລະແທນ',
};

const CHANGE_TYPE_LABEL: Record<RestructureChangeType, string> = {
  [RestructureChangeType.INTEREST_RATE_REDUCTION]: 'ຫຼຸດອັດຕາດອກເບ້ຍ',
  [RestructureChangeType.TERM_EXTENSION]: 'ຂະຫຍາຍໄລຍະເວລາຊຳລະ',
  [RestructureChangeType.PAYER_CHANGE]: 'ປ່ຽນຜູ້ຊຳລະແທນ',
  [RestructureChangeType.INTEREST_RELIEF]: 'ຢຸດດອກເບ້ຍສະສົມ',
};

const UNCHANGED = 'ບໍ່ປ່ຽນແປງ';

/** One mailbox in an audience, remembering whether it belongs to a customer or to a staff account. */
interface Addressed {
  to: NotificationRecipient;
  customerId?: string | null;
  userId?: string | null;
}

function toAddressed(row: { email: string | null; fullName: string }, id: string, kind: 'customer' | 'user'): Addressed {
  return {
    to: { email: row.email ?? '', fullName: row.fullName },
    ...(kind === 'customer' ? { customerId: id } : { userId: id }),
  };
}

/** A person may hold two roles with one mailbox, so an audience is keyed on the address — one letter per inbox. */
function dedupedByMailbox(audience: Addressed[]): Addressed[] {
  const seen = new Set<string>();
  return audience.filter((row) => {
    const address = row.to.email.trim().toLowerCase();
    if (!address || seen.has(address)) return false;
    seen.add(address);
    return true;
  });
}

/**
 * Everyone a hardship change has to reach: the borrower, every person still holding a role on the loan,
 * and the staff who can approve it.
 */
async function hardshipAudience(
  em: EntityManager,
  params: { loanId: string; also?: Addressed[] },
): Promise<Addressed[]> {
  const [loan, parties, approvers] = await Promise.all([
    em.findOne(Loan, { where: { id: params.loanId } }),
    em.find(LoanParty, { where: { loanId: params.loanId, status: LoanPartyStatus.ACTIVE } }),
    em.find(User, { where: { role: In(APPROVER_ROLES), isActive: true } }),
  ]);

  const customerIds = new Set(parties.map((party) => party.customerId));
  if (loan) customerIds.add(loan.customerId);
  const customers = customerIds.size
    ? await em.find(Customer, { where: { id: In([...customerIds]) } })
    : [];

  return dedupedByMailbox([
    ...customers.map((customer) => toAddressed(customer, customer.id, 'customer')),
    ...approvers.map((user) => toAddressed(user, user.id, 'user')),
    ...(params.also ?? []),
  ]);
}

/**
 * The borrower plus the staff who can act on a collection event: a request waits for a Checker, and a
 * posted charge, waiver or write-off was released under an authority that should see it land. Unlike a
 * hardship change, these touch no guarantor's duty, so the loan's other people are left out.
 */
async function collectionAudience(
  em: EntityManager,
  params: { loanId: string; also?: Addressed[] },
): Promise<Addressed[]> {
  const [loan, approvers] = await Promise.all([
    em.findOne(Loan, { where: { id: params.loanId } }),
    em.find(User, { where: { role: In(APPROVER_ROLES), isActive: true } }),
  ]);
  const borrower = loan ? await em.findOne(Customer, { where: { id: loan.customerId } }) : null;

  return dedupedByMailbox([
    ...(borrower ? [toAddressed(borrower, borrower.id, 'customer')] : []),
    ...approvers.map((user) => toAddressed(user, user.id, 'user')),
    ...(params.also ?? []),
  ]);
}

/**
 * Book-level changes belong to no loan, so the audience is the staff who can act on them: every
 * active approver, plus whoever the caller names. The person who made the change is left out —
 * they already know, and a letter to them would only be a receipt of their own click.
 */
async function staffAudience(
  em: EntityManager,
  params: { actorUserId?: string | null; also?: Addressed[] },
): Promise<Addressed[]> {
  const approvers = await em.find(User, { where: { role: In(APPROVER_ROLES), isActive: true } });
  return dedupedByMailbox([
    ...approvers.filter((user) => user.id !== params.actorUserId).map((user) => toAddressed(user, user.id, 'user')),
    ...(params.also ?? []),
  ]);
}

async function customerAddressed(em: EntityManager, customerId: string): Promise<Addressed[]> {
  const customer = await em.findOne(Customer, { where: { id: customerId } });
  return customer?.email ? [toAddressed(customer, customer.id, 'customer')] : [];
}

async function userAddressed(em: EntityManager, userId: string | null | undefined): Promise<Addressed[]> {
  if (!userId) return [];
  const user = await em.findOne(User, { where: { id: userId } });
  return user?.email ? [toAddressed(user, user.id, 'user')] : [];
}

/** One outbox row per recipient, best-effort like every other notification here. */
async function emitToAll(
  em: EntityManager,
  params: {
    type: NotificationEventType;
    /** Null for events that belong to no loan — a customer record, a product. */
    loanId: string | null;
    payload: Record<string, string | number | null>;
    audience: Addressed[];
  },
): Promise<void> {
  for (const recipient of params.audience) {
    await emit(em, {
      type: params.type,
      to: recipient.to,
      loanId: params.loanId,
      customerId: recipient.customerId ?? null,
      userId: recipient.userId ?? null,
      payload: params.payload,
    });
  }
}

/** A person was taken on as a guarantor or a replacement payer. */
export async function notifyPartyRegistered(
  em: EntityManager,
  params: { loanId: string; partyCustomerId: string; role: LoanPartyRole; engagedAt: Date },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    hardshipAudience(em, { loanId: params.loanId }),
  ]);
  const party = await em.findOne(Customer, { where: { id: params.partyCustomerId } });
  if (!facts || !party) return;

  await emitToAll(em, {
    type: NotificationEventType.PARTY_REGISTERED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      partyRole: PARTY_ROLE_LABEL[params.role],
      partyName: party.fullName,
      partyCustomerNumber: party.customerNumber,
      effectiveDate: dateOnly(params.engagedAt),
    },
  });
}

/**
 * A guarantor or payer was released. They are no longer an ACTIVE row by the time this runs, so they are
 * added to the audience by hand — the person whose duty just ended is the last one it should be told to.
 */
export async function notifyPartyReleased(
  em: EntityManager,
  params: {
    loanId: string;
    partyCustomerId: string;
    role: LoanPartyRole;
    reason: string;
    releasedAt: Date;
  },
): Promise<void> {
  const [facts, released] = await Promise.all([
    loanFacts(em, params.loanId),
    customerAddressed(em, params.partyCustomerId),
  ]);
  if (!facts) return;

  const party = await em.findOne(Customer, { where: { id: params.partyCustomerId } });
  if (!party) return;
  const audience = await hardshipAudience(em, { loanId: params.loanId, also: released });

  await emitToAll(em, {
    type: NotificationEventType.PARTY_RELEASED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      partyRole: PARTY_ROLE_LABEL[params.role],
      partyName: party.fullName,
      releaseReason: params.reason,
      effectiveDate: dateOnly(params.releasedAt),
    },
  });
}

/** The addendum the borrower cannot pay under any more has been written and is waiting for authority. */
export async function notifyRestructureRequested(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    changeTypes: RestructureChangeType[];
    newInterestRate: number | null;
    interestRatePeriod: PeriodUnit | null;
    newTermMonths: number | null;
    reliefAmount: number;
    currency: string;
  },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    hardshipAudience(em, { loanId: params.loanId }),
  ]);
  if (!facts) return;

  await emitToAll(em, {
    type: NotificationEventType.RESTRUCTURE_REQUESTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      changeTypes: params.changeTypes.map((change) => CHANGE_TYPE_LABEL[change]).join(', '),
      newInterestRate:
        params.newInterestRate === null
          ? UNCHANGED
          : `${num(params.newInterestRate)}% / ${params.interestRatePeriod ? UNIT_LABEL[params.interestRatePeriod] : ''}`.trim(),
      newTermMonths:
        params.newTermMonths === null ? UNCHANGED : `${params.newTermMonths} ${UNIT_LABEL[PeriodUnit.MONTH]}`,
      reliefAmount: formatAmount(params.reliefAmount, params.currency),
      status: AWAITING_APPROVAL,
    },
  });
}

/** The authority decided: the addendum is either ready to put into force or it is refused. */
export async function notifyRestructureDecision(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    approved: boolean;
    reason?: string | null;
    makerUserId?: string | null;
  },
): Promise<void> {
  const [facts, maker] = await Promise.all([
    loanFacts(em, params.loanId),
    userAddressed(em, params.makerUserId),
  ]);
  if (!facts) return;

  const audience = await hardshipAudience(em, { loanId: params.loanId, also: maker });

  await emitToAll(em, {
    type: NotificationEventType.RESTRUCTURE_DECIDED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      decision: params.approved ? 'ອະນຸມັດ' : 'ບໍ່ອະນຸມັດ',
      decisionNote: params.reason?.trim() ?? '',
    },
  });
}

/** The addendum is in force: the contract now reads differently and the relief has been booked. */
export async function notifyRestructureApplied(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    newInterestRate: number;
    interestRatePeriod: PeriodUnit;
    newTermMonths: number;
    reliefAmount: number;
    currency: string;
    appliedAt: Date;
    makerUserId?: string | null;
  },
): Promise<void> {
  const [facts, maker] = await Promise.all([
    loanFacts(em, params.loanId),
    userAddressed(em, params.makerUserId),
  ]);
  if (!facts) return;

  const audience = await hardshipAudience(em, { loanId: params.loanId, also: maker });

  await emitToAll(em, {
    type: NotificationEventType.RESTRUCTURE_APPLIED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      newInterestRate: `${num(params.newInterestRate)}% / ${UNIT_LABEL[params.interestRatePeriod]}`,
      newTermMonths: `${params.newTermMonths} ${UNIT_LABEL[PeriodUnit.MONTH]}`,
      reliefAmount: formatAmount(params.reliefAmount, params.currency),
      appliedDate: dateOnly(params.appliedAt),
    },
  });
}

const PURPOSE_LABEL: Record<PaymentRequestPurpose, string> = {
  [PaymentRequestPurpose.PAY_DEBT]: 'ຊຳລະໜີ້',
  [PaymentRequestPurpose.DEPOSIT_TO_CREDIT]: 'ນຳເງິນເຂົ້າເຄຣດິດ',
};

const VERIFIED = 'ຢືນຢັນແລ້ວ';

/**
 * Staff received money and drafted the request. It waits for a Checker, so the borrower is told what
 * was taken in and the staff who can verify it are told something is on their desk.
 */
export async function notifyPaymentRequestSubmitted(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    amount: number;
    currency: string;
    purpose: PaymentRequestPurpose;
    receivedAt: Date;
  },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    collectionAudience(em, { loanId: params.loanId }),
  ]);
  if (!facts) return;

  await emitToAll(em, {
    type: NotificationEventType.PAYMENT_REQUEST_SUBMITTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      purposeLabel: PURPOSE_LABEL[params.purpose],
      amount: formatAmount(params.amount, params.currency),
      receivedDate: dateOnly(params.receivedAt),
      status: AWAITING_APPROVAL,
    },
  });
}

/**
 * A Checker verified the draft. Nothing has been booked yet — the receipt the customer waits for is
 * the posted payment, so this letter only reports that the amount cleared verification.
 */
export async function notifyPaymentRequestVerified(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    amount: number;
    currency: string;
    allocation: ComponentAmounts;
    makerUserId?: string | null;
  },
): Promise<void> {
  const [facts, maker] = await Promise.all([
    loanFacts(em, params.loanId),
    userAddressed(em, params.makerUserId),
  ]);
  if (!facts) return;

  const audience = await collectionAudience(em, { loanId: params.loanId, also: maker });

  await emitToAll(em, {
    type: NotificationEventType.PAYMENT_REQUEST_APPROVED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      amount: formatAmount(params.amount, params.currency),
      allocation: allocationLine(params.allocation, params.currency),
      remaining: formatAmount(facts.outstanding, params.currency),
      status: VERIFIED,
    },
  });
}

/** A Checker refused the draft, so the money is held and no debt is settled. */
export async function notifyPaymentRequestRejected(
  em: EntityManager,
  params: {
    loanId: string;
    requestNo: string;
    amount: number;
    currency: string;
    reason: string;
    makerUserId?: string | null;
  },
): Promise<void> {
  const [facts, maker] = await Promise.all([
    loanFacts(em, params.loanId),
    userAddressed(em, params.makerUserId),
  ]);
  if (!facts) return;

  const audience = await collectionAudience(em, { loanId: params.loanId, also: maker });

  await emitToAll(em, {
    type: NotificationEventType.PAYMENT_REQUEST_REJECTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      requestNo: params.requestNo,
      amount: formatAmount(params.amount, params.currency),
      reason: params.reason.trim(),
    },
  });
}

/**
 * Money arrived that no instalment could absorb, so it landed on the customer's credit instead of
 * their debt. The customer needs to know they hold it, because the auto-debit job will spend it.
 */
export async function notifyCreditDeposited(
  em: EntityManager,
  params: {
    loanId: string;
    customerId: string;
    amount: number;
    currency: string;
    depositedAt: Date;
    note?: string | null;
  },
): Promise<void> {
  const [to, facts, credit] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
    em.findOne(CustomerCredit, { where: { customerId: params.customerId, currency: params.currency } }),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: NotificationEventType.CREDIT_DEPOSITED,
    to,
    customerId: params.customerId,
    loanId: params.loanId,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      creditBalance: formatAmount(num(credit?.balance ?? 0), params.currency),
      depositedDate: dateOnly(params.depositedAt),
      note: params.note?.trim() ?? '',
    },
  });
}

/**
 * The auto-debit job closed one instalment out of credit the customer deposited themselves. It is
 * deliberately not the ordinary receipt: no cash arrived now, and the period number is the whole
 * point of the letter.
 */
export async function notifyAutoDebitPosted(
  em: EntityManager,
  params: {
    loanId: string;
    customerId: string;
    amount: number;
    currency: string;
    periodIndex: number;
    paidAt: Date;
    allocation: ComponentAmounts;
    remaining: number;
  },
): Promise<void> {
  const [to, facts] = await Promise.all([
    customerRecipient(em, params.customerId),
    loanFacts(em, params.loanId),
  ]);
  if (!to || !facts) return;

  await emit(em, {
    type: NotificationEventType.AUTO_DEBIT_POSTED,
    to,
    customerId: params.customerId,
    loanId: params.loanId,
    payload: {
      loanCode: facts.loanNumber,
      instalment: String(params.periodIndex),
      amount: formatAmount(params.amount, params.currency),
      allocation: allocationLine(params.allocation, params.currency),
      paidDate: dateOnly(params.paidAt),
      remaining: formatAmount(params.remaining, params.currency),
    },
  });
}

/** A penalty reached the book after its own approval, so the debt the customer owes has grown. */
export async function notifyPenaltyPosted(
  em: EntityManager,
  params: {
    loanId: string;
    amount: number;
    currency: string;
    postedAt: Date;
    reason?: string | null;
  },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    collectionAudience(em, { loanId: params.loanId }),
  ]);
  if (!facts) return;

  await emitToAll(em, {
    type: NotificationEventType.PENALTY_POSTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      postedDate: dateOnly(params.postedAt),
      reason: params.reason?.trim() ?? '',
      remaining: formatAmount(facts.outstanding, params.currency),
    },
  });
}

/** Debt was forgiven and booked: the customer must be told how much they no longer owe. */
export async function notifyWaiverPosted(
  em: EntityManager,
  params: {
    loanId: string;
    amount: number;
    currency: string;
    components: ComponentAmounts;
    postedAt: Date;
    reason?: string | null;
  },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    collectionAudience(em, { loanId: params.loanId }),
  ]);
  if (!facts) return;

  await emitToAll(em, {
    type: NotificationEventType.WAIVER_POSTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      components: allocationLine(params.components, params.currency),
      postedDate: dateOnly(params.postedAt),
      reason: params.reason?.trim() ?? '',
      remaining: formatAmount(facts.outstanding, params.currency),
    },
  });
}

/**
 * Debt was written off the book. Relief is not forgiveness, so the letter says the collection right
 * survives — the difference a customer otherwise learns about from a statement.
 */
export async function notifyWriteOffPosted(
  em: EntityManager,
  params: {
    loanId: string;
    amount: number;
    currency: string;
    components: ComponentAmounts;
    postedAt: Date;
    reason?: string | null;
  },
): Promise<void> {
  const [facts, audience] = await Promise.all([
    loanFacts(em, params.loanId),
    collectionAudience(em, { loanId: params.loanId }),
  ]);
  if (!facts) return;

  await emitToAll(em, {
    type: NotificationEventType.WRITE_OFF_POSTED,
    loanId: params.loanId,
    audience,
    payload: {
      loanCode: facts.loanNumber,
      amount: formatAmount(params.amount, params.currency),
      components: allocationLine(params.components, params.currency),
      postedDate: dateOnly(params.postedAt),
      reason: params.reason?.trim() ?? '',
      remaining: formatAmount(facts.outstanding, params.currency),
    },
  });
}

/**
 * A customer record was opened. Nothing can be lent against it yet, so the letter that matters is
 * the one that says which documents are still missing — and it goes to the staff who review them as
 * well as to the customer, who otherwise learns about the gap from a rejected disbursement.
 */
export async function notifyCustomerRegistered(
  em: EntityManager,
  params: { customerId: string; createdByName: string; actorUserId?: string | null },
): Promise<void> {
  const customer = await em.findOne(Customer, { where: { id: params.customerId } });
  if (!customer) return;

  const audience = await staffAudience(em, {
    actorUserId: params.actorUserId,
    also: [toAddressed(customer, customer.id, 'customer')],
  });

  await emitToAll(em, {
    type: NotificationEventType.CUSTOMER_REGISTERED,
    loanId: null,
    audience,
    payload: {
      customerName: customer.fullName,
      customerNumber: customer.customerNumber,
      phone: customer.phone ?? '',
      email: customer.email ?? '',
      kycStatus: KYC_LABEL[customer.kycStatus],
      createdByName: params.createdByName,
      registeredDate: dateOnly(customer.createdAt ?? new Date()),
    },
  });
}

/**
 * A new product is on the shelf. The desk that writes loans needs to hear it from the system rather
 * than from a colleague, and the letter states the terms exactly as stored — a product row is used as
 * it is, so a rate quoted here is a rate a future loan will snapshot.
 */
export async function notifyLoanProductCreated(
  em: EntityManager,
  params: { productId: string; createdByName: string; actorUserId?: string | null },
): Promise<void> {
  const product = await em.findOne(LoanProduct, { where: { id: params.productId } });
  if (!product) return;

  const audience = await staffAudience(em, { actorUserId: params.actorUserId });
  if (!audience.length) return;

  await emitToAll(em, {
    type: NotificationEventType.LOAN_PRODUCT_CREATED,
    loanId: null,
    audience,
    payload: {
      productCode: product.code,
      productName: product.name,
      interestRate: `${num(product.interestRate)}% / ${UNIT_LABEL[product.interestRatePeriod]}`,
      interestMethod: INTEREST_METHOD_LABEL[product.interestMethod],
      term: `${product.termValue} ${UNIT_LABEL[product.termUnit]}`,
      currency: product.currency,
      createdByName: params.createdByName,
      createdDate: dateOnly(product.createdAt ?? new Date()),
    },
  });
}

/**
 * An account number was filed against a customer. The letter goes to the approvers who will use that
 * account and to the customer it belongs to, because an account recorded wrongly is a payment sent to
 * the wrong person — and only the customer can say whether the number is right. The masked form is what
 * an email is safe to carry.
 */
export async function notifyBankAccountRegistered(
  em: EntityManager,
  params: { accountId: string; createdByName: string; actorUserId?: string | null },
): Promise<void> {
  const account = await em.findOne(CustomerBankAccount, { where: { id: params.accountId } });
  if (!account) return;
  const customer = await em.findOne(Customer, { where: { id: account.customerId } });
  if (!customer) return;

  const audience = await staffAudience(em, {
    actorUserId: params.actorUserId,
    also: [toAddressed(customer, customer.id, 'customer')],
  });
  if (!audience.length) return;

  await emitToAll(em, {
    type: NotificationEventType.CUSTOMER_BANK_ACCOUNT_REGISTERED,
    loanId: null,
    audience,
    payload: {
      customerName: customer.fullName,
      customerNumber: customer.customerNumber,
      bankName: account.bankName,
      accountNumberMasked: maskAccountNumber(account.accountNumber),
      accountHolderName: account.accountHolderName,
      accountStatus: BANK_ACCOUNT_STATUS_LABEL[account.status],
      createdByName: params.createdByName,
      registeredDate: dateOnly(account.createdAt ?? new Date()),
    },
  });
}

/**
 * Proof that a disbursement reached the borrower was filed on the loan. The event tells the borrower and
 * the approving staff which of the two channels the money went through and which document now holds the
 * evidence, so a dispute about a missing loan starts from the same file for both sides.
 */
export async function notifyDisbursementEvidenceUploaded(
  em: EntityManager,
  params: { loanId: string; documentId: string; uploadedByName: string },
): Promise<void> {
  const [loan, document] = await Promise.all([
    em.findOne(Loan, { where: { id: params.loanId } }),
    em.findOne(EvidenceDocument, { where: { id: params.documentId } }),
  ]);
  if (!loan || !document) return;

  const [customer, account] = await Promise.all([
    em.findOne(Customer, { where: { id: loan.customerId } }),
    loan.disbursementBankAccountId
      ? em.findOne(CustomerBankAccount, { where: { id: loan.disbursementBankAccountId } })
      : Promise.resolve(null),
  ]);

  const audience = await collectionAudience(em, { loanId: loan.id });
  if (!audience.length) return;

  await emitToAll(em, {
    type: NotificationEventType.LOAN_DISBURSEMENT_EVIDENCE_UPLOADED,
    loanId: loan.id,
    audience,
    payload: {
      loanCode: loan.loanNumber,
      customerName: customer?.fullName ?? '',
      channel: loan.disbursementChannel ? CHANNEL_LABEL[loan.disbursementChannel] : NOT_RECORDED,
      accountNumberMasked: account ? maskAccountNumber(account.accountNumber) : NOT_RECORDED,
      fileName: document.fileName,
      uploadedByName: params.uploadedByName,
      uploadedDate: dateOnly(document.createdAt ?? new Date()),
    },
  });
}

