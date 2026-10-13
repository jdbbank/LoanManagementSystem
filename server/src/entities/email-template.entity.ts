import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { NotificationEventType } from './types';

/**
 * Email template owned by the backend: subject, HTML layout and plain-text fallback
 * all live here, so the mailer service never decides how a message looks.
 * `{{variable}}` placeholders are replaced at enqueue time (see email-template.service).
 */
@Entity('email_templates')
@Index(['code', 'locale'], { unique: true })
export class EmailTemplate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: NotificationEventType })
  code!: NotificationEventType;

  /** Template language, matching the UI locales (`lo`, `en`). */
  @Column({ type: 'varchar', length: 8, default: 'lo' })
  locale!: string;

  @Column({ type: 'varchar', length: 255 })
  subject!: string;

  @Column({ type: 'text' })
  bodyHtml!: string;

  @Column({ type: 'text' })
  bodyText!: string;

  /** Variable names this template expects, shown in the admin UI when editing. */
  @Column({ type: 'simple-json' })
  variables!: string[];

  /** An inactive template is kept for history but never rendered. */
  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
