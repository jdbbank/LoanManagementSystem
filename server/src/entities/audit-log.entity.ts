import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ComponentAmounts, decimalColumn } from './types';

export interface AuditBalanceSnapshot extends ComponentAmounts {
  total: number;
}

/**
 * Audit trail (locked requirement section 20).
 * Written for every important state change; original financial transactions
 * are never edited — the trail references them instead.
 */
@Entity('audit_logs')
@Index(['transactionId'])
@Index(['loanId'])
@Index(['customerId'])
@Index(['action'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  transactionId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  transactionType!: string | null;

  @Column({ type: 'uuid', nullable: true })
  loanId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  /** Actor performing the action. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  previousStatus!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  newStatus!: string | null;

  @Column({ type: 'simple-json', nullable: true })
  previousBalance!: AuditBalanceSnapshot | null;

  @Column({ type: 'simple-json', nullable: true })
  newBalance!: AuditBalanceSnapshot | null;

  @Column(decimalColumn({ nullable: true }))
  amount!: number | null;

  @Column({ type: 'varchar', length: 3, nullable: true })
  currency!: string | null;

  @Column({ type: 'uuid', nullable: true })
  makerUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  checkerUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  headApproverUserId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  adminUserId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  referenceTransactionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  relatedTransactionId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceRequestId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  userAgent!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
