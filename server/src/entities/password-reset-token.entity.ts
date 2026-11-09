import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ResetTokenKind } from './types';

/**
 * A password-reset secret, stored only as a keyed digest of it. The plaintext OTP or link token
 * exists just long enough to be delivered, so a database dump cannot reset anything. Rows are kept
 * after use (usedAt set) for the audit trail.
 */
@Entity('password_reset_tokens')
@Index(['userId', 'kind', 'usedAt'])
export class PasswordResetToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar', length: 64 })
  tokenHash!: string;

  @Column({ type: 'enum', enum: ResetTokenKind })
  kind!: ResetTokenKind;

  @Column({ type: 'datetime' })
  expiresAt!: Date;

  /** Wrong guesses burn attempts; the row dies once the limit is reached. */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'datetime', nullable: true })
  usedAt!: Date | null;

  /** Who asked for it, stored the same way the audit log stores it — never the secret. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  requestedIp!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
