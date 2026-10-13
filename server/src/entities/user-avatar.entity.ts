import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One active avatar per user. The bytes live in user_avatar_contents so that the
 * user list never drags a BLOB through the wire. Replacing an avatar updates this
 * row in place — an avatar is display data, not immutable evidence like KYC.
 */
@Entity('user_avatars')
@Index(['userId'], { unique: true })
export class UserAvatar {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** Display name only — never used to build a filesystem path. */
  @Column({ type: 'varchar', length: 255 })
  fileName!: string;

  @Column({ type: 'varchar', length: 100 })
  mimeType!: string;

  @Column({ type: 'int' })
  sizeBytes!: number;

  /** SHA-256 hex of the stored bytes — lets a re-upload of the same image be a no-op. */
  @Column({ type: 'varchar', length: 64 })
  checksum!: string;

  @Column({ type: 'uuid' })
  uploadedBy!: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
