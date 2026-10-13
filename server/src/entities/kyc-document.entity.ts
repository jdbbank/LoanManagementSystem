import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { KycDocumentType, KycDocumentVariant } from './types';

/**
 * KYC evidence metadata. The bytes live in kyc_document_contents so that listing a
 * customer's documents never drags LONGBLOB payloads through the wire.
 * Rows are immutable evidence: replacing a scan means uploading a new row.
 */
@Entity('kyc_documents')
@Index(['customerId'])
@Index(['customerId', 'documentType'])
export class KycDocument {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  customerId!: string;

  @Column({ type: 'enum', enum: KycDocumentType })
  documentType!: KycDocumentType;

  @Column({ type: 'enum', enum: KycDocumentVariant, default: KycDocumentVariant.MAIN })
  variant!: KycDocumentVariant;

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

  @Column({ type: 'date', nullable: true })
  issuedAt!: Date | null;

  @Column({ type: 'date', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({ type: 'uuid' })
  uploadedBy!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
