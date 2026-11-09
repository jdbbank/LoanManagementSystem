import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { CollateralStatus, CollateralType, decimalColumn } from './types';

/**
 * Physical security pledged against one loan. Values are what an appraiser recorded on a given day;
 * the restructure check reads them as of that valuation date, so a stale appraisal fails the check
 * instead of quietly counting as coverage.
 *
 * Documents (title deed scans and the like) stay in the KYC pipeline of the person who owns them —
 * this table records the pledge, not the paperwork.
 */
@Entity('loan_collaterals')
@Index(['loanId'])
@Index(['loanId', 'status'])
export class LoanCollateral {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  loanId!: string;

  /** Who owns the pledged item; null when the borrower's own name is on it. */
  @Column({ type: 'uuid', nullable: true })
  ownerCustomerId!: string | null;

  @Column({ type: 'enum', enum: CollateralType })
  type!: CollateralType;

  @Column({ type: 'enum', enum: CollateralStatus, default: CollateralStatus.PLEDGED })
  status!: CollateralStatus;

  @Column({ type: 'varchar', length: 255 })
  description!: string;

  /** Certificate / registration number as written on the document. Display and audit only. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  certificateNo!: string | null;

  @Column(decimalColumn())
  appraisedValue!: number;

  /** The day that value was established. Coverage is never measured against an undated number. */
  @Column({ type: 'date' })
  valuedAt!: Date;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'datetime', nullable: true })
  releasedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  releaseReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
