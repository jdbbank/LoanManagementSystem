import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { KycPolicy, KycStatus } from './types';

@Entity('customers')
export class Customer {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  customerNumber!: string;

  @Column({ type: 'varchar', length: 191 })
  fullName!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  nationalId!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  address!: string | null;

  /** KYC lifecycle — VERIFIED is the precondition for loan disbursement (policy gated). */
  @Column({ type: 'enum', enum: KycStatus, default: KycStatus.NOT_VERIFIED })
  kycStatus!: KycStatus;

  @Column({ type: 'uuid', nullable: true })
  kycSubmittedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  kycSubmittedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  kycReviewedBy!: string | null;

  @Column({ type: 'datetime', nullable: true })
  kycReviewedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  kycRejectionReason!: string | null;

  /** Policy in force at the last verification decision, kept for later audits. */
  @Column({ type: 'simple-json', nullable: true })
  kycAppliedPolicy!: KycPolicy | null;

  @CreateDateColumn()
  createdAt!: Date;
}
