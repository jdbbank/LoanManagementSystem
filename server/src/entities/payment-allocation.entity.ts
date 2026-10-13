import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ComponentType, decimalColumn } from './types';

/**
 * Allocation proposal / final decision per component for a payment request
 * (locked requirement section 7 — system proposes, authorized staff may override
 * within hard limits; finalAmount is set at approval).
 */
@Entity('payment_allocations')
@Index(['paymentRequestId'])
export class PaymentAllocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  paymentRequestId!: string;

  @Column({ type: 'enum', enum: ComponentType })
  component!: ComponentType;

  /** Sequential allocation snapshot taken when the request was created. */
  @Column(decimalColumn())
  proposedAmount!: number;

  /** Final allocation (override or confirmed proposal) set at approval. */
  @Column(decimalColumn())
  finalAmount!: number;

  /**
   * True when authorized staff replaced the system proposal. Only these allocations are held to
   * the section 7 limits again at posting; a confirmed proposal is re-sequenced against the balance
   * of the day so a payment approved against an older balance still settles correctly.
   */
  @Column({ type: 'boolean', default: false })
  overridden!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
