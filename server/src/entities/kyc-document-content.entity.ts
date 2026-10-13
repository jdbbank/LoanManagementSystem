import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** 1:1 payload holder for a KycDocument (shared primary key). */
@Entity('kyc_document_contents')
export class KycDocumentContent {
  @PrimaryColumn({ type: 'uuid' })
  documentId!: string;

  @Column({ type: 'longblob' })
  data!: Buffer;

  @CreateDateColumn()
  createdAt!: Date;
}
