import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One organisation the API serves.
 *
 * This release introduces the row and the column every account hangs off it, while the deployment
 * still answers for a single tenant: the point is that a username is unique *inside an
 * organisation*, so the day a second one arrives the constraint, the data and the code path are
 * already shaped for it. Adding the column after two tenants share a table would mean deciding, by
 * hand, which organisation each existing account belongs to.
 *
 * The row is deliberately small. Nothing here is read by a business rule yet, and a field invented
 * before anything asks for it is a field nobody can say was wrong.
 */
@Entity('tenants')
@Index('UQ_tenants_code', ['code'], { unique: true })
export class Tenant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Stable, short, human-typed handle — the value a login carries (`tenant:[code]`), never the id. */
  @Column({ type: 'varchar', length: 32 })
  code!: string;

  /** What staff see when more than one organisation exists; a name nobody reads is still a name. */
  @Column({ type: 'varchar', length: 191 })
  name!: string;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;
}
