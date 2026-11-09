import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NotificationEventType, NotificationStatus } from './types';

/**
 * Transactional outbox. Business flows write a row here inside their own database
 * transaction, and the dispatcher publishes it afterwards. A broker or SMTP outage can
 * therefore never lose a notification and never rolls back a posted transaction.
 */
@Entity('notification_outbox')
@Index(['status', 'createdAt'])
export class NotificationOutbox {
  /** Outbox id doubles as the event id, so retries stay idempotent downstream. */
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'enum', enum: NotificationEventType })
  type!: NotificationEventType;

  @Column({ type: 'varchar', length: 191 })
  recipientEmail!: string;

  @Column({ type: 'varchar', length: 191 })
  recipientName!: string;

  @Column({ type: 'varchar', length: 8 })
  locale!: string;

  /**
   * Readable for ordinary emails; sealed for the reset types whose subject itself carries the
   * OTP, which is why this column is TEXT (the sealed form is ~4/3 the plaintext length).
   */
  @Column({ type: 'text' })
  subject!: string;

  @Column({ type: 'text' })
  bodyHtml!: string;

  @Column({ type: 'text' })
  bodyText!: string;

  /** Render-time values, sealed at rest because they can carry an OTP or a reset link. */
  @Column({ type: 'text' })
  payload!: string;

  @Column({ type: 'enum', enum: NotificationStatus, default: NotificationStatus.PENDING })
  status!: NotificationStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  lastError!: string | null;

  /** Not before this instant — backs off while a transport is failing. */
  @Column({ type: 'datetime', nullable: true })
  nextRetryAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  sentAt!: Date | null;

  /** Loose links for traceability only; the outbox is not a financial record. */
  @Column({ type: 'uuid', nullable: true })
  customerId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  loanId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
