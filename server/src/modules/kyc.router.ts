import { Router, Request, Response } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { Customer } from '../entities/customer.entity';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycDocumentContent } from '../entities/kyc-document-content.entity';
import { KycDocumentType, KycDocumentVariant, KycStatus, UserRole } from '../entities/types';
import { AuthUser, OPERATOR_ROLES, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { readSingleFile } from '../utils/upload';
import {
  assertQuota,
  assertUploadAllowed,
  evaluateChecklist,
  readDocumentContent,
  sha256Hex,
} from '../services/kyc.service';
import { describeKycPolicy, getKycPolicy, kycPolicyChecksum } from '../services/kyc-policy.service';
import { writeAudit } from '../services/audit.service';
import { getDataSource } from '../datasource';

const REVIEW_ROLES = [UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN];

const router = Router({ mergeParams: true });
router.use(requireAuth);

const documentBodySchema = z.object({
  documentType: z.enum([
    KycDocumentType.NATIONAL_ID,
    KycDocumentType.ID_CARD,
    KycDocumentType.PASSPORT,
    KycDocumentType.FAMILY_BOOK,
    KycDocumentType.SELFIE_WITH_ID,
    KycDocumentType.SIGNATURE,
  ]),
  variant: z
    .enum([KycDocumentVariant.MAIN, KycDocumentVariant.FRONT, KycDocumentVariant.BACK])
    .optional(),
  issuedAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
    .optional(),
  expiresAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
    .optional(),
  note: z.string().max(1000).optional(),
});

const rejectSchema = z.object({
  reason: z.string().min(1, 'Rejection reason is required').max(1000),
});

const verifySchema = z.object({
  note: z.string().max(1000).optional(),
});

async function loadCustomer(em: EntityManager, customerId: string, lock: boolean): Promise<Customer> {
  const customer = lock
    ? await em.findOne(Customer, { where: { id: customerId }, lock: { mode: 'pessimistic_write' } })
    : await em.findOne(Customer, { where: { id: customerId } });
  if (!customer) throw notFound('Customer');
  return customer;
}

function customerIdOf(req: Request): string {
  const customerId = (req.params as Record<string, string>).customerId;
  if (!customerId) throw badRequest('Missing customerId');
  return customerId;
}

/** Response payload shared by every KYC mutation, so the UI never re-guesses state. */
async function kycState(em: EntityManager, customer: Customer) {
  const [documents, policy] = await Promise.all([
    em.find(KycDocument, { where: { customerId: customer.id }, order: { createdAt: 'ASC' } }),
    getKycPolicy(em),
  ]);
  return {
    customer: {
      id: customer.id,
      customerNumber: customer.customerNumber,
      fullName: customer.fullName,
      nationalId: customer.nationalId,
      kycStatus: customer.kycStatus,
      kycSubmittedBy: customer.kycSubmittedBy,
      kycSubmittedAt: customer.kycSubmittedAt,
      kycReviewedBy: customer.kycReviewedBy,
      kycReviewedAt: customer.kycReviewedAt,
      kycRejectionReason: customer.kycRejectionReason,
      kycAppliedPolicy: customer.kycAppliedPolicy,
    },
    documents,
    policy,
    checklist: evaluateChecklist(documents, policy),
  };
}

/** A changed evidence set is no longer the set that was verified. */
async function touchKycStatusAfterChange(
  em: EntityManager,
  customer: Customer,
  user: AuthUser,
  action: string,
  ip?: string | null,
  userAgent?: string | null,
): Promise<void> {
  const policy = await getKycPolicy(em);
  if (customer.kycStatus !== KycStatus.VERIFIED || !policy.reverifyOnDocumentChange) return;
  customer.kycStatus = KycStatus.PENDING;
  await em.save(Customer, customer);
  await writeAudit(em, {
    action: 'KYC_REVERIFY_REQUIRED',
    customerId: customer.id,
    userId: user.id,
    previousStatus: KycStatus.VERIFIED,
    newStatus: KycStatus.PENDING,
    reason: `${action} changed the verified evidence set`,
    ip,
    userAgent,
  });
}

router.get(
  '/documents',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const customer = await loadCustomer(em, customerIdOf(req), false);
    res.json({ data: await kycState(em, customer) });
  })
);

/** Raw bytes for one document — the UI fetches this with the auth header and shows an <img>. */
router.get(
  '/documents/:documentId/content',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const documentId = (req.params as Record<string, string>).documentId;
    const doc = await em.findOne(KycDocument, { where: { id: documentId, customerId: customerIdOf(req) } });
    if (!doc) throw notFound('KYC document');
    const data = await readDocumentContent(em, doc.id);
    if (!data) throw notFound('KYC document content');

    const safeName = doc.fileName.replace(/[^\w.\- ]/g, '').slice(0, 100) || 'kyc-image';
    res.set('Content-Type', doc.mimeType);
    res.set('Content-Disposition', `inline; filename="${safeName}"`);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(data);
  })
);

