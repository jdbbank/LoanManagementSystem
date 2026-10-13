import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { decimalColumn, PaymentRequestStatus } from './types';

/**
 * Payment request lifecycle (locked requirement section 4).
 * A REJECTED request is immutable; resubmission creates a NEW request linked via
 * previousRequestId so the original rejection reason is preserved.
 */
@Entity('payment_requests')
@Index(['loanId'])
@Index(['status'])
@Index(['previousRequestId'])
export class PaymentRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  requestNo!: string;

  @Column({ type: 'uuid' })
  loanId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  /** Cash actually received from the customer. */
  @Column(decimalColumn())
  cashAmount!: number;

  /** Customer credit applied to this payment (consumed at posting). */
  @Column(decimalColumn())
  creditApplied!: number;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  @Column({ type: 'enum', enum: PaymentRequestStatus, default: PaymentRequestStatus.PENDING })
  status!: PaymentRequestStatus;

  @Column({ type: 'uuid', nullable: true })
  previousRequestId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  settlementAgreementId!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'text', nullable: true })
  rejectionReason!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true })
  approvedBy!: string | null;

  @Column({ type: 'uuid', nullable: true })
  rejectedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  approvedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  rejectedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
