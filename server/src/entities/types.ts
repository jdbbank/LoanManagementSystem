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
  /** One repayment period of declining-balance interest, charged after disbursement. */
  INTEREST_ACCRUAL = 'INTEREST_ACCRUAL',
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

/**
 * What the incoming money is for. PAY_DEBT settles periods that have already arrived and is
 * refused above that ceiling; DEPOSIT_TO_CREDIT books cash against no debt at all, so an early
 * payment becomes credit the auto-debit job can settle the period with later.
 */
export enum PaymentRequestPurpose {
  PAY_DEBT = 'PAY_DEBT',
  DEPOSIT_TO_CREDIT = 'DEPOSIT_TO_CREDIT',
}

export enum ApprovalLevel {
  CHECKER = 'CHECKER',
  HEAD = 'HEAD',
  ADMIN = 'ADMIN',
}

export enum ApprovalSubjectType {
  FINANCIAL_TRANSACTION = 'FINANCIAL_TRANSACTION',
  SETTLEMENT_AGREEMENT = 'SETTLEMENT_AGREEMENT',
  RESTRUCTURE_REQUEST = 'RESTRUCTURE_REQUEST',
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

/**
 * A person standing behind a loan besides the borrower. Both are ordinary `customers` rows, so a
 * guarantor and a replacement payer go through the same KYC upload and review machinery as a borrower.
 */
export enum LoanPartyRole {
  GUARANTOR = 'GUARANTOR',
  PAYER = 'PAYER',
}
export enum LoanPartyStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
}

/** What is pledged as security. Values are deliberately generic; description carries the detail. */
export enum CollateralType {
  LAND = 'LAND',
  BUILDING = 'BUILDING',
  VEHICLE = 'VEHICLE',
  DEPOSIT = 'DEPOSIT',
  EQUIPMENT = 'EQUIPMENT',
  GOLD = 'GOLD',
  OTHER = 'OTHER',
}

export enum CollateralStatus {
  PLEDGED = 'PLEDGED',
  RELEASED = 'RELEASED',
}

/**
 * Where money between the branch and the customer actually travels. CASH needs no account and no
 * slip of its own; BANK points at one `customer_bank_accounts` row so the number on the transfer is
 * the number the customer registered, not one somebody typed into a note.
 */
export enum DisbursementChannel {
  BANK = 'BANK',
  CASH = 'CASH',
}

export enum BankAccountStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

/** What an uploaded piece of evidence belongs to. `ownerId` is a customer id or a loan id. */
export enum EvidenceOwnerType {
  CUSTOMER = 'CUSTOMER',
  LOAN = 'LOAN',
}

/**
 * The two financial proofs this system keeps: the document that shows a bank account really is the
 * customer's, and the transfer slip or cash receipt that shows the loan money actually arrived.
 * Identity paperwork is NOT here — it stays in the KYC pipeline.
 */
export enum EvidenceKind {
  BANK_ACCOUNT_PROOF = 'BANK_ACCOUNT_PROOF',
  DISBURSEMENT_SLIP = 'DISBURSEMENT_SLIP',
}

/** What a hardship addendum asks to change. One request may carry several concessions at once. */
export enum RestructureChangeType {
  /** Lower the interest rate on the remaining debt. */
  INTEREST_RATE_REDUCTION = 'INTEREST_RATE_REDUCTION',
  /** Spread the remaining debt over more periods. */
  TERM_EXTENSION = 'TERM_EXTENSION',
  /** Hand the repayment duty to a different, KYC-verified person. */
  PAYER_CHANGE = 'PAYER_CHANGE',
  /** Cancel part of the interest that has already accrued, booked in the ledger as a WAIVER. */
  INTEREST_RELIEF = 'INTEREST_RELIEF',
}

/**
 * A restructure request is a business document, NOT a financial transaction (same rule as
 * settlement agreements, locked section 16): it changes nothing by itself. APPROVED means the
 * authority has signed it; APPLIED means the terms were rewritten and the relief was posted.
 */
export enum RestructureStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  APPLIED = 'APPLIED',
}

/**
 * The contract terms as they stood when an addendum was written. Stored so the approval is about a
 * real before/after difference and so the audit trail survives the change itself.
 */
export interface LoanTermSnapshot {
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  interestMethod: InterestMethod;
  termMonths: number;
  /** Who was paying the loan then; null when the borrower still was. */
  payerCustomerId: string | null;
}

