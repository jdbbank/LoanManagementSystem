import { ColumnOptions } from 'typeorm';

/**
 * DECIMAL(18,2) column with string->number transformer so TS code always sees numbers.
 */
export function decimalColumn(options: ColumnOptions = {}): ColumnOptions {
  return {
    type: 'decimal',
    precision: 18,
    scale: 2,
    default: 0,
    transformer: {
      to: (v: unknown) => v,
      from: (v: unknown): number => (v === null || v === undefined ? 0 : Number(v)),
    },
    ...options,
  };
}

export enum UserRole {
  ADMIN = 'ADMIN',
  HEAD_APPROVER = 'HEAD_APPROVER',
  CHECKER = 'CHECKER',
  MAKER = 'MAKER',
  VIEWER = 'VIEWER',
}

export enum LoanStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  WRITTEN_OFF = 'WRITTEN_OFF',
}

export enum ComponentType {
  PENALTY = 'PENALTY',
  PAST_INTEREST = 'PAST_INTEREST',
  PAST_PRINCIPAL = 'PAST_PRINCIPAL',
}

export enum TransactionType {
  DISBURSEMENT = 'DISBURSEMENT',
  PAYMENT = 'PAYMENT',
  SETTLEMENT_PAYMENT = 'SETTLEMENT_PAYMENT',
  PAYMENT_REVERSAL = 'PAYMENT_REVERSAL',
  PENALTY = 'PENALTY',
  WAIVER = 'WAIVER',
  WRITE_OFF = 'WRITE_OFF',
  WRITE_OFF_REVERSAL = 'WRITE_OFF_REVERSAL',
  ADJUSTMENT = 'ADJUSTMENT',
}

export enum TransactionStatus {
  DRAFT = 'DRAFT',
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  POSTED = 'POSTED',
  REJECTED = 'REJECTED',
}

export enum PaymentRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum ApprovalLevel {
  CHECKER = 'CHECKER',
  HEAD = 'HEAD',
  ADMIN = 'ADMIN',
}

export enum ApprovalSubjectType {
  FINANCIAL_TRANSACTION = 'FINANCIAL_TRANSACTION',
  SETTLEMENT_AGREEMENT = 'SETTLEMENT_AGREEMENT',
}

export enum WorkflowStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum StepStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum SettlementStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum CreditLedgerType {
  ACCRUED = 'ACCRUED',
  USED = 'USED',
}

export enum ReconciliationStatus {
  MATCHED = 'MATCHED',
  MISMATCHED = 'MISMATCHED',
}

/** Customer identity verification state (KYC). Drives the disbursement gate. */
export enum KycStatus {
  NOT_VERIFIED = 'NOT_VERIFIED',
  PENDING = 'PENDING',
  VERIFIED = 'VERIFIED',
  REJECTED = 'REJECTED',
}

export enum KycDocumentType {
  NATIONAL_ID = 'NATIONAL_ID',
  ID_CARD = 'ID_CARD',
  PASSPORT = 'PASSPORT',
  FAMILY_BOOK = 'FAMILY_BOOK',
  SELFIE_WITH_ID = 'SELFIE_WITH_ID',
  SIGNATURE = 'SIGNATURE',
}

/** Which physical side/part of a multi-part document an image is. */
export enum KycDocumentVariant {
  MAIN = 'MAIN',
  FRONT = 'FRONT',
  BACK = 'BACK',
}

/**
 * The ONE KYC policy shape. Every module reads it through kyc-policy.service
 * (same central-configuration rule as the approval thresholds, locked section 12).
 */
export interface KycPolicy {
  maxFileSizeKb: number;
  maxFilesPerRequest: number;
  allowedMimeTypes: string[];
  allowedDocumentTypes: KycDocumentType[];
  requiredIdentityTypes: KycDocumentType[];
  requireSelfieWithId: boolean;
  requireSignature: boolean;
  requireFamilyBook: boolean;
  acceptExpiredDocuments: boolean;
  expiryWarningDays: number;
  maxTotalBytesPerCustomer: number;
  blockDisbursementUntilVerified: boolean;
  reverifyOnDocumentChange: boolean;
}

