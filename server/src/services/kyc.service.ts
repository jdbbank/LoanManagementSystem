import { createHash } from 'crypto';
import { EntityManager } from 'typeorm';
import { KycDocument } from '../entities/kyc-document.entity';
import { KycDocumentContent } from '../entities/kyc-document-content.entity';
import { KycDocumentType, KycPolicy } from '../entities/types';
import { AppError, unprocessable } from '../utils/errors';

/**
 * A checklist requirement is expressed as a code so the UI can translate it;
 * IDENTITY_DOCUMENT means "at least one document of the required identity types".
 */
export type KycChecklistCode = 'IDENTITY_DOCUMENT' | KycDocumentType;

export interface KycChecklistResult {
  satisfied: boolean;
  missing: KycChecklistCode[];
  expired: KycDocumentType[];
  expiringSoon: KycDocumentType[];
}

type DetectedImage = { mimeType: string; extension: string };

/**
 * Real content check by magic bytes — the mime type the client sends is untrusted,
 * and only images are allowed (no PDF, no scripts renamed to .jpg).
 */
export function detectImage(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export const sha256Hex = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

/**
 * Validates an uploaded buffer against the live policy.
 * Returns the detected image info, or throws the API error to surface.
 */
export function assertUploadAllowed(
  policy: KycPolicy,
  buffer: Buffer,
  documentType: KycDocumentType,
): DetectedImage {
  if (!policy.allowedDocumentTypes.includes(documentType)) {
    throw unprocessable(`Document type ${documentType} is disabled by the KYC policy`);
  }
  const detected = detectImage(buffer);
  if (!detected) {
    throw new AppError(415, 'Only image uploads are accepted for KYC documents');
  }
  if (!policy.allowedMimeTypes.includes(detected.mimeType)) {
    throw new AppError(415, `Image type ${detected.mimeType} is not allowed (allowed: ${policy.allowedMimeTypes.join(', ')})`);
  }
  if (buffer.length > policy.maxFileSizeKb * 1024) {
    throw unprocessable(
      `File is too large (${buffer.length} bytes). Current limit is ${policy.maxFileSizeKb} KB per document.`,
    );
  }
  return detected;
}

export async function storedBytesForCustomer(em: EntityManager, customerId: string): Promise<number> {
  const rows = await em
    .createQueryBuilder(KycDocument, 'doc')
    .select('COALESCE(SUM(doc.sizeBytes), 0)', 'total')
    .where('doc.customerId = :customerId', { customerId })
    .getRawOne<{ total: string }>();
  return Number(rows?.total ?? 0);
}

export async function assertQuota(
  em: EntityManager,
  policy: KycPolicy,
  customerId: string,
  incomingBytes: number,
): Promise<void> {
  const used = await storedBytesForCustomer(em, customerId);
  if (used + incomingBytes > policy.maxTotalBytesPerCustomer) {
    throw unprocessable(
      `KYC storage quota reached for this customer (${used + incomingBytes} of ${policy.maxTotalBytesPerCustomer} bytes). Delete an old document first.`,
    );
  }
}

function startOfToday(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - startOfToday(now)) / 86_400_000);
}

export function evaluateChecklist(
  documents: KycDocument[],
  policy: KycPolicy,
  now = new Date(),
): KycChecklistResult {
  const present = new Set(documents.map((d) => d.documentType));
  const missing: KycChecklistCode[] = [];

  if (!policy.requiredIdentityTypes.some((t) => present.has(t))) {
    missing.push('IDENTITY_DOCUMENT');
  }
  if (policy.requireSelfieWithId && !present.has(KycDocumentType.SELFIE_WITH_ID)) {
    missing.push(KycDocumentType.SELFIE_WITH_ID);
  }
  if (policy.requireSignature && !present.has(KycDocumentType.SIGNATURE)) {
    missing.push(KycDocumentType.SIGNATURE);
  }
  if (policy.requireFamilyBook && !present.has(KycDocumentType.FAMILY_BOOK)) {
    missing.push(KycDocumentType.FAMILY_BOOK);
  }

  const expired: KycDocumentType[] = [];
  const expiringSoon: KycDocumentType[] = [];
  for (const doc of documents) {
    if (!doc.expiresAt) continue;
    const days = daysUntil(new Date(doc.expiresAt), now);
    if (days < 0) expired.push(doc.documentType);
    else if (days <= policy.expiryWarningDays) expiringSoon.push(doc.documentType);
  }

  return {
    satisfied: missing.length === 0 && (policy.acceptExpiredDocuments || expired.length === 0),
    missing,
    expired: policy.acceptExpiredDocuments ? [] : expired,
    expiringSoon,
  };
}

/** Content bytes for one document — separated so list queries stay light. */
export async function readDocumentContent(em: EntityManager, documentId: string): Promise<Buffer | null> {
  const content = await em.findOne(KycDocumentContent, { where: { documentId } });
  return content ? content.data : null;
}
