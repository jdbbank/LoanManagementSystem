import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { BankAccountStatus } from './types';

/**
 * A bank account a customer receives or pays money through. It is financial contact data, not
 * identity data: registering one never touches `kycStatus`, and the proof that the account really is
 * the customer's is an `evidence_documents` row of kind BANK_ACCOUNT_PROOF, not a KYC document.
 *
 * The number itself is stored as written on the document so a transfer can be reconciled against it,
 * but every API response shows only the last digits (see `maskAccountNumber`).
 */
@Entity('customer_bank_accounts')
@Index(['customerId'])
@Index(['customerId', 'accountNumber'], { unique: true })
export class CustomerBankAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'varchar', length: 128 })
  bankName!: string;

  /** Digits and spaces as printed on the customer's document; display value is always masked. */
  @Column({ type: 'varchar', length: 64 })
  accountNumber!: string;

  /** Whose name the account is in. It is normally the customer, and saying so is the point. */
  @Column({ type: 'varchar', length: 191 })
  accountHolderName!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  branch!: string | null;

  /**
   * The account the branch uses for this customer unless another is named. At most one per customer
   * is primary; the service moves the flag instead of rejecting, so picking a new one is one call.
   */
  @Column({ type: 'boolean', default: false })
  isPrimary!: boolean;

  @Column({ type: 'enum', enum: BankAccountStatus, default: BankAccountStatus.ACTIVE })
  status!: BankAccountStatus;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  createdBy!: string;

  @Column({ type: 'datetime', nullable: true })
  closedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  closeReason!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
