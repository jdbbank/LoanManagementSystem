import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ComponentAmounts, decimalColumn, TransactionStatus, TransactionType } from './types';

/**
 * Common financial transaction model (locked requirement section 24).
 * Immutable once POSTED — corrections use reversal/adjustment transactions.
 */
@Entity('financial_transactions')
@Index(['loanId'])
@Index(['customerId'])
@Index(['status'])
@Index(['referenceTransactionId'])
export class FinancialTransaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  referenceNo!: string;

  @Column({ type: 'enum', enum: TransactionType })
  transactionType!: TransactionType;

  @Column({ type: 'enum', enum: TransactionStatus, default: TransactionStatus.PENDING_APPROVAL })
  status!: TransactionStatus;

  @Column({ type: 'uuid' })
  loanId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column(decimalColumn())
  amount!: number;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  /** Original transaction this one refers to (reversal -> payment, write-off reversal -> write-off). */
  @Column({ type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  /** Source payment request id for payments. */
  @Column({ type: 'uuid', nullable: true })
  sourceRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  settlementAgreementId!: string | null;

  /**
   * Repayment period this charge belongs to (1 = the period that starts at disbursement).
   * Only INTEREST_ACCRUAL sets it: it is the idempotency key that stops one period being
   * billed twice, the same role sourceRequestId plays for payments.
   */
  @Column({ type: 'int', nullable: true })
  periodIndex!: number | null;

  /**
   * Per-component amounts for transaction types that carry them
   * (WAIVER / WRITE_OFF / ADJUSTMENT component deltas; WRITE_OFF_REVERSAL snapshot of
   * the original write-off components). Non-negative except for ADJUSTMENT (signed).
   */
  @Column({ type: 'simple-json', nullable: true })
  componentAmounts!: ComponentAmounts | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true })
  postedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  postedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
