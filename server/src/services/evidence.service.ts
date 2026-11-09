import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { CustomerBankAccount } from '../entities/customer-bank-account.entity';
import { EvidenceDocument } from '../entities/evidence-document.entity';
import { EvidenceDocumentContent } from '../entities/evidence-document-content.entity';
import { Loan } from '../entities/loan.entity';
import { EvidenceKind, EvidenceOwnerType, EvidencePolicy, UserRole } from '../entities/types';
import { conflict, AppError, forbidden, notFound, unprocessable } from '../utils/errors';
import { detectImage, sha256Hex } from './kyc.service';
import { writeAudit } from './audit.service';

/**
 * The filing desk for money evidence: a bank-account proof filed against a customer, a transfer slip or
 * cash receipt filed against a loan. It reuses the KYC upload primitives (magic-byte sniffing, SHA-256,
 * quota) because they are the same problem — an untrusted image that has to stay immutable evidence —
 * but keeps its own table so a slip can never move a customer's KYC status.
 */

/** Which kind of evidence a given owner may hold; a slip about money is never filed under a person. */
const KIND_OWNER: Record<EvidenceKind, EvidenceOwnerType> = {
  [EvidenceKind.BANK_ACCOUNT_PROOF]: EvidenceOwnerType.CUSTOMER,
  [EvidenceKind.DISBURSEMENT_SLIP]: EvidenceOwnerType.LOAN,
};

const OWNER_LABEL: Record<EvidenceOwnerType, string> = {
  [EvidenceOwnerType.CUSTOMER]: 'customer',
  [EvidenceOwnerType.LOAN]: 'loan',
};

type DetectedImage = { mimeType: string; extension: string };

export function assertEvidenceAllowed(policy: EvidencePolicy, buffer: Buffer): DetectedImage {
  const detected = detectImage(buffer);
  if (!detected) {
    throw new AppError(415, 'Only image uploads are accepted for evidence documents');
  }
  if (!policy.allowedMimeTypes.includes(detected.mimeType)) {
    throw new AppError(
      415,
      `Image type ${detected.mimeType} is not allowed (allowed: ${policy.allowedMimeTypes.join(', ')})`,
    );
  }
  if (buffer.length > policy.maxFileSizeKb * 1024) {
    throw unprocessable(
      `File is too large (${buffer.length} bytes). Current limit is ${policy.maxFileSizeKb} KB per evidence image.`,
    );
  }
  return detected;
}

export async function storedBytesForOwner(
  em: EntityManager,
  ownerType: EvidenceOwnerType,
  ownerId: string,
): Promise<number> {
  const rows = await em
    .createQueryBuilder(EvidenceDocument, 'doc')
    .select('COALESCE(SUM(doc.sizeBytes), 0)', 'total')
    .where('doc.ownerType = :ownerType', { ownerType })
    .andWhere('doc.ownerId = :ownerId', { ownerId })
    .getRawOne<{ total: string }>();
  return Number(rows?.total ?? 0);
}

export async function assertOwnerQuota(
  em: EntityManager,
  policy: EvidencePolicy,
  ownerType: EvidenceOwnerType,
  ownerId: string,
  incomingBytes: number,
): Promise<void> {
  const used = await storedBytesForOwner(em, ownerType, ownerId);
  if (used + incomingBytes > policy.maxTotalBytesPerOwner) {
    throw unprocessable(
      `Evidence storage quota reached for this ${OWNER_LABEL[ownerType]} (${used + incomingBytes} of ` +
        `${policy.maxTotalBytesPerOwner} bytes). Delete an old document first.`,
    );
  }
}

async function assertOwnerExists(em: EntityManager, ownerType: EvidenceOwnerType, ownerId: string): Promise<void> {
  const found =
    ownerType === EvidenceOwnerType.CUSTOMER
      ? await em.findOne(Customer, { where: { id: ownerId } })
      : await em.findOne(Loan, { where: { id: ownerId } });
  if (!found) throw notFound(OWNER_LABEL[ownerType]);
}

