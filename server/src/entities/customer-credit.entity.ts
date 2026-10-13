import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { decimalColumn } from './types';

/** Operational customer credit balance; changes only via posting engine (locked section 6). */
@Entity('customer_credits')
@Index(['customerId', 'currency'], { unique: true })
export class CustomerCredit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  @Column(decimalColumn())
  balance!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