router.post(
  '/documents',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const customerId = customerIdOf(req);
    const dataSource = getDataSource();

    const policy = await getKycPolicy(dataSource.manager);
    const file = await readSingleFile(req, res, policy.maxFileSizeKb, policy.maxFilesPerRequest);
    const body = documentBodySchema.parse(req.body);

    const result = await dataSource.transaction(async (em) => {
      const customer = await loadCustomer(em, customerId, true);
      const detected = assertUploadAllowed(policy, file.buffer, body.documentType);

      const checksum = sha256Hex(file.buffer);
      const duplicate = await em.findOne(KycDocument, { where: { customerId, checksum } });
      if (duplicate) {
        throw conflict(`This exact image is already uploaded as ${duplicate.documentType} — delete it first to re-upload`);
      }

      await assertQuota(em, policy, customerId, file.buffer.length);

      const issuedAt = body.issuedAt ? new Date(`${body.issuedAt}T00:00:00Z`) : null;
      const expiresAt = body.expiresAt ? new Date(`${body.expiresAt}T00:00:00Z`) : null;
      const now = new Date();
      if (issuedAt && issuedAt.getTime() > now.getTime()) {
        throw unprocessable('issuedAt cannot be in the future');
      }
      if (issuedAt && expiresAt && expiresAt.getTime() <= issuedAt.getTime()) {
        throw unprocessable('expiresAt must be after issuedAt');
      }

      const doc = em.create(KycDocument, {
        customerId,
        documentType: body.documentType,
        variant: body.variant ?? KycDocumentVariant.MAIN,
        fileName: file.originalname.slice(0, 255),
        mimeType: detected.mimeType,
        sizeBytes: file.buffer.length,
        checksum,
        issuedAt,
        expiresAt,
        note: body.note ?? null,
        uploadedBy: user.id,
      });
      await em.save(KycDocument, doc);
      await em.save(KycDocumentContent, em.create(KycDocumentContent, { documentId: doc.id, data: file.buffer }));

      await writeAudit(em, {
        action: 'KYC_DOCUMENT_UPLOADED',
        customerId,
        userId: user.id,
        newStatus: customer.kycStatus,
        reason: `${doc.documentType}${doc.variant === KycDocumentVariant.MAIN ? '' : `/${doc.variant}`} ${doc.fileName} (${doc.sizeBytes} bytes, sha256 ${doc.checksum.slice(0, 12)})`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await touchKycStatusAfterChange(em, customer, user, 'Document upload', req.ip, req.headers['user-agent']);
      return kycState(em, customer);
    });

    res.status(201).json({ data: result });
  })
);

router.delete(
  '/documents/:documentId',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const customerId = customerIdOf(req);
    const documentId = (req.params as Record<string, string>).documentId;

    const result = await getDataSource().transaction(async (em) => {
      const customer = await loadCustomer(em, customerId, true);
      const doc = await em.findOne(KycDocument, { where: { id: documentId, customerId } });
      if (!doc) throw notFound('KYC document');
      if (doc.uploadedBy !== user.id && user.role !== UserRole.ADMIN) {
        throw forbidden('Only the uploader or an ADMIN can delete a KYC document');
      }

      await em.delete(KycDocumentContent, { documentId: doc.id });
      await em.delete(KycDocument, { id: doc.id });

      await writeAudit(em, {
        action: 'KYC_DOCUMENT_DELETED',
        customerId,
        userId: user.id,
        previousStatus: customer.kycStatus,
        reason: `Deleted ${doc.documentType} ${doc.fileName}`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      await touchKycStatusAfterChange(em, customer, user, 'Document deletion', req.ip, req.headers['user-agent']);
      return kycState(em, customer);
    });

    res.json({ data: result });
  })
);

router.post(
  '/submit',
  requireRole(...OPERATOR_ROLES),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;

    const result = await getDataSource().transaction(async (em) => {
      const customer = await loadCustomer(em, customerIdOf(req), true);
      if (customer.kycStatus === KycStatus.VERIFIED) {
        throw unprocessable('KYC is already VERIFIED — reopen it first to change the review');
      }
      if (customer.kycStatus === KycStatus.PENDING) {
        throw unprocessable('KYC is already pending review');
      }
      const previousStatus = customer.kycStatus;

      const [documents, policy] = await Promise.all([
        em.find(KycDocument, { where: { customerId: customer.id } }),
        getKycPolicy(em),
      ]);
      const checklist = evaluateChecklist(documents, policy);
      if (!checklist.satisfied) {
        throw unprocessable(
          `KYC checklist is incomplete — missing: ${[...checklist.missing, ...checklist.expired.map((t) => `${t} (expired)`)].join(', ')}`,
        );
      }

      customer.kycStatus = KycStatus.PENDING;
      customer.kycSubmittedBy = user.id;
      customer.kycSubmittedAt = new Date();
      customer.kycRejectionReason = null;
      await em.save(Customer, customer);

      await writeAudit(em, {
        action: 'KYC_SUBMITTED',
        customerId: customer.id,
        userId: user.id,
        previousStatus,
        newStatus: KycStatus.PENDING,
        makerUserId: user.id,
        reason: `Submitted for verification under policy ${kycPolicyChecksum(policy)} (${describeKycPolicy(policy)})`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return kycState(em, customer);
    });

    res.json({ data: result });
  })
);

