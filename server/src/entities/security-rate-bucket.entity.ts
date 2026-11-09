import { Column, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { RateLimitScope } from './types';

/**
 * One fixed-window request counter for one caller on one endpoint.
 *
 * The row is the counter, not a log: `hits` goes up in SQL and the window a count belongs to is
 * already inside `bucketKey`, so a new window is a different row and nothing has to be reset. Rows
 * outlive their window only until the prune job collects them, which keeps the table to roughly the
 * traffic of the last few minutes instead of growing with every request forever.
 *
 * `identity` is whatever the guarded endpoint keys on — an address, a username — never a secret.
 */
@Entity('security_rate_buckets')
@Index('UQ_security_rate_buckets_bucketKey', ['bucketKey'], { unique: true })
@Index('IDX_security_rate_buckets_expiresAt', ['expiresAt'])
export class SecurityRateBucket {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** `<scope>:<identity>:<window index>` — unique by construction, and the only key the counter needs. */
  @Column({ type: 'varchar', length: 191 })
  bucketKey!: string;

  @Column({ type: 'varchar', length: 64 })
  scope!: RateLimitScope;

  @Column({ type: 'varchar', length: 191 })
  identity!: string;

  @Column({ type: 'int', default: 0 })
  hits!: number;

  /** When the window closes plus one window of slack; the prune job deletes what is past this. */
  @Column({ type: 'datetime', precision: 3 })
  expiresAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