/** Collateral position measured at the moment the addendum was submitted — evidence, not live state. */
export interface CollateralCoverageSnapshot {
  pledgedCount: number;
  appraisedTotal: number;
  outstanding: number;
  coveragePercent: number;
  requiredCoveragePercent: number;
  oldestValuedAt: string | null;
  valuationMaxAgeDays: number;
  passed: boolean;
  /** Human-readable reasons the check failed, kept for the approver and the audit log. */
  reasons: string[];
  /** What was set aside without failing the check, such as an appraisal that is simply too old to count. */
  warnings: string[];
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
 * The ONE repayment-collection policy. `payment.*` rows in system_config override the env
 * defaults at runtime (same central-configuration rule as the KYC policy, locked section 12).
 */
export interface PaymentPolicy {
  /** Auto-debit settles a period this many days before its due date, from the customer's credit. */
  autoDebitLeadDays: number;
  /** The job stays off until an ADMIN turns it on: money must not move by itself before then. */
  autoDebitEnabled: boolean;
}

/**
 * The ONE collateral policy shape. `collateral.*` rows in system_config override the env defaults at
 * runtime (same central-configuration rule as the KYC and payment policies), and both the pledge
 * endpoints and the restructure check read it through collateral-policy.service.
 */
export interface CollateralPolicy {
  /** Pledged appraised value must be at least this percent of what is still owed. 0 = no floor. */
  minCoveragePercent: number;
  /** An appraisal older than this many days no longer counts as coverage. 0 = appraisals never expire. */
  maxValuationAgeDays: number;
  /** When on, an addendum cannot be submitted at all without at least one in-date pledged item. */
  requirePledgeForRestructure: boolean;
}

/**
 * The ONE evidence-upload policy. `evidence.*` rows in system_config override the env defaults at
 * runtime (same central-configuration rule as the KYC, collateral and payment policies). It is a
 * separate shape from KycPolicy on purpose: a financial proof must never be pulled into the KYC
 * checklist, whose re-verify rule would otherwise send the customer back to PENDING and stop a
 * disbursement every time a bank slip was uploaded.
 */
export interface EvidencePolicy {
  maxFileSizeKb: number;
  maxFilesPerRequest: number;
  allowedMimeTypes: string[];
  maxTotalBytesPerOwner: number;
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

/**
 * The ONE account-security policy. `security.*` rows in system_config override the env defaults at
 * runtime (same central-configuration rule as the password and payment policies), and login, the
 * idle-lock sweep and every password write read it through account-security-policy.service.
 *
 * Every number here treats 0 as a real setting meaning "this rule is off", never as "no value
 * stored" — the same semantics ADMINs rely on for `kyc.expiryWarningDays` (F-CFG-1).
 */
export interface AccountSecurityPolicy {
  /** Consecutive wrong passwords before the account locks. 0 = never lock on failures. */
  maxFailedAttempts: number;
  /** Days without a successful login before the account locks. 0 = accounts never expire. */
  idleLockDays: number;
  /** The sweep job stays off until an ADMIN turns it on, exactly like the auto-debit switch. */
  idleLockJobEnabled: boolean;
  /** How often the sweep looks for accounts past the idle window. */
  idleLockPollHours: number;
  /** Days a password stays valid before its owner must set a new one. 0 = no rotation. */
  passwordMaxAgeDays: number;
  /** Warn this many days before the password expires. 0 = warn only once it is due. */
  passwordExpiryWarnDays: number;
  /** How many previous passwords a new one must not match. 0 = only the current one. */
  passwordHistoryCount: number;
  /** When off, ADMIN accounts skip the idle lock and the rotation gate; the failure lock always applies. */
  applyToAdminAccounts: boolean;
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

/**
 * How a product prices interest, chosen by the product owner and snapshotted onto every loan
 * at disbursement exactly like the rate and the penalty policy.
 *
 * - FLAT: the whole-term interest is billed once in the disbursement transaction.
 * - DECLINING: equal principal per period, and each period bills interest on the principal
 *   still owed when that period starts (never on the original amount), one transaction per period.
 */
export enum InterestMethod {
  FLAT = 'FLAT',
  DECLINING = 'DECLINING',
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
  PARTY_REGISTERED = 'PARTY_REGISTERED',
  PARTY_RELEASED = 'PARTY_RELEASED',
  RESTRUCTURE_REQUESTED = 'RESTRUCTURE_REQUESTED',
  RESTRUCTURE_DECIDED = 'RESTRUCTURE_DECIDED',
  RESTRUCTURE_APPLIED = 'RESTRUCTURE_APPLIED',
  USER_CREATED = 'USER_CREATED',
  PASSWORD_RESET_OTP = 'PASSWORD_RESET_OTP',
  PASSWORD_RESET_LINK = 'PASSWORD_RESET_LINK',
  PAYMENT_REQUEST_SUBMITTED = 'PAYMENT_REQUEST_SUBMITTED',
  PAYMENT_REQUEST_APPROVED = 'PAYMENT_REQUEST_APPROVED',
  PAYMENT_REQUEST_REJECTED = 'PAYMENT_REQUEST_REJECTED',
  CREDIT_DEPOSITED = 'CREDIT_DEPOSITED',
  AUTO_DEBIT_POSTED = 'AUTO_DEBIT_POSTED',
  PENALTY_POSTED = 'PENALTY_POSTED',
  WAIVER_POSTED = 'WAIVER_POSTED',
  WRITE_OFF_POSTED = 'WRITE_OFF_POSTED',
  CUSTOMER_REGISTERED = 'CUSTOMER_REGISTERED',
  LOAN_PRODUCT_CREATED = 'LOAN_PRODUCT_CREATED',
  CUSTOMER_BANK_ACCOUNT_REGISTERED = 'CUSTOMER_BANK_ACCOUNT_REGISTERED',
  LOAN_DISBURSEMENT_EVIDENCE_UPLOADED = 'LOAN_DISBURSEMENT_EVIDENCE_UPLOADED',
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

/**
 * Which account-security rule locked the account. Set only while `users.lockedAt` is set, and only
 * ADMIN can clear the lock — the reason is what the operator needs before picking up the phone,
 * because a person locked out by guessing wrong is handled differently from one whose account simply
 * went quiet. A user is never in two states at once: the rule that fires first writes the row.
 */
export enum AccountLockReason {
  FAILED_ATTEMPTS = 'FAILED_ATTEMPTS',
  IDLE = 'IDLE',
}

/**
 * Which door a request counter belongs to. Keyed per endpoint group rather than per endpoint so a
 * flood cannot be spent through one ceiling and then repeated through another; the reset endpoints
 * share one ceiling because they are one workflow that a legitimate user walks through in seconds.
 *
 * Stored in a varchar column, not an enum column: adding a guarded endpoint is supposed to be a code
 * change, not a `MODIFY COLUMN` migration of a table that every request writes to.
 */
export enum RateLimitScope {
  LOGIN_IP = 'LOGIN_IP',
  LOGIN_USERNAME = 'LOGIN_USERNAME',
  RESET_IP = 'RESET_IP',
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
