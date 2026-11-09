import { Column, CreateDateColumn, DeleteDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { AccountLockReason, UserRole } from './types';

/**
 * Uniqueness is per organisation, so two tenants can each have a `maker1`. It is not a looseness: a
 * username that is free in one tenant is still refused in the other, and the composite index is what
 * enforces it — the checks in the router are only the message, the same way every other duplicate in
 * this schema is caught after the pre-check by `ER_DUP_ENTRY`.
 *
 * `email` stays nullable, and MySQL lets any number of NULL rows share a unique index, so staff mail
 * remaining switched off for an account is still possible.
 */
@Entity('users')
@Index('UQ_users_tenantId_username', ['tenantId', 'username'], { unique: true })
@Index('UQ_users_tenantId_email', ['tenantId', 'email'], { unique: true })
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The organisation this account belongs to. A plain column rather than a relation because nothing
   * joins it: every reader already knows which tenant it serves, and an eager relation would put a
   * second query on every sign-in to fetch a name nobody displays yet.
   */
  @Column({ type: 'varchar', length: 36 })
  tenantId!: string;

  @Column({ type: 'varchar', length: 64 })
  username!: string;

  @Column({ type: 'varchar', length: 128 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 191 })
  fullName!: string;

  /** Login mail address and the target for password-reset messages. Null = staff mail disabled. */
  @Column({ type: 'varchar', length: 191, nullable: true })
  email!: string | null;

  @Column({ type: 'boolean', default: false })
  isEmailVerified!: boolean;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  /**
   * Wrong passwords entered against this account since the last success, or since ADMIN last
   * unlocked it. The login path adds to it in SQL rather than reading, adding and writing back, so
   * two guesses in the same instant cannot both see the pre-lock count and let one of them through.
   */
  @Column({ type: 'int', default: 0 })
  failedLoginAttempts!: number;

  /**
   * The security lock, kept deliberately apart from `isActive`: disabling an account is ADMIN intent,
   * while this says "a rule locked you out and only ADMIN can clear it". Non-null is the lock — an
   * unlock sets it back to null and would otherwise have no way to avoid re-enabling an account that
   * ADMIN had also disabled on purpose.
   */
  @Column({ type: 'datetime', nullable: true })
  lockedAt!: Date | null;

  @Column({ type: 'enum', enum: AccountLockReason, nullable: true })
  lockReason!: AccountLockReason | null;

  /**
   * Basis for any "password is old" rule; set on creation and on every change.
   * Milliseconds matter: authMiddleware compares this against the instant a token was minted, and
   * a second-resolution column rounds a change up past a login that legitimately followed it.
   */
  @Column({ type: 'datetime', precision: 3, nullable: true })
  passwordChangedAt!: Date | null;

  /**
   * Soft delete: history, audit rows and loan references stay intact, but every
   * TypeORM finder hides the account and login stops working for it.
   */
  @DeleteDateColumn({ type: 'datetime', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
