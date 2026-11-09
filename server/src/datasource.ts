import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { env } from './config/env';
import { AuditLog } from './entities/audit-log.entity';
import { ApprovalStep } from './entities/approval-step.entity';
import { ApprovalWorkflow } from './entities/approval-workflow.entity';
import { CreditLedger } from './entities/credit-ledger.entity';
import { Customer } from './entities/customer.entity';
import { CustomerBankAccount } from './entities/customer-bank-account.entity';
import { CustomerCredit } from './entities/customer-credit.entity';
import { EvidenceDocument } from './entities/evidence-document.entity';
import { EvidenceDocumentContent } from './entities/evidence-document-content.entity';
import { FinancialTransaction } from './entities/financial-transaction.entity';
import { FinancialTransactionLine } from './entities/financial-transaction-line.entity';
import { EmailTemplate } from './entities/email-template.entity';
import { KycDocument } from './entities/kyc-document.entity';
import { KycDocumentContent } from './entities/kyc-document-content.entity';
import { Loan } from './entities/loan.entity';
import { LoanCollateral } from './entities/loan-collateral.entity';
import { LoanParty } from './entities/loan-party.entity';
import { LoanProduct } from './entities/loan-product.entity';
import { NotificationOutbox } from './entities/notification-outbox.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { PaymentAllocation } from './entities/payment-allocation.entity';
import { PaymentRequest } from './entities/payment-request.entity';
import { ReconciliationRecord } from './entities/reconciliation-record.entity';
import { RestructureRequest } from './entities/restructure-request.entity';
import { SecurityRateBucket } from './entities/security-rate-bucket.entity';
import { SettlementAgreement } from './entities/settlement-agreement.entity';
import { SystemConfig } from './entities/system-config.entity';
import { Tenant } from './entities/tenant.entity';
import { User } from './entities/user.entity';
import { UserAvatar } from './entities/user-avatar.entity';
import { UserAvatarContent } from './entities/user-avatar-content.entity';
import { UserPasswordHistory } from './entities/user-password-history.entity';

export const entities = [
  Tenant,
  User,
  SystemConfig,
  Customer,
  CustomerBankAccount,
  LoanProduct,
  Loan,
  LoanParty,
  LoanCollateral,
  EvidenceDocument,
  EvidenceDocumentContent,
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
  RestructureRequest,
  ReconciliationRecord,
  KycDocument,
  KycDocumentContent,
  EmailTemplate,
  NotificationOutbox,
  UserAvatar,
  UserAvatarContent,
  PasswordResetToken,
  UserPasswordHistory,
  SecurityRateBucket,
];

let dataSource: DataSource | null = null;

/**
 * Migration files sit next to the entities' compiled output, so both loaders resolve them:
 * `tsx` reads `src/migrations/*.ts`, and the production image runs `node dist/migrations/*.js`.
 * Listing both globs means whichever directory is live supplies the classes, never both.
 */
const migrationPaths = [join(__dirname, 'migrations', '*.ts'), join(__dirname, 'migrations', '*.js')];

/** Records which migrations a database has already applied; TypeORM creates the table on first run. */
export const MIGRATIONS_TABLE = 'schema_migrations';

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
    synchronize: env.db.synchronize,
    logging: false,
    timezone: 'Z',
    supportBigNumbers: true,
  });
}

/**
 * DataSource for the TypeORM CLI (`npm run db:migrate` and friends).
 *
 * Synchronization is forced off even when `DB_SYNCHRONIZE=true`: a tool that writes migrations must
 * first read the real schema from the database, and synchronizing would rewrite that schema to match
 * the entities before it could report the difference. `database` lets the verification run target a
 * scratch schema instead of the live one.
 */
export function buildMigrationDataSource(database?: string): DataSource {
  return buildDataSource(database).setOptions({
    synchronize: false,
    migrationsRun: false,
    migrations: migrationPaths,
    migrationsTableName: MIGRATIONS_TABLE,
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
