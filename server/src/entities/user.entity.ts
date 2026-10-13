import { Column, CreateDateColumn, DeleteDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { UserRole } from './types';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, unique: true })
  username!: string;

  @Column({ type: 'varchar', length: 128 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 191 })
  fullName!: string;

  /** Login mail address and the target for password-reset messages. Null = staff mail disabled. */
  @Column({ type: 'varchar', length: 191, unique: true, nullable: true })
  email!: string | null;

  @Column({ type: 'boolean', default: false })
  isEmailVerified!: boolean;

  @Column({ type: 'enum', enum: UserRole })
  role!: UserRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'datetime', nullable: true })
  lastLoginAt!: Date | null;

  /** Basis for any "password is old" rule; set on creation and on every change. */
  @Column({ type: 'datetime', nullable: true })
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
