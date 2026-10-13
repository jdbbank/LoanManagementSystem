import { DataSource } from 'typeorm';
import { env } from './config/env';
import { AuditLog } from './entities/audit-log.entity';
import { ApprovalStep } from './entities/approval-step.entity';
import { ApprovalWorkflow } from './entities/approval-workflow.entity';
import { CreditLedger } from './entities/credit-ledger.entity';
import { Customer } from './entities/customer.entity';
import { CustomerCredit } from './entities/customer-credit.entity';
import { FinancialTransaction } from './entities/financial-transaction.entity';
import { FinancialTransactionLine } from './entities/financial-transaction-line.entity';
import { EmailTemplate } from './entities/email-template.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { KycDocumentContent } from './entities/kyc-document-content.entity';
import { Loan } from './entities/loan.entity';
import { LoanProduct } from './entities/loan-product.entity';
import { NotificationOutbox } from './entities/notification-outbox.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { PaymentAllocation } from './entities/payment-allocation.entity';
import { PaymentRequest } from './entities/payment-request.entity';
import { ReconciliationRecord } from './entities/reconciliation-record.entity';
import { SettlementAgreement } from './entities/settlement-agreement.entity';
import { SystemConfig } from './entities/system-config.entity';
import { User } from './entities/user.entity';
import { UserAvatar } from './entities/user-avatar.entity';
import { UserAvatarContent } from './entities/user-avatar-content.entity';

export const entities = [
  User,
  SystemConfig,
  Customer,
  LoanProduct,
  Loan,
  FinancialTransaction,
  FinancialTransactionLine,
  PaymentRequest,
  PaymentAllocation,
  ApprovalWorkflow,
  ApprovalStep,
  AuditLog,
  CustomerCredit,
  CreditLedger,
  SettlementAgreement,
  ReconciliationRecord,
  KycDocument,
  KycDocumentContent,
  EmailTemplate,
  NotificationOutbox,
  UserAvatar,
  UserAvatarContent,
  PasswordResetToken,
];

let dataSource: DataSource | null = null;

/**
 * Builds a DataSource. `database` override is used by the test bootstrap.
 */
export function buildDataSource(database?: string): DataSource {
  return new DataSource({
    type: 'mysql',
    host: env.db.host,
    port: env.db.port,
    username: env.db.user,
    password: env.db.password,
    database: database ?? env.db.name,
    entities,
    synchronize: !env.isProduction || env.db.synchronize,
    logging: false,
    timezone: 'Z',
    supportBigNumbers: true,
  });
}

export function getDataSource(): DataSource {
  if (!dataSource) {
    dataSource = buildDataSource();
  }
  return dataSource;
}

export async function initDataSource(): Promise<DataSource> {
  const ds = getDataSource();
  if (!ds.isInitialized) {
    await ds.initialize();
  }
  return ds;
}

export async function resetDataSource(): Promise<void> {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
  dataSource = null;
}
