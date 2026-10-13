import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalLevel, StepStatus } from './types';

@Entity('approval_steps')
@Index(['workflowId'])
export class ApprovalStep {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  workflowId!: string;

  @Column({ type: 'enum', enum: ApprovalLevel })
  level!: ApprovalLevel;

  @Column({ type: 'enum', enum: StepStatus, default: StepStatus.PENDING })
  status!: StepStatus;

  /** User who decided this step. */
  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'datetime', nullable: true })
  decidedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
