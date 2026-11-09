import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import {
  CollateralCoverageSnapshot,
  decimalColumn,
  LoanTermSnapshot,
  RestructureChangeType,
  RestructureStatus,
} from './types';

/**
 * A hardship addendum: what the branch proposes to change when a borrower can no longer pay — a lower
 * rate, a longer term, a different payer, or relief on interest already accrued.
 *
 * Like a settlement agreement this is a business document, NOT a financial transaction: it changes
 * nothing by itself. Approval is the maker-checker workflow on this row; the money moves only when the
 * approved request is applied, which rewrites the loan's own snapshot terms and books the relief as a
 * WAIVER transaction with its own approval trail. Nothing is edited silently, so the old debt is still
 * in the ledger and the reports still reconcile.
 */
@Entity('restructure_requests')
@Index(['loanId'])
@Index(['status'])
export class RestructureRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  requestNo!: string;

  @Column({ type: 'uuid' })
  loanId!: string;

  /** The borrower on the contract. The relief is theirs even when someone else pays it. */
  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'enum', enum: RestructureStatus, default: RestructureStatus.PENDING_APPROVAL })
  status!: RestructureStatus;

  /** Why this loan cannot pay as contracted. Required — an approval without it is unsignable. */
  @Column({ type: 'text' })
  hardshipReason!: string;

  @Column({ type: 'simple-json' })
  changeTypes!: RestructureChangeType[];

  /**
   * Requested rate, scale 6 like the loan column so a per-day rate survives the round trip. Left at the
   * default when no rate change is asked for — `changeTypes` is what says whether this number is real.
   */
  @Column(decimalColumn({ precision: 18, scale: 6, nullable: true }))
  newInterestRate!: number | null;

  @Column({ type: 'int', nullable: true })
  newTermMonths!: number | null;

  @Column({ type: 'uuid', nullable: true })
  newPayerCustomerId!: string | null;

  /** Accrued interest to cancel when the request is applied. Booked as a WAIVER, never a silent edit. */
  @Column(decimalColumn())
  interestReliefAmount!: number;

  /**
   * What the loan owed when this paper was written, and the figure its approval levels are computed
   * from. It is stored rather than re-read because a payment between two approval steps must not
   * change which authority a decision needs.
   */
  @Column(decimalColumn())
  repricingAmount!: number;

  @Column({ type: 'varchar', length: 3, default: 'LAK' })
  currency!: string;

  /** The contract as it stood when this paper was written, and as it becomes once applied. */
  @Column({ type: 'simple-json' })
  beforeTerms!: LoanTermSnapshot;

  @Column({ type: 'simple-json' })
  afterTerms!: LoanTermSnapshot;

  /** Collateral position measured at submission — the evidence the approver relied on. */
  @Column({ type: 'simple-json', nullable: true })
  collateralSnapshot!: CollateralCoverageSnapshot | null;

  /** The WAIVER transaction that carried the relief into the ledger once applied. */
  @Column({ type: 'uuid', nullable: true })
  waiverTransactionId!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ type: 'uuid', nullable: true })
  appliedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  appliedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
