import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { decimalColumn, LoanStatus, PenaltyPolicy, PeriodUnit } from './types';

/**
 * Hybrid outstanding model (locked requirement section 3):
 * operational component balances are stored here and updated ONLY by the posting
 * engine atomically together with the posted transaction history.
 */
@Entity('loans')
@Index(['customerId'])
@Index(['status'])
export class Loan {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  loanNumber!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'uuid' })
  productId!: string;

  @Column({ type: 'enum', enum: LoanStatus, default: LoanStatus.ACTIVE })
  status!: LoanStatus;

  @Column(decimalColumn())
  principalAmount!: number;

  /** Snapshot of the product rate — scale 6 so a per-day rate is not rounded away. */
  @Column(decimalColumn({ precision: 18, scale: 6 }))
  interestRate!: number;

  /** Snapshot of the unit the snapshot rate is expressed per. */
  @Column({ type: 'enum', enum: PeriodUnit, default: PeriodUnit.YEAR })
  interestRatePeriod!: PeriodUnit;

  /** Snapshot of the term as configured on the product. */
  @Column({ type: 'int', default: 0 })
  termValue!: number;

  @Column({ type: 'enum', enum: PeriodUnit, default: PeriodUnit.MONTH })
  termUnit!: PeriodUnit;

  /** Canonical term in whole months (at least one period), used by the schedule and legacy previews. */
  @Column({ type: 'int' })
  termMonths!: number;

  /** Penalty terms frozen at disbursement, exactly like the rate (locked section 2.1 spirit). */
  @Column({ type: 'simple-json', nullable: true })
  penaltyPolicy!: PenaltyPolicy | null;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  @Column(decimalColumn())
  outstandingPenalty!: number;

  @Column(decimalColumn())
  outstandingPastInterest!: number;

  @Column(decimalColumn())
  outstandingPastPrincipal!: number;

  @Column(decimalColumn())
  currentOutstanding!: number;

  @Column({ type: 'datetime', nullable: true })
  disbursedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
