import { Column, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { decimalColumn } from './types';

/**
 * Globally configured system values. Approval thresholds live here so all modules
 * read one central configuration (locked requirement section 12).
 */
@Entity('system_config')
export class SystemConfig {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 128, unique: true })
  key!: string;

  @Column(decimalColumn())
  value!: number;

  /**
   * Text/list configuration value. Numeric policy keys keep using `value`;
   * keys such as the KYC mime allowlist are stored here.
   */
  @Column({ type: 'varchar', length: 500, nullable: true })
  valueText!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @Column({ type: 'uuid', nullable: true })
  updatedBy!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
