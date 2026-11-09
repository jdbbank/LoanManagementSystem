/** Mirrors server/src/entities/types.ts — the single source of truth for enums. */
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

export enum TransactionType {
  DISBURSEMENT = 'DISBURSEMENT',
  PAYMENT = 'PAYMENT',
  SETTLEMENT_PAYMENT = 'SETTLEMENT_PAYMENT',
  PAYMENT_REVERSAL = 'PAYMENT_REVERSAL',
  PENALTY = 'PENALTY',
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

export enum PaymentRequestPurpose {
  PAY_DEBT = 'PAY_DEBT',
  DEPOSIT_TO_CREDIT = 'DEPOSIT_TO_CREDIT',
}

export enum ApprovalLevel {
  CHECKER = 'CHECKER',
  HEAD = 'HEAD',
  ADMIN = 'ADMIN',
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

export enum KycDocumentVariant {
  MAIN = 'MAIN',
  FRONT = 'FRONT',
  BACK = 'BACK',
}

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

export interface KycChecklist {
  satisfied: boolean;
  missing: (KycDocumentType | 'IDENTITY_DOCUMENT')[];
  expired: KycDocumentType[];
  expiringSoon: KycDocumentType[];
}

export interface KycDocument {
  id: string;
  customerId: string;
  documentType: KycDocumentType;
  variant: KycDocumentVariant;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  issuedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  uploadedBy: string;
  createdAt: string;
}

export interface KycCustomerState {
  id: string;
  customerNumber: string;
  fullName: string;
  nationalId: string | null;
  kycStatus: KycStatus;
  kycSubmittedBy: string | null;
  kycSubmittedAt: string | null;
  kycReviewedBy: string | null;
  kycReviewedAt: string | null;
  kycRejectionReason: string | null;
  kycAppliedPolicy: KycPolicy | null;
}

export interface KycState {
  customer: KycCustomerState;
  documents: KycDocument[];
  policy: KycPolicy;
  checklist: KycChecklist;
}

export interface KycConfig {
  policy: KycPolicy;
  defaults: KycPolicy;
  checksum: string;
}

export interface PasswordPolicy {
  minLength: number;
  maxLength: number;
  requireDigit: boolean;
  requireUppercase: boolean;
  requireLowercase: boolean;
  requireSymbol: boolean;
}

export interface PasswordConfig {
  policy: PasswordPolicy;
  defaults: PasswordPolicy;
  checksum: string;
}

/** Mirrors the server AccountSecurityPolicy; 0 on a number here switches that rule off. */
export interface AccountSecurityPolicy {
  maxFailedAttempts: number;
  idleLockDays: number;
  idleLockJobEnabled: boolean;
  idleLockPollHours: number;
  passwordMaxAgeDays: number;
  passwordExpiryWarnDays: number;
  passwordHistoryCount: number;
  applyToAdminAccounts: boolean;
}

export interface AccountSecurityConfig {
  policy: AccountSecurityPolicy;
  defaults: AccountSecurityPolicy;
  checksum: string;
}

export interface AvatarPolicy {
  enabled: boolean;
  maxFileSizeKb: number;
  allowedMimeTypes: string[];
}

export interface AvatarConfig {
  policy: AvatarPolicy;
  defaults: AvatarPolicy;
}

export interface PaymentPolicy {
  autoDebitLeadDays: number;
  autoDebitEnabled: boolean;
}

export interface PaymentConfig {
  policy: PaymentPolicy;
  defaults: PaymentPolicy;
  checksum: string;
}

/** One loan's outcome of an auto-debit pass — a planned debit, a skip with its reason, or a failure. */
export interface AutoDebitOutcome {
  loanNumber?: string;
  referenceNo?: string;
  periodIndex?: number;
  amount?: number;
  dueDate?: string;
  requestNo?: string;
  transactionId?: string;
  reason?: string;
}

export interface AutoDebitRun {
  asOf: string;
  enabled: boolean;
  leadDays: number;
  dryRun: boolean;
  scanned: number;
  planned: AutoDebitOutcome[];
  debited: AutoDebitOutcome[];
  skipped: AutoDebitOutcome[];
  failed: AutoDebitOutcome[];
}

/** A staff account as the admin list sees it. */
export interface ManagedUser {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  isEmailVerified: boolean;
  role: UserRole;
  isActive: boolean;
  hasAvatar: boolean;
  lastLoginAt: string | null;
  isLocked: boolean;
  lockedAt: string | null;
  lockReason: AccountLockReason | null;
  passwordChangedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
}

/**
 * The monthly rotation clock for one account, as `GET /users/me` and the login refusal report it.
 * `applies: false` means the rule is switched off for this account and nothing here is meaningful.
 */
export interface PasswordExpiryInfo {
  applies: boolean;
  expiresAt: string | null;
  daysLeft: number | null;
  expired: boolean;
  warn: boolean;
}

export interface SelfProfileResponse {
  user: ManagedUser;
  passwordExpiry: PasswordExpiryInfo;
}

/** Which account-security rule locked the account; mirrors the server enum. */
export type AccountLockReason = 'FAILED_ATTEMPTS' | 'IDLE';

export interface UnlockResult {
  unlocked: boolean;
  unlockedAt: string;
  username: string;
  previousLockReason: AccountLockReason | null;
  /** The emailed reset link is best effort — an account with no address stays unlocked anyway. */
  resetLink: { sent: boolean; reason?: string; expiresAt?: string };
}

export interface ComponentAmounts {
  PENALTY: number;
  PAST_INTEREST: number;
  PAST_PRINCIPAL: number;
}

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

export interface Customer {
  id: string;
  customerNumber: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  nationalId: string | null;
  address: string | null;
  kycStatus: KycStatus;
  createdAt: string;
}

/** One product this customer borrowed under — activeCount > 0 means they owe on it right now. */
export interface CustomerBorrowing {
  productId: string;
  productCode: string;
  productName: string;
  loanCount: number;
  activeCount: number;
  outstanding: number;
  lastDisbursedAt: string | null;
}

export interface CustomerRow extends Customer {
  loanCount: number;
  activeLoanCount: number;
  borrowings: CustomerBorrowing[];
  creditBalance: number;
  kycDocumentCount: number;
}

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

/** How a product prices interest: one lump for the whole term, or one charge per period. */
export enum InterestMethod {
  FLAT = 'FLAT',
  DECLINING = 'DECLINING',
}

export const INTEREST_METHODS: InterestMethod[] = [InterestMethod.FLAT, InterestMethod.DECLINING];

export enum SchedulePeriodStatus {
  PENDING = 'PENDING',
  DUE = 'DUE',
  OVERDUE = 'OVERDUE',
  PARTIAL = 'PARTIAL',
  PAID = 'PAID',
}

export interface PenaltyPolicy {
  mode: PenaltyMode;
  ratePercent: number;
  amount: number;
  period: PeriodUnit;
  graceDays: number;
  maxPercentOfPrincipal: number;
}

export const PERIOD_UNITS: PeriodUnit[] = [
  PeriodUnit.DAY,
  PeriodUnit.WEEK,
  PeriodUnit.MONTH,
  PeriodUnit.YEAR,
];

export const PENALTY_MODES: PenaltyMode[] = [
  PenaltyMode.NONE,
  PenaltyMode.PERCENT_OF_OVERDUE,
  PenaltyMode.FIXED_PER_PERIOD,
];

export const DEFAULT_PENALTY_POLICY: PenaltyPolicy = {
  mode: PenaltyMode.NONE,
  ratePercent: 0,
  amount: 0,
  period: PeriodUnit.MONTH,
  graceDays: 0,
  maxPercentOfPrincipal: 0,
};

export interface LoanProduct {
  id: string;
  code: string;
  name: string;
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  interestMethod: InterestMethod;
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  penaltyPolicy: PenaltyPolicy | null;
  earlySettlementFeePercent: number;
  currency: string;
  description: string | null;
  isActive: boolean;
}

export interface OutstandingPreview {
  penalty: number;
  pastInterest: number;
  pastPrincipal: number;
  total: number;
}

export interface Loan {
  id: string;
  loanNumber: string;
  customerId: string;
  productId: string;
  status: LoanStatus;
  principalAmount: number;
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  interestMethod: InterestMethod;
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  penaltyPolicy: PenaltyPolicy | null;
  earlySettlementFeePercent: number;
  currency: string;
  outstandingPenalty: number;
  outstandingPastInterest: number;
  outstandingPastPrincipal: number;
  currentOutstanding: number;
  disbursementChannel?: DisbursementChannel | null;
  disbursementBankAccountId?: string | null;
  disbursementReference?: string | null;
  disbursedAt: string | null;
  createdAt: string;
  customer?: Customer | null;
  product?: LoanProduct | null;
  outstanding?: OutstandingPreview;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
}

export interface LoanDetail {
  loan: Loan;
  disbursement: LoanDisbursement;
  transactions: FinancialTransaction[];
  transactionPagination: Pagination;
  credit: CustomerCredit | null;
  settlements: SettlementAgreement[];
}

export interface LoanListAggregates {
  principalCharged: number;
  outstandingPrincipal: number;
  outstandingInterest: number;
  outstandingPenalty: number;
  outstandingTotal: number;
  closedCount: number;
}

export interface SchedulePeriod {
  index: number;
  periodStart: string;
  dueDate: string;
  principalDue: number;
  interestDue: number;
  principalPaid: number;
  interestPaid: number;
  principalRelieved: number;
  interestRelieved: number;
  penaltyAccrued: number;
  penaltyBilled: number;
  due: number;
  paid: number;
  relieved: number;
  outstanding: number;
  overdueDays: number;
  status: SchedulePeriodStatus;
}

export interface LoanScheduleTotals {
  principalCharged: number;
  interestCharged: number;
  /** On a DECLINING loan: the next period's interest that has started and is not billed yet. */
  interestSuggested: number;
  penaltyCharged: number;
  penaltyRelieved: number;
  penaltyAccrued: number;
  penaltySuggested: number;
  paid: ComponentAmounts;
  relieved: ComponentAmounts;
  outstanding: ComponentAmounts;
  totalCharged: number;
  totalOutstanding: number;
  creditBalance: number;
}

export interface LoanScheduleAging {
  overduePeriods: number;
  unpaidPeriods: number;
  maxOverdueDays: number;
  nextDueDate: string | null;
  maturityDate: string;
}

export interface LoanSchedule {
  loanId: string;
  loanNumber: string;
  customerId: string;
  currency: string;
  asOf: string;
  disbursedAt: string;
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  interestMethod: InterestMethod;
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  periodCount: number;
  penaltyPolicy: PenaltyPolicy;
  totals: LoanScheduleTotals;
  aging: LoanScheduleAging;
  periods: SchedulePeriod[];
}

/** One instalment the customer may settle today. */
export interface PayablePeriod {
  index: number;
  dueDate: string;
  outstanding: number;
  penaltyBilled: number;
  collectable: number;
  status: SchedulePeriodStatus;
}

/** GET /loans/:id/payable-now — the collection ceiling the payment gate enforces. */
export interface PayableNow {
  loanId: string;
  loanNumber: string;
  asOf: string;
  maxPayable: number;
  dueToPay: number;
  ledgerOutstanding: number;
  duePeriods: PayablePeriod[];
  nextPendingPeriod: { index: number; dueDate: string; amount: number } | null;
  creditBalance: number;
}

export interface AllocationPreview {
  amount: number;
  outstanding: ComponentAmounts;
  allocation: ComponentAmounts;
  excess: number;
}

export interface FinancialTransaction {
  id: string;
  referenceNo: string;
  transactionType: TransactionType;
  status: TransactionStatus;
  loanId: string | null;
  customerId: string | null;
  amount: number;
  currency: string;
  referenceTransactionId: string | null;
  sourceRequestId: string | null;
  settlementAgreementId: string | null;
  componentAmounts: ComponentAmounts | null;
  /** Declining-balance interest is idempotent per loan + period; a FLAT lump has no period. */
  periodIndex: number | null;
  reason: string | null;
  rejectionReason: string | null;
  createdBy: string;
  postedBy: string | null;
  approvedAt: string | null;
  postedAt: string | null;
  createdAt: string;
  loan?: Loan | null;
  customer?: Customer | null;
}

export interface PaymentRequest {
  id: string;
  requestNo: string;
  loanId: string;
  customerId: string;
  cashAmount: number;
  creditApplied: number;
  currency: string;
  status: PaymentRequestStatus;
  purpose: PaymentRequestPurpose;
  previousRequestId: string | null;
  settlementAgreementId: string | null;
  note: string | null;
  rejectionReason: string | null;
  createdBy: string;
  approvedBy: string | null;
  rejectedBy: string | null;
  approvedAt: string | null;
  rejectedAt: string | null;
  createdAt: string;
}

export interface PaymentAllocation {
  id: string;
  paymentRequestId: string;
  component: keyof ComponentAmounts;
  proposedAmount: number;
  finalAmount: number;
}

export interface PaymentRequestDetail {
  request: PaymentRequest;
  allocations: PaymentAllocation[];
  transaction: FinancialTransaction | null;
  previousRequest: PaymentRequest | null;
}

export interface ApprovalWorkflow {
  id: string;
  subjectType: 'FINANCIAL_TRANSACTION' | 'SETTLEMENT_AGREEMENT';
  subjectId: string;
  requiredLevels: ApprovalLevel[];
  currentLevelIndex: number;
  status: WorkflowStatus;
  completedAt: string | null;
  createdAt: string;
}

export interface ApprovalStep {
  id: string;
  workflowId: string;
  level: ApprovalLevel;
  status: StepStatus;
  userId: string | null;
  reason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface FinancialTransactionLine {
  id: string;
  transactionId: string;
  component: keyof ComponentAmounts;
  amount: number;
}

export interface TransactionDetail {
  transaction: FinancialTransaction;
  lines: FinancialTransactionLine[];
  workflow: ApprovalWorkflow | null;
  steps: ApprovalStep[];
  settlement: SettlementAgreement | null;
}

export interface SettlementAgreement {
  id: string;
  agreementNo: string;
  loanId: string;
  customerId: string;
  agreedAmount: number;
  earlySettlementFee: number;
  currency: string;
  status: SettlementStatus;
  reason: string | null;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
}

/** GET /settlements/early-settlement-fee/:loanId — what ending the loan today would cost. */
export interface EarlySettlementFeePreview {
  loanId: string;
  loanNumber: string;
  status: LoanStatus;
  feePercent: number;
  principalOutstanding: number;
  settledBeforeTermEnd: boolean;
  fee: number;
  outstanding: number;
  totalDue: number;
  nextPendingPeriod: { index: number; dueDate: string; amount: number } | null;
}

export interface CustomerCredit {
  id: string;
  customerId: string;
  currency: string;
  balance: number;
  updatedAt: string;
  customer?: Customer | null;
}

export interface CreditLedgerEntry {
  id: string;
  customerId: string;
  type: CreditLedgerType;
  amount: number;
  balanceAfter: number;
  transactionId: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  transactionId: string | null;
  transactionType: string | null;
  loanId: string | null;
  customerId: string | null;
  userId: string | null;
  action: string;
  previousStatus: string | null;
  newStatus: string | null;
  previousBalance: (ComponentAmounts & { total: number }) | null;
  newBalance: (ComponentAmounts & { total: number }) | null;
  amount: number | null;
  currency: string | null;
  reason: string | null;
  createdAt: string;
  actor?: { username: string; fullName: string } | null;
}

export interface ApprovalPendingItem {
  workflowId: string;
  stepId: string;
  subjectType: 'FINANCIAL_TRANSACTION' | 'SETTLEMENT_AGREEMENT' | 'RESTRUCTURE_REQUEST';
  subjectId: string;
  currentLevel: ApprovalLevel;
  remainingLevels: ApprovalLevel[];
  canDecide: boolean;
  blockedForUser: boolean;
  amount: number;
  subject:
    | { kind: 'TRANSACTION'; transaction: FinancialTransaction }
    | { kind: 'SETTLEMENT_AGREEMENT'; agreement: SettlementAgreement }
    | { kind: 'RESTRUCTURE_REQUEST'; request: RestructureRequest }
    | null;
}

export interface DashboardStats {
  customers: number;
  loans: number;
  loansByStatus: Partial<Record<LoanStatus, number>>;
  pendingPaymentRequests: number;
  pendingApprovals: number;
  postedTransactions: number;
  totalOutstanding: number;
  activeOutstanding: number;
  totalCustomerCredit: number;
}

export interface ReportGrowth {
  absolute: number;
  percent: number | null;
}

export interface ReportComparisons {
  collected: ReportGrowth;
  disbursed: ReportGrowth;
  outstanding: ReportGrowth;
}

export interface MonthlyReportRow {
  month: string;
  disbursed: number;
  moneyIn: number;
  reversed: number;
  writtenOff: number;
  waived: number;
  penaltyCharged: number;
  principalPaid: number;
  interestPaid: number;
  penaltyPaid: number;
  interestAccrued: number;
  penaltyAdded: number;
  outstandingDelta: number;
  closingOutstanding: number;
  loansOpened: number;
  transactions: number;
  collected: number;
  mom: ReportComparisons;
  yoy: ReportComparisons;
}

export interface MonthlyReport {
  currency: string;
  from: string;
  to: string;
  months: number;
  customerId: string | null;
  openingOutstanding: number;
  closingOutstanding: number;
  loanBookOutstanding: number;
  rows: MonthlyReportRow[];
  totals: {
    disbursed: number;
    moneyIn: number;
    reversed: number;
    collected: number;
    interestPaid: number;
    penaltyPaid: number;
    writtenOff: number;
    loansOpened: number;
  };
}

/** One declining-balance period that has started and was never billed. */
export interface DueInterestItem {
  loanId: string;
  loanNumber: string;
  customerId: string;
  customerName: string | null;
  periodIndex: number;
  periodStart: string;
  dueDate: string;
  baseOutstandingPrincipal: number;
  amount: number;
  termPeriods: number;
  missingPeriods: number;
}

export interface InterestAccrualSkip {
  loanId: string;
  loanNumber?: string;
  reason: string;
}

export interface DueInterestList {
  asOf: string;
  totals: { loans: number; periods: number; amount: number };
  items: DueInterestItem[];
  skipped: InterestAccrualSkip[];
}

export interface InterestAccrualResult {
  asOf: string;
  dryRun: boolean;
  created: Array<{
    transactionId: string;
    referenceNo: string;
    loanId: string;
    loanNumber: string;
    periodIndex: number | null;
    amount: number;
  }>;
  wouldCreate: Array<{
    loanId: string;
    loanNumber: string;
    periodIndex: number;
    amount: number;
    baseOutstandingPrincipal: number;
    missingPeriods: number;
  }>;
  totals: { loans: number; amount: number };
  skipped: InterestAccrualSkip[];
}

export interface BulkDecisionResult {
  requested: number;
  decided: number;
  declined: number;
  results: Array<{ stepId: string; ok: boolean; workflowId?: string; subjectId?: string; error?: string }>;
}

export enum LoanPartyRole {
  GUARANTOR = 'GUARANTOR',
  PAYER = 'PAYER',
}

export enum LoanPartyStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
}

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

export const COLLATERAL_TYPES: CollateralType[] = [
  CollateralType.LAND,
  CollateralType.BUILDING,
  CollateralType.VEHICLE,
  CollateralType.DEPOSIT,
  CollateralType.EQUIPMENT,
  CollateralType.GOLD,
  CollateralType.OTHER,
];

export enum RestructureChangeType {
  INTEREST_RATE_REDUCTION = 'INTEREST_RATE_REDUCTION',
  TERM_EXTENSION = 'TERM_EXTENSION',
  PAYER_CHANGE = 'PAYER_CHANGE',
  INTEREST_RELIEF = 'INTEREST_RELIEF',
}

export enum RestructureStatus {
  PENDING_APPROVAL = 'PENDING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  APPLIED = 'APPLIED',
}

export const RESTRUCTURE_CHANGE_TYPES: RestructureChangeType[] = [
  RestructureChangeType.INTEREST_RATE_REDUCTION,
  RestructureChangeType.TERM_EXTENSION,
  RestructureChangeType.PAYER_CHANGE,
  RestructureChangeType.INTEREST_RELIEF,
];

export const RESTRUCTURE_STATUSES: RestructureStatus[] = [
  RestructureStatus.PENDING_APPROVAL,
  RestructureStatus.APPROVED,
  RestructureStatus.REJECTED,
  RestructureStatus.APPLIED,
];

/** The contract terms an addendum was written against, and the terms it asks for. */
export interface LoanTermSnapshot {
  interestRate: number;
  interestRatePeriod: PeriodUnit;
  interestMethod: InterestMethod;
  termMonths: number;
  payerCustomerId: string | null;
}

export interface LoanParty {
  id: string;
  loanId: string;
  customerId: string;
  role: LoanPartyRole;
  status: LoanPartyStatus;
  engagedAt: string;
  relationship: string | null;
  note: string | null;
  createdBy: string;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What staff still have to do before this person may act in the role, judged on their engagement date. */
export interface PartyKycState {
  status: KycStatus;
  reviewedAt: string | null;
  requiredFrom: string;
  effective: boolean;
  nextAction: 'NONE' | 'UPLOAD_DOCUMENTS' | 'SUBMIT' | 'AWAIT_REVIEW' | 'REOPEN_AND_RESUBMIT';
  hint: string;
}

export interface LoanPartyView {
  party: LoanParty;
  customer: {
    id: string;
    customerNumber: string;
    fullName: string;
    nationalId: string | null;
    phone: string | null;
    email: string | null;
  } | null;
  kyc: PartyKycState | null;
}

export interface LoanPartiesView {
  loan: {
    id: string;
    loanNumber: string;
    status: LoanStatus;
    customerId: string;
    customerName: string;
    currency: string;
  };
  parties: LoanPartyView[];
}

export interface LoanCollateral {
  id: string;
  loanId: string;
  ownerCustomerId: string | null;
  type: CollateralType;
  status: CollateralStatus;
  description: string;
  certificateNo: string | null;
  appraisedValue: number;
  valuedAt: string;
  note: string | null;
  createdBy: string;
  releasedAt: string | null;
  releaseReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CollateralCoverageSnapshot {
  pledgedCount: number;
  appraisedTotal: number;
  outstanding: number;
  coveragePercent: number;
  requiredCoveragePercent: number;
  oldestValuedAt: string | null;
  valuationMaxAgeDays: number;
  passed: boolean;
  reasons: string[];
  warnings: string[];
}

export interface CollateralPolicy {
  minCoveragePercent: number;
  maxValuationAgeDays: number;
  requirePledgeForRestructure: boolean;
}

export interface CollateralView {
  loan: {
    id: string;
    loanNumber: string;
    status: LoanStatus;
    customerId: string;
    currency: string;
    outstanding: number;
  };
  collaterals: LoanCollateral[];
  policy: CollateralPolicy;
  coverage: CollateralCoverageSnapshot;
}

/** GET /config/collateral — the live rules plus the env defaults, so an override is never mistaken for one. */
export interface CollateralConfig {
  policy: CollateralPolicy;
  defaults: CollateralPolicy;
  checksum: string;
}

export interface RestructureRequest {
  id: string;
  requestNo: string;
  loanId: string;
  customerId: string;
  status: RestructureStatus;
  hardshipReason: string;
  changeTypes: RestructureChangeType[];
  newInterestRate: number | null;
  newTermMonths: number | null;
  newPayerCustomerId: string | null;
  interestReliefAmount: number;
  repricingAmount: number;
  currency: string;
  beforeTerms: LoanTermSnapshot;
  afterTerms: LoanTermSnapshot;
  collateralSnapshot: CollateralCoverageSnapshot | null;
  waiverTransactionId: string | null;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  appliedBy: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposedPayer {
  customerId: string;
  fullName: string;
  engagedAt: string;
  relationship: string | null;
  kyc: PartyKycState;
}

/** What the loan looks like to a hardship decision right now: GET /restructures/context/:loanId. */
export interface RestructureContext {
  loan: {
    id: string;
    loanNumber: string;
    customerId: string;
    status: LoanStatus;
    currency: string;
    disbursedAt: string | null;
  };
  outstanding: number;
  accruedInterest: number;
  before: LoanTermSnapshot;
  coverage: CollateralCoverageSnapshot;
  policy: CollateralPolicy;
  proposedPayer: {
    customerId: string;
    fullName: string;
    party: LoanParty;
    kyc: PartyKycState;
  } | null;
}

export interface RestructureState {
  request: RestructureRequest;
  loan: {
    id: string;
    loanNumber: string;
    status: LoanStatus;
    interestRate: number;
    interestRatePeriod: PeriodUnit;
    termMonths: number;
    outstanding: number;
  };
  waiver: FinancialTransaction | null;
  parties: Array<{ id: string; role: LoanPartyRole; status: LoanPartyStatus }>;
}

export interface ProposedPayerResponse {
  payer: ProposedPayer | null;
}

export enum BankAccountStatus {
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
}

export enum DisbursementChannel {
  BANK = 'BANK',
  CASH = 'CASH',
}

export const DISBURSEMENT_CHANNELS: DisbursementChannel[] = [DisbursementChannel.BANK, DisbursementChannel.CASH];

export enum EvidenceOwnerType {
  CUSTOMER = 'CUSTOMER',
  LOAN = 'LOAN',
}

export enum EvidenceKind {
  BANK_ACCOUNT_PROOF = 'BANK_ACCOUNT_PROOF',
  DISBURSEMENT_SLIP = 'DISBURSEMENT_SLIP',
}

/**
 * A registered account as the API returns it. `accountNumber` is always the masked form — the full
 * number stays server-side so a transfer can be reconciled against it without ever crossing the wire.
 */
export interface CustomerBankAccountView {
  id: string;
  customerId: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  branch: string | null;
  isPrimary: boolean;
  status: BankAccountStatus;
  note: string | null;
  closedAt: string | null;
  closeReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  proofCount: number;
}

export interface CustomerBankAccountsView {
  customer: { id: string; customerNumber: string; fullName: string };
  accounts: CustomerBankAccountView[];
}

export interface EvidencePolicy {
  maxFileSizeKb: number;
  maxFilesPerRequest: number;
  allowedMimeTypes: string[];
  maxTotalBytesPerOwner: number;
}

export interface EvidenceConfig {
  policy: EvidencePolicy;
  defaults: EvidencePolicy;
  checksum: string;
}

export interface EvidenceDocumentView {
  id: string;
  ownerType: EvidenceOwnerType;
  ownerId: string;
  kind: EvidenceKind;
  bankAccountId: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  note: string | null;
  uploadedBy: string;
  createdAt: string;
  accountNumber: string | null;
  bankName: string | null;
}

export interface EvidenceList {
  documents: EvidenceDocumentView[];
  policy: EvidencePolicy;
  policyText: string;
}

export interface LoanDisbursement {
  loanId: string;
  loanNumber: string;
  channel: DisbursementChannel | null;
  bankAccountId: string | null;
  bankName: string | null;
  accountNumber: string | null;
  reference: string | null;
}

export const formatLak = (v: unknown, currency = 'LAK'): string =>
  `${Number(v ?? 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;

export const COMPONENT_ORDER: (keyof ComponentAmounts)[] = [
  'PENALTY',
  'PAST_INTEREST',
  'PAST_PRINCIPAL',
];

export const COMPONENT_LABEL: Record<keyof ComponentAmounts, string> = {
  PENALTY: 'Penalty',
  PAST_INTEREST: 'Past Interest',
  PAST_PRINCIPAL: 'Past Principal',
};
