import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { decimalColumn, PenaltyPolicy, PeriodUnit } from './types';

@Entity('loan_products')
export class LoanProduct {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  code!: string;

  @Column({ type: 'varchar', length: 191 })
  name!: string;

  /** Interest rate in percent, expressed per `interestRatePeriod` (scale 6 so daily rates survive). */
  @Column(decimalColumn({ precision: 18, scale: 6 }))
  interestRate!: number;

  @Column({ type: 'enum', enum: PeriodUnit, default: PeriodUnit.YEAR })
  interestRatePeriod!: PeriodUnit;

  /** Term as configured by the product owner. */
  @Column({ type: 'int', default: 12 })
  termValue!: number;

  @Column({ type: 'enum', enum: PeriodUnit, default: PeriodUnit.MONTH })
  termUnit!: PeriodUnit;

  /** Canonical term in whole months, derived from termValue/termUnit — the figure every calculation uses. */
  @Column({ type: 'int', default: 12 })
  termMonths!: number;

  /** TEXT column: MySQL allows no default, so products created before this field read back as the default policy. */
  @Column({ type: 'simple-json', nullable: true })
  penaltyPolicy!: PenaltyPolicy | null;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
