import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Every password an account has ever been given, newest row last, so "the new password must not
 * repeat one you have used before" has something to compare against. Only bcrypt hashes are stored —
 * the same value the login path compares, never a plaintext or anything reversible — and the current
 * password is the newest row, which is what makes a reuse check possible before anything is written.
 *
 * Rows older than the policy depth are trimmed by the write path, not by a job: history is only ever
 * read as "the last N", so a trim that waits would still answer correctly, and a write path that
 * trims keeps the table bounded without a second moving part.
 */
@Entity('user_password_history')
@Index(['userId', 'createdAt'])
export class UserPasswordHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Same length as `users.passwordHash`, so a hash is never silently truncated into this table. */
  @Column({ type: 'varchar', length: 128 })
  passwordHash!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
