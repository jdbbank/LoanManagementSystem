import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { LoanPartyRole, LoanPartyStatus } from './types';

/**
 * A guarantor or a replacement payer for one loan. Both are ordinary customer rows: the person is
 * identified, verified and reviewed exactly like a borrower, and this table only records the role they
 * took on for this contract.
 *
 * KYC is per engagement, not per person. `engagedAt` is when they became a party to THIS loan, so the
 * service requires a verification decision dated at or after it — being verified years ago for somebody
 * else's loan never vouches for this one.
 */
@Entity('loan_parties')
@Index(['loanId'])
@Index(['customerId'])
@Index(['loanId', 'customerId', 'role'], { unique: true })
export class LoanParty {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  loanId!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'enum', enum: LoanPartyRole })
  role!: LoanPartyRole;

  @Column({ type: 'enum', enum: LoanPartyStatus, default: LoanPartyStatus.ACTIVE })
  status!: LoanPartyStatus;

  /**
   * When this person took on this role for this loan. A revived row carries a new date, so the KYC
   * anchor moves with the engagement and an old verification can never vouch for a new one.
   */
  @Column({ type: 'datetime' })
  engagedAt!: Date;

  /** Free-text relationship to the borrower (sibling, employer, ...). Display only. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  relationship!: string | null;

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
