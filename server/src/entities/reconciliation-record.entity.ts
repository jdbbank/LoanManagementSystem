import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ComponentAmounts, ReconciliationStatus } from './types';

/**
 * Reconciliation record (locked requirement sections 3, 26.20):
 * compares operational outstanding vs posted transaction history.
 * A mismatch is NEVER auto-corrected — it must be resolved through an approved
 * adjustment transaction.
 */
@Entity('reconciliation_records')
@Index(['loanId'])
@Index(['status'])
export class ReconciliationRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  loanId!: string | null;

  @Column({ type: 'enum', enum: ReconciliationStatus })
  status!: ReconciliationStatus;

  @Column({ type: 'simple-json' })
  operationalOutstanding!: ComponentAmounts;

  @Column({ type: 'simple-json' })
  computedFromHistory!: ComponentAmounts;

  @Column({ type: 'simple-json' })
  difference!: ComponentAmounts;

  @Column({ type: 'uuid' })
  runBy!: string;

  @Column({ type: 'datetime', nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
