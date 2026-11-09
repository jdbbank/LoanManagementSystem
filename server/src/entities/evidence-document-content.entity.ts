import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** 1:1 payload holder for an EvidenceDocument (shared primary key). */
@Entity('evidence_document_contents')
export class EvidenceDocumentContent {
  @PrimaryColumn({ type: 'uuid' })
  documentId!: string;

  @Column({ type: 'longblob' })
  data!: Buffer;

  @CreateDateColumn()
  createdAt!: Date;
}
