import { EntityManager } from 'typeorm';
import { AuditBalanceSnapshot, AuditLog } from '../entities/audit-log.entity';

export interface AuditInput {
  action: string;
  transactionId?: string | null;
  transactionType?: string | null;
  loanId?: string | null;
  customerId?: string | null;
  userId?: string | null;
  previousStatus?: string | null;
  newStatus?: string | null;
  previousBalance?: AuditBalanceSnapshot | null;
  newBalance?: AuditBalanceSnapshot | null;
  amount?: number | null;
  currency?: string | null;
  makerUserId?: string | null;
  checkerUserId?: string | null;
  headApproverUserId?: string | null;
  adminUserId?: string | null;
  reason?: string | null;
  referenceTransactionId?: string | null;
  relatedTransactionId?: string | null;
  sourceRequestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Writes an immutable audit record. Callers pass the transaction-scoped EntityManager
 * so the audit row participates in the same atomic posting transaction.
 */
export async function writeAudit(em: EntityManager, input: AuditInput): Promise<AuditLog> {
  const log = em.create(AuditLog, {
    action: input.action,
    transactionId: input.transactionId ?? null,
    transactionType: input.transactionType ?? null,
    loanId: input.loanId ?? null,
    customerId: input.customerId ?? null,
    userId: input.userId ?? null,
    previousStatus: input.previousStatus ?? null,
    newStatus: input.newStatus ?? null,
    previousBalance: input.previousBalance ?? null,
    newBalance: input.newBalance ?? null,
    amount: input.amount ?? null,
    currency: input.currency ?? null,
    makerUserId: input.makerUserId ?? null,
    checkerUserId: input.checkerUserId ?? null,
    headApproverUserId: input.headApproverUserId ?? null,
    adminUserId: input.adminUserId ?? null,
    reason: input.reason ?? null,
    referenceTransactionId: input.referenceTransactionId ?? null,
    relatedTransactionId: input.relatedTransactionId ?? null,
    sourceRequestId: input.sourceRequestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });
  return em.save(AuditLog, log);
}
