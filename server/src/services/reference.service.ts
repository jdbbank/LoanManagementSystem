import { EntityManager } from 'typeorm';
import { FinancialTransaction } from '../entities/financial-transaction.entity';
import { PaymentRequest } from '../entities/payment-request.entity';
import { RestructureRequest } from '../entities/restructure-request.entity';
import { SettlementAgreement } from '../entities/settlement-agreement.entity';
import { badRequest } from '../utils/errors';
import { pad } from '../utils/pad';

/**
 * Human-readable reference numbers. Count-based generation is safe for this
 * single-instance deployment because the unique index rejects collisions.
 */
async function nextNumber(em: EntityManager, entity: unknown, prefix: string): Promise<string> {
  const repo = em.getRepository(entity as never);
  const count = await repo.count();
  return `${prefix}-${pad(count + 1, 6)}`;
}

export const nextTransactionNo = (em: EntityManager): Promise<string> =>
  nextNumber(em, FinancialTransaction, 'FT');

export const nextRequestNo = (em: EntityManager): Promise<string> =>
  nextNumber(em, PaymentRequest, 'PR');

export const nextAgreementNo = (em: EntityManager): Promise<string> =>
  nextNumber(em, SettlementAgreement, 'SA');

export const nextRestructureNo = (em: EntityManager): Promise<string> =>
  nextNumber(em, RestructureRequest, 'RS');

export { badRequest };