export interface RecordEvidenceInput {
  ownerType: EvidenceOwnerType;
  ownerId: string;
  kind: EvidenceKind;
  bankAccountId?: string | null;
  note?: string | null;
  buffer: Buffer;
  fileName: string;
  policy: EvidencePolicy;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Files one piece of evidence. The row is written with the bytes and its audit entry in the caller's
 * transaction, so a half-filed document — metadata without bytes, or bytes nobody recorded — cannot
 * exist in the database.
 */
export async function recordEvidence(em: EntityManager, input: RecordEvidenceInput): Promise<EvidenceDocument> {
  const expectedOwner = KIND_OWNER[input.kind];
  if (input.ownerType !== expectedOwner) {
    throw unprocessable(
      `${input.kind} is filed under a ${expectedOwner}, not under a ${OWNER_LABEL[input.ownerType]}`,
    );
  }
  await assertOwnerExists(em, input.ownerType, input.ownerId);

  let bankAccountId: string | null = null;
  if (input.kind === EvidenceKind.BANK_ACCOUNT_PROOF) {
    if (!input.bankAccountId) {
      throw unprocessable('A bank account proof has to name the account it documents');
    }
    const account = await em.findOne(CustomerBankAccount, {
      where: { id: input.bankAccountId, customerId: input.ownerId },
    });
    if (!account) throw notFound('Bank account of this customer');
    bankAccountId = account.id;
  } else if (input.bankAccountId) {
    throw unprocessable('A disbursement slip belongs to the loan, not to one of the customer accounts');
  }

  const detected = assertEvidenceAllowed(input.policy, input.buffer);
  const checksum = sha256Hex(input.buffer);
  const duplicate = await em.findOne(EvidenceDocument, {
    where: { ownerType: input.ownerType, ownerId: input.ownerId, checksum },
  });
  if (duplicate) {
    throw conflict(
      `This exact image is already filed here as ${duplicate.kind} — delete it first to re-upload`,
    );
  }

  await assertOwnerQuota(em, input.policy, input.ownerType, input.ownerId, input.buffer.length);

  const doc = em.create(EvidenceDocument, {
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    kind: input.kind,
    bankAccountId,
    fileName: input.fileName.slice(0, 255),
    mimeType: detected.mimeType,
    sizeBytes: input.buffer.length,
    checksum,
    note: input.note ?? null,
    uploadedBy: input.userId,
  });
  await em.save(EvidenceDocument, doc);
  await em.save(
    EvidenceDocumentContent,
    em.create(EvidenceDocumentContent, { documentId: doc.id, data: input.buffer }),
  );

  await writeAudit(em, {
    action: 'EVIDENCE_UPLOADED',
    customerId: input.ownerType === EvidenceOwnerType.CUSTOMER ? input.ownerId : null,
    loanId: input.ownerType === EvidenceOwnerType.LOAN ? input.ownerId : null,
    userId: input.userId,
    reason: `${doc.kind} ${doc.fileName} (${doc.sizeBytes} bytes, sha256 ${doc.checksum.slice(0, 12)}) filed on ${OWNER_LABEL[doc.ownerType]} ${input.ownerId}`,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return doc;
}

export interface DeleteEvidenceInput {
  documentId: string;
  userId: string;
  role: UserRole;
  ip?: string | null;
  userAgent?: string | null;
}

/** Evidence is immutable, so "replace a scan" is a delete plus a new upload — never an overwrite. */
export async function deleteEvidence(em: EntityManager, input: DeleteEvidenceInput): Promise<EvidenceDocument> {
  const doc = await em.findOne(EvidenceDocument, { where: { id: input.documentId } });
  if (!doc) throw notFound('Evidence document');
  if (doc.uploadedBy !== input.userId && input.role !== UserRole.ADMIN) {
    throw forbidden('Only the uploader or an ADMIN can delete an evidence document');
  }

  await em.delete(EvidenceDocumentContent, { documentId: doc.id });
  await em.delete(EvidenceDocument, { id: doc.id });

  await writeAudit(em, {
    action: 'EVIDENCE_DELETED',
    customerId: doc.ownerType === EvidenceOwnerType.CUSTOMER ? doc.ownerId : null,
    loanId: doc.ownerType === EvidenceOwnerType.LOAN ? doc.ownerId : null,
    userId: input.userId,
    reason: `Deleted ${doc.kind} ${doc.fileName} from ${OWNER_LABEL[doc.ownerType]} ${doc.ownerId}`,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return doc;
}

export function findEvidence(
  em: EntityManager,
  params: { ownerType: EvidenceOwnerType; ownerId: string; kind?: EvidenceKind },
): Promise<EvidenceDocument[]> {
  return em.find(EvidenceDocument, {
    where: {
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      ...(params.kind ? { kind: params.kind } : {}),
    },
    order: { createdAt: 'ASC' },
  });
}

/** Every proof filed against one account of one customer. */
export function findEvidenceForAccount(em: EntityManager, customerId: string): Promise<EvidenceDocument[]> {
  return em.find(EvidenceDocument, {
    where: { ownerType: EvidenceOwnerType.CUSTOMER, ownerId: customerId, kind: EvidenceKind.BANK_ACCOUNT_PROOF },
    order: { createdAt: 'ASC' },
  });
}

/** Content bytes for one document — separated so list queries stay light. */
export async function readEvidenceContent(em: EntityManager, documentId: string): Promise<Buffer | null> {
  const content = await em.findOne(EvidenceDocumentContent, { where: { documentId } });
  return content ? content.data : null;
}

export { KIND_OWNER, OWNER_LABEL };
