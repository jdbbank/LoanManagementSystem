import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ComponentType, decimalColumn } from './types';

/**
 * Signed effect of a POSTED transaction on one outstanding component.
 * positive = increases outstanding, negative = decreases outstanding.
 * Reconciliation sums these lines per loan (locked requirement section 3, 26.20).
 */
@Entity('financial_transaction_lines')
@Index(['transactionId'])
export class FinancialTransactionLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  transactionId!: string;

  @Column({ type: 'enum', enum: ComponentType })
  component!: ComponentType;

  @Column(decimalColumn())
  amount!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