/**
 * Password composition rules, editable at runtime through system_config (`password.*`).
 * The same policy is applied to admin-set passwords and to self-service resets.
 */
export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireDigit: boolean;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireSymbol: boolean;
}

/** Size/shape limits for staff avatar images, editable at runtime (`avatar.*`). */
export interface AvatarPolicy {
  enabled: boolean;
  maxFileSizeKb: number;
  allowedMimeTypes: string[];
}

/**
 * The ONE penalty policy shape. Products define it, loans snapshot it at disbursement
 * (same snapshot rule as the interest rate), and the schedule service reads the snapshot.
 */
export interface PenaltyPolicy {
  mode: PenaltyMode;
  /** Percent per period of PenaltyMode.PERCENT_OF_OVERDUE. */
  ratePercent: number;
  /** Fixed amount per period of PenaltyMode.FIXED_PER_PERIOD. */
  amount: number;
  /** What one penalty period is: day / week / month / year. */
  period: PeriodUnit;
  /** Days after the due date before penalties start running. */
  graceDays: number;
  /** Hard ceiling as a percent of the loan principal. 0 = no ceiling. */
  maxPercentOfPrincipal: number;
}

/** Time unit a rate, a term or a penalty period is expressed in. */
export enum PeriodUnit {
  DAY = 'DAY',
  WEEK = 'WEEK',
  MONTH = 'MONTH',
  YEAR = 'YEAR',
}

export enum PenaltyMode {
  NONE = 'NONE',
  PERCENT_OF_OVERDUE = 'PERCENT_OF_OVERDUE',
  FIXED_PER_PERIOD = 'FIXED_PER_PERIOD',
}

/** Derived at read time from the posted ledger — never stored, so it can never go stale. */
export enum SchedulePeriodStatus {
  PENDING = 'PENDING',
  DUE = 'DUE',
  OVERDUE = 'OVERDUE',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
}

/** No penalty: the shape every product starts with until the admin switches one on. */
export const DEFAULT_PENALTY_POLICY: PenaltyPolicy = {
  mode: PenaltyMode.NONE,
  ratePercent: 0,
  amount: 0,
  period: PeriodUnit.MONTH,
  graceDays: 0,
  maxPercentOfPrincipal: 0,
};

export interface ComponentAmounts {
  PENALTY: number;
  PAST_INTEREST: number;
  PAST_PRINCIPAL: number;
}

export type ComponentMap = Record<ComponentType, number>;

/**
 * The ONE notification event shape. The backend owns template + style and renders
 * the final subject/body here; the mailer service only transports what it receives.
 */
export enum NotificationEventType {
  LOAN_APPLICATION_SUBMITTED = 'LOAN_APPLICATION_SUBMITTED',
  LOAN_APPROVED = 'LOAN_APPROVED',
  LOAN_REJECTED = 'LOAN_REJECTED',
  PAYMENT_POSTED = 'PAYMENT_POSTED',
  SETTLEMENT_REQUESTED = 'SETTLEMENT_REQUESTED',
  SETTLEMENT_DECIDED = 'SETTLEMENT_DECIDED',
  USER_CREATED = 'USER_CREATED',
  PASSWORD_RESET_OTP = 'PASSWORD_RESET_OTP',
  PASSWORD_RESET_LINK = 'PASSWORD_RESET_LINK',
}

/** Outbox state machine: PENDING -> (SENT | FAILED retried | DEAD after max attempts). */
export enum NotificationStatus {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  DEAD = 'DEAD',
}

/**
 * What a stored password-reset secret unlocks: a short-lived OTP check, or the
 * single-use link that actually allows a new password.
 */
export enum ResetTokenKind {
  OTP = 'OTP',
  LINK = 'LINK',
}

export interface NotificationRecipient {
  email: string;
  fullName: string;
}

/** Fixed JSON contract published to Kafka / POSTed to the mailer service. */
export interface NotificationEvent {
  eventId: string;
  type: NotificationEventType;
  templateCode: NotificationEventType;
  occurredAt: string;
  locale: string;
  to: NotificationRecipient;
  subject: string;
  html: string;
  text: string;
  payload: Record<string, string | number | null>;
}
