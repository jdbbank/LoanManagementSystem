import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ApprovalLevel, ApprovalSubjectType, WorkflowStatus } from './types';

@Entity('approval_workflows')
@Index(['subjectId'])
export class ApprovalWorkflow {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: ApprovalSubjectType })
  subjectType!: ApprovalSubjectType;

  @Column({ type: 'uuid' })
  subjectId!: string;

  /** Levels derived from the ONE global threshold configuration (locked section 12). */
  @Column({ type: 'simple-json' })
  requiredLevels!: ApprovalLevel[];

  @Column({ type: 'int', default: 0 })
  currentLevelIndex!: number;

  @Column({ type: 'enum', enum: WorkflowStatus, default: WorkflowStatus.PENDING })
  status!: WorkflowStatus;

  @Column({ type: 'datetime', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
