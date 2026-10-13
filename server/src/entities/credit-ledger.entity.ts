import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { CreditLedgerType, decimalColumn } from './types';

@Entity('credit_ledger')
@Index(['customerId'])
@Index(['transactionId'])
export class CreditLedger {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'enum', enum: CreditLedgerType })
  type!: CreditLedgerType;

  /** Always positive; direction is given by `type`. */
  @Column(decimalColumn())
  amount!: number;

  @Column(decimalColumn())
  balanceAfter!: number;

  @Column({ type: 'uuid', nullable: true })
  transactionId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
