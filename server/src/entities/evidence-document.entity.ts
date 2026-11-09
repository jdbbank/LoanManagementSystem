import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { EvidenceKind, EvidenceOwnerType } from './types';

/**
 * Financial evidence metadata: the proof that a bank account belongs to a customer, and the transfer
 * slip or cash receipt that shows disbursed money actually arrived. The bytes live in
 * `evidence_document_contents`, exactly like KYC evidence, so listing documents never drags a LONGBLOB.
 *
 * Rows are immutable evidence — replacing a scan means uploading a new row. This table deliberately
 * stays outside the KYC pipeline: a KYC upload can send a customer back to PENDING and stop a
 * disbursement, which is right for identity documents and wrong for a payment proof.
 */
@Entity('evidence_documents')
@Index(['ownerType', 'ownerId'])
@Index(['kind'])
@Index(['bankAccountId'])
export class EvidenceDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: EvidenceOwnerType })
  ownerType!: EvidenceOwnerType;

  /** A customer id when ownerType is CUSTOMER, a loan id when it is LOAN. */
  @Column({ type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'enum', enum: EvidenceKind })
  kind!: EvidenceKind;

  /** Which registered account a bank proof documents. Null for a disbursement slip. */
  @Column({ type: 'uuid', nullable: true })
  bankAccountId!: string | null;

  /** Display name only — never used to build a filesystem path. */
  @Column({ type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ type: 'int' })
  sizeBytes!: number;

  /** SHA-256 hex of the stored bytes — duplicate guard and integrity proof. */
  @Column({ type: 'varchar', length: 64 })
  checksum!: string;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  uploadedBy!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
