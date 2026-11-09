import { Router, Request, Response } from 'express';
import { EntityManager, In } from 'typeorm';
import { z } from 'zod';
import { CustomerBankAccount } from '../entities/customer-bank-account.entity';
import { EvidenceDocument } from '../entities/evidence-document.entity';
import { EvidenceKind, EvidenceOwnerType } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, notFound } from '../utils/errors';
import { readSingleFile } from '../utils/upload';
import { maskAccountNumber } from '../services/bank-account.service';
import {
  deleteEvidence,
  findEvidence,
  readEvidenceContent,
  recordEvidence,
} from '../services/evidence.service';
import { describeEvidencePolicy, getEvidencePolicy } from '../services/evidence-policy.service';
import { notifyDisbursementEvidenceUploaded } from '../services/notification-events.service';
import { getDataSource } from '../datasource';

/**
 * One router, mounted under both owners it serves:
 *   /api/customers/:customerId/evidence  — bank account proofs
 *   /api/loans/:loanId/evidence          — disbursement slips and cash receipts
 *
 * The owner comes from the path, never from the body, so a request cannot file evidence against a
 * customer or loan it was not addressed to.
 */
const router = Router({ mergeParams: true });
router.use(requireAuth);

const uploadSchema = z.object({
  kind: z.enum([EvidenceKind.BANK_ACCOUNT_PROOF, EvidenceKind.DISBURSEMENT_SLIP]),
  bankAccountId: z.string().uuid().optional(),
  note: z.string().max(1000).optional(),
});

function ownerOf(req: Request): { type: EvidenceOwnerType; id: string } {
  const params = req.params as Record<string, string>;
  if (params.customerId) return { type: EvidenceOwnerType.CUSTOMER, id: params.customerId };
  if (params.loanId) return { type: EvidenceOwnerType.LOAN, id: params.loanId };
  throw badRequest('Evidence belongs to a customer or a loan');
}

function kindOf(req: Request): EvidenceKind | undefined {
  const raw = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : undefined;
  if (!raw) return undefined;
  if (!Object.values(EvidenceKind).includes(raw as EvidenceKind)) throw badRequest(`Unknown evidence kind ${raw}`);
  return raw as EvidenceKind;
}

/** A bank proof names the account it documents, so the list can show which account and which digits. */
async function evidenceViews(em: EntityManager, docs: EvidenceDocument[]) {
  const accountIds = [...new Set(docs.map((doc) => doc.bankAccountId).filter((id): id is string => !!id))];
  const accounts = accountIds.length
    ? await em.find(CustomerBankAccount, { where: { id: In(accountIds) } })
    : [];
  const byId = new Map(accounts.map((account) => [account.id, account]));

  return docs.map((doc) => {
    const account = doc.bankAccountId ? byId.get(doc.bankAccountId) : undefined;
    return {
      ...doc,
      accountNumber: account ? maskAccountNumber(account.accountNumber) : null,
      bankName: account?.bankName ?? null,
    };
  });
}

/**
 * Filed evidence for this owner plus the live upload policy, so the form can state the size limit and
 * accepted formats instead of letting the server reject the file after the customer picked it.
 */
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const owner = ownerOf(req);
    const [docs, policy] = await Promise.all([
      findEvidence(em, { ownerType: owner.type, ownerId: owner.id, kind: kindOf(req) }),
      getEvidencePolicy(em),
    ]);
    res.json({ data: { documents: await evidenceViews(em, docs), policy, policyText: describeEvidencePolicy(policy) } });
  })
);

/**
 * Uploads one evidence image. A slip is filed after the loan row and its disbursement transaction
 * already exist, so it records how the money was handed over; it moves no balance and needs no approval.
 */
router.post(
  '/',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const owner = ownerOf(req);
    const dataSource = getDataSource();

    const policy = await getEvidencePolicy(dataSource.manager);
    const file = await readSingleFile(req, res, policy.maxFileSizeKb, policy.maxFilesPerRequest);
    const body = uploadSchema.parse(req.body);

    const document = await dataSource.transaction(async (em) => {
      const created = await recordEvidence(em, {
        ownerType: owner.type,
        ownerId: owner.id,
        kind: body.kind,
        bankAccountId: body.bankAccountId ?? null,
        note: body.note ?? null,
        buffer: file.buffer,
        fileName: file.originalname,
        policy,
        userId: user.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      if (owner.type === EvidenceOwnerType.LOAN) {
        await notifyDisbursementEvidenceUploaded(em, {
          loanId: owner.id,
          documentId: created.id,
          uploadedByName: user.fullName,
        });
      }
      return created;
    });

    res.status(201).json({ data: (await evidenceViews(getDataSource().manager, [document]))[0] });
  })
);

/** Raw bytes for one document — the UI fetches this with the auth header and shows an <img>. */
router.get(
  '/:documentId/content',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const owner = ownerOf(req);
    const documentId = (req.params as Record<string, string>).documentId;
    const doc = await em.findOne(EvidenceDocument, { where: { id: documentId, ownerId: owner.id } });
    if (!doc) throw notFound('Evidence document');
    const data = await readEvidenceContent(em, doc.id);
    if (!data) throw notFound('Evidence document content');

    const safeName = doc.fileName.replace(/[^\w.\- ]/g, '').slice(0, 100) || 'evidence-image';
    res.set('Content-Type', doc.mimeType);
    res.set('Content-Disposition', `inline; filename="${safeName}"`);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(data);
  })
);

/**
 * Removes a misfiled document. Evidence is immutable, so correcting a mistake is a delete plus a new
 * upload; only the person who filed it or an ADMIN may remove it, and both leave an audit row behind.
 */
router.delete(
  '/:documentId',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const owner = ownerOf(req);
    const documentId = (req.params as Record<string, string>).documentId;

    await getDataSource().transaction(async (em) => {
      const existing = await em.findOne(EvidenceDocument, { where: { id: documentId, ownerId: owner.id } });
      if (!existing) throw notFound('Evidence document');
      await deleteEvidence(em, {
        documentId,
        userId: user.id,
        role: user.role,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
    });

    res.json({ data: { deleted: documentId } });
  })
);

export default router;