/**
 * Maker-checker separation for KYC: the reviewer may not be the submitter and may not
 * be anyone who supplied the evidence being approved.
 */
async function assertIndependentReviewer(
  customer: Customer,
  documents: KycDocument[],
  user: AuthUser,
): Promise<void> {
  if (customer.kycSubmittedBy === user.id) {
    throw unprocessable('Maker-Checker separation: you submitted this KYC and cannot verify it');
  }
  const uploaders = new Set(documents.map((d) => d.uploadedBy));
  if (uploaders.has(user.id)) {
    throw unprocessable('Maker-Checker separation: you uploaded one of these documents and cannot verify them');
  }
}

router.post(
  '/verify',
  requireRole(...REVIEW_ROLES),
  validateBody(verifySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { note } = req.body as { note?: string };

    const result = await getDataSource().transaction(async (em) => {
      const customer = await loadCustomer(em, customerIdOf(req), true);
      if (customer.kycStatus !== KycStatus.PENDING) {
        throw unprocessable(`KYC is ${customer.kycStatus} — only PENDING KYC can be verified`);
      }

      const [documents, policy] = await Promise.all([
        em.find(KycDocument, { where: { customerId: customer.id } }),
        getKycPolicy(em),
      ]);
      const checklist = evaluateChecklist(documents, policy);
      if (!checklist.satisfied) {
        throw unprocessable(
          `KYC checklist is not satisfied under the current policy — missing: ${[
            ...checklist.missing,
            ...checklist.expired.map((t) => `${t} (expired)`),
          ].join(', ')}`,
        );
      }
      await assertIndependentReviewer(customer, documents, user);

      customer.kycStatus = KycStatus.VERIFIED;
      customer.kycReviewedBy = user.id;
      customer.kycReviewedAt = new Date();
      customer.kycRejectionReason = null;
      customer.kycAppliedPolicy = policy;
      await em.save(Customer, customer);

      await writeAudit(em, {
        action: 'KYC_VERIFIED',
        customerId: customer.id,
        userId: user.id,
        previousStatus: KycStatus.PENDING,
        newStatus: KycStatus.VERIFIED,
        makerUserId: customer.kycSubmittedBy,
        checkerUserId: user.id,
        reason: `Verified under policy ${kycPolicyChecksum(policy)} (${describeKycPolicy(policy)})${note ? ` — ${note}` : ''}`,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return kycState(em, customer);
    });

    res.json({ data: result });
  })
);

router.post(
  '/reject',
  requireRole(...REVIEW_ROLES),
  validateBody(rejectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body as { reason: string };

    const result = await getDataSource().transaction(async (em) => {
      const customer = await loadCustomer(em, customerIdOf(req), true);
      if (customer.kycStatus !== KycStatus.PENDING) {
        throw unprocessable(`KYC is ${customer.kycStatus} — only PENDING KYC can be rejected`);
      }
      const documents = await em.find(KycDocument, { where: { customerId: customer.id } });
      await assertIndependentReviewer(customer, documents, user);

      customer.kycStatus = KycStatus.REJECTED;
      customer.kycReviewedBy = user.id;
      customer.kycReviewedAt = new Date();
      customer.kycRejectionReason = reason;
      await em.save(Customer, customer);

      await writeAudit(em, {
        action: 'KYC_REJECTED',
        customerId: customer.id,
        userId: user.id,
        previousStatus: KycStatus.PENDING,
        newStatus: KycStatus.REJECTED,
        makerUserId: customer.kycSubmittedBy,
        checkerUserId: user.id,
        reason,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return kycState(em, customer);
    });

    res.json({ data: result });
  })
);

/** ADMIN-only rollback when the policy or the evidence turns out to be wrong after approval. */
router.post(
  '/reopen',
  requireRole(UserRole.ADMIN),
  validateBody(rejectSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as AuthUser;
    const { reason } = req.body as { reason: string };

    const result = await getDataSource().transaction(async (em) => {
      const customer = await loadCustomer(em, customerIdOf(req), true);
      if (customer.kycStatus !== KycStatus.VERIFIED) {
        throw unprocessable(`KYC is ${customer.kycStatus} — only VERIFIED KYC can be reopened`);
      }

      customer.kycStatus = KycStatus.PENDING;
      customer.kycRejectionReason = null;
      await em.save(Customer, customer);

      await writeAudit(em, {
        action: 'KYC_REOPENED',
        customerId: customer.id,
        userId: user.id,
        previousStatus: KycStatus.VERIFIED,
        newStatus: KycStatus.PENDING,
        checkerUserId: user.id,
        reason,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return kycState(em, customer);
    });

    res.json({ data: result });
  })
);

export default router;
