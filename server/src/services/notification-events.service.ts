import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { Loan } from '../entities/loan.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import {
  ComponentAmounts,
  ComponentType,
  NotificationEventType,
  NotificationRecipient,
  PeriodUnit,
} from '../entities/types';
import { formatAmount, num } from '../utils/money';
import { logger } from '../utils/logger';
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

  const allocation = params.allocation
    ? Object.values(ComponentType)
        .filter((component) => num(params.allocation?.[component]) > 0)
        .map((component) => `${COMPONENT_LABEL[component]} ${formatAmount(params.allocation?.[component], params.currency)}`)
        .join(', ')
    : '';

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
