import { Router, Request, Response } from 'express';
import { EntityManager, In } from 'typeorm';
import { z } from 'zod';
import { Customer } from '../entities/customer.entity';
import { KycDocument } from '../entities/kyc-document.entity';
import { Loan } from '../entities/loan.entity';
import { LoanPartyRole, LoanPartyStatus, UserRole } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound } from '../utils/errors';
import { findParties, partyKycState, registerParty, releaseParty } from '../services/loan-party.service';
import { notifyPartyRegistered, notifyPartyReleased } from '../services/notification-events.service';
import { getDataSource } from '../datasource';

const router = Router({ mergeParams: true });
router.use(requireAuth);

/** Releasing a guarantor or payer weakens the loan, so it sits above the maker's desk. */
const RELEASE_ROLES = [UserRole.HEAD_APPROVER, UserRole.ADMIN];

const registerPartySchema = z.object({
  customerId: z.string().uuid(),
  role: z.enum([LoanPartyRole.GUARANTOR, LoanPartyRole.PAYER]),
  relationship: z.string().max(64).optional(),
  note: z.string().max(1000).optional(),
});

const releasePartySchema = z.object({
  reason: z.string().min(1, 'A release needs a reason on record').max(1000),
});

function loanIdOf(req: Request): string {
  const loanId = (req.params as Record<string, string>).loanId;
  if (!loanId) throw badRequest('Missing loanId');
  return loanId;
}

/**
 * The party rows plus, for each one, the KYC verdict for THAT engagement: a person verified years ago
 * for another loan is not yet a guarantor here, and the UI has to show what staff still have to do.
 */
async function partyViews(em: EntityManager, loanId: string, status?: LoanPartyStatus) {
  const loan = await em.findOne(Loan, { where: { id: loanId } });
  if (!loan) throw notFound('Loan');

  const parties = await findParties(em, loanId);
  const customerIds = [...new Set([loan.customerId, ...parties.map((party) => party.customerId)])];
  const [customers, documents] = await Promise.all([
    em.find(Customer, { where: { id: In(customerIds) } }),
    em.find(KycDocument, { where: { customerId: In(customerIds) }, select: { customerId: true } }),
  ]);

  const byId = new Map(customers.map((customer) => [customer.id, customer]));
  const documentCounts = new Map<string, number>();
  for (const document of documents) {
    documentCounts.set(document.customerId, (documentCounts.get(document.customerId) ?? 0) + 1);
  }

  return {
    loan: {
      id: loan.id,
      loanNumber: loan.loanNumber,
      status: loan.status,
      customerId: loan.customerId,
      customerName: byId.get(loan.customerId)?.fullName ?? loan.customerId,
      currency: loan.currency,
    },
    parties: parties
      .filter((party) => !status || party.status === status)
      .map((party) => {
        const customer = byId.get(party.customerId);
        return {
          party,
          customer: customer
            ? {
                id: customer.id,
                customerNumber: customer.customerNumber,
                fullName: customer.fullName,
                nationalId: customer.nationalId,
                phone: customer.phone,
                email: customer.email,
              }
            : null,
          kyc: customer
            ? partyKycState(party, customer, documentCounts.get(customer.id) ?? 0)
            : null,
        };
      }),
  };
}

/**
 * Guarantors and replacement payers of one loan, each with the KYC state of that engagement.
 * `?status=ACTIVE` hides the released history, which stays on record for audit.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const status =
      typeof req.query.status === 'string' && req.query.status
        ? (req.query.status as LoanPartyStatus)
        : undefined;
    const result = await partyViews(getDataSource().manager, loanIdOf(req), status);
    res.json({ data: result });
  })
);

/**
 * Names a person as guarantor or payer. It records the engagement only — the KYC requirement that
 * follows from it is satisfied through the existing customer KYC routes, not here.
 */
router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  validateBody(registerPartySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const body = req.body as z.infer<typeof registerPartySchema>;

    const party = await getDataSource().transaction(async (em) => {
      const created = await registerParty(em, {
        loanId: loanIdOf(req),
        customerId: body.customerId,
        role: body.role,
        relationship: body.relationship ?? null,
        note: body.note ?? null,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyPartyRegistered(em, {
        loanId: created.loanId,
        partyCustomerId: created.customerId,
        role: created.role,
        engagedAt: created.engagedAt,
      });
      return created;
    });

    res.status(201).json({ data: party });
  })
);

/**
 * Releases a guarantor or payer. The head approves it rather than the maker because the loan stands on
 * the people behind it, and everyone who is affected — the released person first — is told in the same
 * step, so nobody learns their duty ended from a report next month.
 */
router.post(
  '/:partyId/release',
  requireRole(...RELEASE_ROLES),
  validateBody(releasePartySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body as { reason: string };

    const party = await getDataSource().transaction(async (em) => {
      const released = await releaseParty(em, {
        partyId: req.params.partyId,
        reason,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      await notifyPartyReleased(em, {
        loanId: released.loanId,
        partyCustomerId: released.customerId,
        role: released.role,
        reason,
        releasedAt: released.releasedAt ?? new Date(),
      });
      return released;
    });

    res.json({ data: party });
  })
);

export default router;
