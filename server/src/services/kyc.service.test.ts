import { describe, expect, it } from 'vitest';
import { KycDocumentType, type KycPolicy } from '../entities/types';
import { AppError } from '../utils/errors';
import {
  assertUploadAllowed,
  detectImage,
  evaluateChecklist,
  sha256Hex,
} from './kyc.service';

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4, 5,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([10, 0, 0, 0]),
  Buffer.from('WEBP', 'latin1'),
  Buffer.from([1, 2, 3, 4, 5]),
]);
const PDF_DISGUISED = Buffer.concat([Buffer.from('%PDF-1.4', 'latin1'), Buffer.alloc(200)]);

const policy: KycPolicy = {
  maxFileSizeKb: 10,
  maxFilesPerRequest: 1,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  allowedDocumentTypes: Object.values(KycDocumentType),
  requiredIdentityTypes: [KycDocumentType.NATIONAL_ID, KycDocumentType.PASSPORT],
  requireSelfieWithId: true,
  requireSignature: true,
  requireFamilyBook: false,
  acceptExpiredDocuments: false,
  expiryWarningDays: 30,
  maxTotalBytesPerCustomer: 31_457_280,
  blockDisbursementUntilVerified: true,
  reverifyOnDocumentChange: true,
};

const doc = (documentType: KycDocumentType, expiresAt: Date | null = null) =>
  ({ documentType, expiresAt }) as never;

const NOW = new Date('2026-01-15T00:00:00Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

describe('detectImage', () => {
  it('recognises real images by magic bytes, not by the name', () => {
    expect(detectImage(PNG)?.mimeType).toBe('image/png');
    expect(detectImage(JPEG)?.mimeType).toBe('image/jpeg');
    expect(detectImage(WEBP)?.mimeType).toBe('image/webp');
  });

  it('rejects a PDF renamed to .jpg and truncated buffers', () => {
    expect(detectImage(PDF_DISGUISED)).toBeNull();
    expect(detectImage(Buffer.from([0x89, 0x50]))).toBeNull();
  });
});

describe('assertUploadAllowed', () => {
  it('accepts an allowed image type', () => {
    expect(assertUploadAllowed(policy, PNG, KycDocumentType.NATIONAL_ID).mimeType).toBe('image/png');
  });

  it('refuses anything that is not an image with 415', () => {
    const error = (() => {
      try {
        assertUploadAllowed(policy, PDF_DISGUISED, KycDocumentType.NATIONAL_ID);
        return null;
      } catch (e) {
        return e as AppError;
      }
    })();
    expect(error?.status).toBe(415);
  });

  it('refuses an image format the policy does not list', () => {
    expect(() =>
      assertUploadAllowed({ ...policy, allowedMimeTypes: ['image/jpeg'] }, PNG, KycDocumentType.NATIONAL_ID),
    ).toThrow(AppError);
  });

  it('refuses a file above the configured size limit', () => {
    const big = Buffer.concat([PNG, Buffer.alloc(policy.maxFileSizeKb * 1024 + 1)]);
    expect(() => assertUploadAllowed(policy, big, KycDocumentType.NATIONAL_ID)).toThrow(
      /Current limit is 10 KB/,
    );
  });

  it('refuses a document type disabled by the policy', () => {
    expect(() =>
      assertUploadAllowed(
        { ...policy, allowedDocumentTypes: [KycDocumentType.NATIONAL_ID] },
        PNG,
        KycDocumentType.PASSPORT,
      ),
    ).toThrow(/disabled by the KYC policy/);
  });
});

describe('evaluateChecklist', () => {
  it('accepts any one of the required identity types', () => {
    expect(
      evaluateChecklist(
        [doc(KycDocumentType.PASSPORT), doc(KycDocumentType.SELFIE_WITH_ID), doc(KycDocumentType.SIGNATURE)],
        policy,
        NOW,
      ).satisfied,
    ).toBe(true);
  });

  it('reports every missing requirement', () => {
    const result = evaluateChecklist([doc(KycDocumentType.NATIONAL_ID)], policy, NOW);
    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual([KycDocumentType.SELFIE_WITH_ID, KycDocumentType.SIGNATURE]);
  });

  it('reports IDENTITY_DOCUMENT when none of the required identity types is present', () => {
    const result = evaluateChecklist(
      [doc(KycDocumentType.FAMILY_BOOK), doc(KycDocumentType.SELFIE_WITH_ID), doc(KycDocumentType.SIGNATURE)],
      policy,
      NOW,
    );
    expect(result.missing).toContain('IDENTITY_DOCUMENT');
  });

  it('ignores optional evidence when the corresponding switch is off', () => {
    const relaxed: KycPolicy = {
      ...policy,
      requireSelfieWithId: false,
      requireSignature: false,
      requireFamilyBook: false,
    };
    expect(
      evaluateChecklist([doc(KycDocumentType.NATIONAL_ID)], relaxed, NOW).satisfied,
    ).toBe(true);
  });

  it('fails on an expired document unless the policy accepts expiry', () => {
    const documents = [
      doc(KycDocumentType.NATIONAL_ID, daysFromNow(-1)),
      doc(KycDocumentType.SELFIE_WITH_ID),
      doc(KycDocumentType.SIGNATURE),
    ];
    expect(evaluateChecklist(documents, policy, NOW).expired).toEqual([KycDocumentType.NATIONAL_ID]);
    const accepted = evaluateChecklist(documents, { ...policy, acceptExpiredDocuments: true }, NOW);
    expect(accepted.satisfied).toBe(true);
    expect(accepted.expired).toEqual([]);
  });

  it('warns about documents expiring inside the warning window', () => {
    const result = evaluateChecklist(
      [
        doc(KycDocumentType.NATIONAL_ID, daysFromNow(10)),
        doc(KycDocumentType.SELFIE_WITH_ID),
        doc(KycDocumentType.SIGNATURE),
      ],
      policy,
      NOW,
    );
    expect(result.satisfied).toBe(true);
    expect(result.expiringSoon).toEqual([KycDocumentType.NATIONAL_ID]);
  });
});

describe('sha256Hex', () => {
  it('is stable and distinguishes different images', () => {
    expect(sha256Hex(PNG)).toBe(sha256Hex(Buffer.from(PNG)));
    expect(sha256Hex(PNG)).not.toBe(sha256Hex(JPEG));
  });
});
