import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Customer } from '../entities/customer.entity';
import { CustomerBankAccount } from '../entities/customer-bank-account.entity';
import { EvidenceDocument } from '../entities/evidence-document.entity';
import { BankAccountStatus, EvidenceKind, EvidenceOwnerType, UserRole } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/errors';
import {
  closeBankAccount,
  findBankAccounts,
  maskAccountNumber,
  registerBankAccount,
  setPrimaryBankAccount,
} from '../services/bank-account.service';
import { notifyBankAccountRegistered } from '../services/notification-events.service';
import { getDataSource } from '../datasource';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** Closing an account is the one act here that needs more than the maker's desk: money already routed
 * to an account is a fact, so the decision to stop using it belongs to the approving tier. */
const CLOSE_ROLES = [UserRole.HEAD_APPROVER, UserRole.ADMIN];

const registerSchema = z.object({
  bankName: z.string().min(2).max(128),
  accountNumber: z.string().min(4).max(64),
  accountHolderName: z.string().min(2).max(191),
  branch: z.string().max(128).optional(),
  isPrimary: z.boolean().optional(),
  note: z.string().max(1000).optional(),
});

const closeSchema = z.object({
  reason: z.string().min(1, 'Closing an account needs a reason on record').max(1000),
});

function customerIdOf(req: Request): string {
  const customerId = (req.params as Record<string, string>).customerId;
  if (!customerId) throw badRequest('Missing customerId');
  return customerId;
}

/**
 * The stored number never leaves the server. Staff see enough to identify the account, and a leaked
 * response or browser cache cannot hand anyone a number to transfer money to.
 */
function accountView(account: CustomerBankAccount, proofCount: number) {
  return {
    id: account.id,
    customerId: account.customerId,
    bankName: account.bankName,
    accountNumber: maskAccountNumber(account.accountNumber),
    accountHolderName: account.accountHolderName,
    branch: account.branch,
    isPrimary: account.isPrimary,
    status: account.status,
    note: account.note,
    closedAt: account.closedAt,
    closeReason: account.closeReason,
    createdBy: account.createdBy,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
    proofCount,
  };
}

/** How many bank proofs are filed against each account, so the UI can say what is still unverified. */
async function proofCounts(em: EntityManager, customerId: string): Promise<Map<string, number>> {
  const proofs = await em.find(EvidenceDocument, {
    where: {
      ownerType: EvidenceOwnerType.CUSTOMER,
      ownerId: customerId,
      kind: EvidenceKind.BANK_ACCOUNT_PROOF,
    },
    select: { bankAccountId: true },
  });
  const counts = new Map<string, number>();
  for (const proof of proofs) {
    if (!proof.bankAccountId) continue;
    counts.set(proof.bankAccountId, (counts.get(proof.bankAccountId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Every account of one customer, active first and the primary one on top. `?status=ACTIVE` is what the
 * disbursement screen uses; the full history stays readable for reconciliation.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as BankAccountStatus)
        : undefined;
    const [customer, accounts, counts] = await Promise.all([
      em.findOne(Customer, { where: { id: customerIdOf(req) } }),
      findBankAccounts(em, customerIdOf(req), status),
      proofCounts(em, customerIdOf(req)),
    ]);
    if (!customer) throw badRequest('Customer not found');

    res.json({
      data: {
        customer: { id: customer.id, customerNumber: customer.customerNumber, fullName: customer.fullName },
        accounts: accounts.map((account) => accountView(account, counts.get(account.id) ?? 0)),
      },
    });
  })
);

/**
 * Files the account a customer receives money through. Nothing moves and no balance changes, so this
 * needs no approval — what makes it trustworthy is the proof document uploaded against it, which the
 * letter sent here tells staff to check before the account is used.
 */
router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(registerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const body = req.body as z.infer<typeof registerSchema>;

    const account = await getDataSource().transaction(async (em) => {
      const created = await registerBankAccount(em, {
        customerId: customerIdOf(req),
        bankName: body.bankName,
        accountNumber: body.accountNumber,
        accountHolderName: body.accountHolderName,
        branch: body.branch ?? null,
        isPrimary: body.isPrimary,
        note: body.note ?? null,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyBankAccountRegistered(em, {
        accountId: created.id,
        createdByName: user.fullName,
        actorUserId: user.id,
      });
      return created;
    });

    res.status(201).json({ data: accountView(account, 0) });
  })
);

/**
 * Stops future money going to an account. Loans already paid into it keep pointing at this row, because
 * that row is the record of where the money went at the time.
 */
router.post(
  '/:accountId/close',
  requireRole(...CLOSE_ROLES),
  validateBody(closeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body as { reason: string };

    const account = await getDataSource().transaction((em) =>
      closeBankAccount(em, {
        accountId: req.params.accountId,
        reason,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.json({ data: accountView(account, 0) });
  })
);

/** Moves the primary flag in one call, so choosing a new account is never a two-step un/set. */
router.post(
  '/:accountId/primary',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;

    const account = await getDataSource().transaction((em) =>
      setPrimaryBankAccount(em, {
        accountId: req.params.accountId,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );

    res.json({ data: accountView(account, 0) });
  })
);

export default router;
