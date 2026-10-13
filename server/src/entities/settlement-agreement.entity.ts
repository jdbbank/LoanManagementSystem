import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { decimalColumn, SettlementStatus } from './types';

/**
 * Settlement agreement is a business document, NOT a financial transaction
 * (locked requirement section 16). It never changes outstanding by itself;
 * only posted SETTLEMENT_PAYMENT / WAIVER transactions do.
 */
@Entity('settlement_agreements')
@Index(['loanId'])
@Index(['status'])
export class SettlementAgreement {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  agreementNo!: string;

  @Column({ type: 'uuid' })
  loanId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column(decimalColumn())
  agreedAmount!: number;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  @Column({ type: 'enum', enum: SettlementStatus, default: SettlementStatus.PENDING_APPROVAL })
  status!: SettlementStatus;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
