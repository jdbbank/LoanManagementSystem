import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/** 1:1 payload holder for a UserAvatar (shared primary key). */
@Entity('user_avatar_contents')
export class UserAvatarContent {
  @PrimaryColumn({ type: 'uuid' })
  avatarId!: string;

  @Column({ type: 'longblob' })
  data!: Buffer;

  @CreateDateColumn()
  createdAt!: Date;
}
