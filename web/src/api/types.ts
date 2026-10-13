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

export interface AvatarPolicy {
  enabled: boolean;
  maxFileSizeKb: number;
  allowedMimeTypes: string[];
}

export interface AvatarConfig {
  policy: AvatarPolicy;
  defaults: AvatarPolicy;
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
  passwordChangedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
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

export interface CustomerRow extends Customer {
  loanCount: number;
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
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  penaltyPolicy: PenaltyPolicy | null;
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
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  penaltyPolicy: PenaltyPolicy | null;
  currency: string;
  outstandingPenalty: number;
  outstandingPastInterest: number;
  outstandingPastPrincipal: number;
  currentOutstanding: number;
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
  termValue: number;
  termUnit: PeriodUnit;
  termMonths: number;
  periodCount: number;
  penaltyPolicy: PenaltyPolicy;
  totals: LoanScheduleTotals;
  aging: LoanScheduleAging;
  periods: SchedulePeriod[];
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
  currency: string;
  status: SettlementStatus;
  reason: string | null;
  createdBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  createdAt: string;
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
  subjectType: 'FINANCIAL_TRANSACTION' | 'SETTLEMENT_AGREEMENT';
  subjectId: string;
  currentLevel: ApprovalLevel;
  remainingLevels: ApprovalLevel[];
  canDecide: boolean;
  blockedForUser: boolean;
  amount: number;
  subject:
    | { kind: 'TRANSACTION'; transaction: FinancialTransaction }
    | { kind: 'SETTLEMENT_AGREEMENT'; agreement: SettlementAgreement }
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
