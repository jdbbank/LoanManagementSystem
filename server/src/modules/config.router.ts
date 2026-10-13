import { Router } from 'express';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { SystemConfig } from '../entities/system-config.entity';
import { KycDocumentType, UserRole } from '../entities/types';
import { writeAudit } from '../services/audit.service';
import {
  CONFIG_CHECKER_THRESHOLD,
  CONFIG_HEAD_THRESHOLD,
  getThresholds,
} from '../services/approval.service';
import {
  DEFAULT_KYC_POLICY,
  describeKycPolicy,
  getKycPolicy,
  kycPolicyChecksum,
  updateKycPolicy,
} from '../services/kyc-policy.service';
import {
  DEFAULT_PASSWORD_POLICY,
  describePasswordPolicy,
  getPasswordPolicy,
  passwordPolicyChecksum,
  updatePasswordPolicy,
} from '../services/password-policy.service';
import { DEFAULT_AVATAR_POLICY, getAvatarPolicy, updateAvatarPolicy } from '../services/avatar-policy.service';
import { authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { badRequest } from '../utils/errors';

const router = Router();
router.use(authMiddleware);

router.get(
  '/thresholds',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const thresholds = await getThresholds(getDataSource().manager);
    res.json(thresholds);
  }),
);

const updateThresholdsSchema = z.object({
  checkerThreshold: z.number().positive(),
  headThreshold: z.number().positive(),
});

router.put(
  '/thresholds',
  requireRole(UserRole.ADMIN),
  validateBody(updateThresholdsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateThresholdsSchema>;
    if (body.headThreshold < body.checkerThreshold) {
      throw badRequest('Head threshold must be greater than or equal to the checker threshold');
    }
    const em = getDataSource().manager;
    const previous = await getThresholds(em);

    const upsert = async (key: string, value: number, description: string) => {
      const existing = await em.findOne(SystemConfig, { where: { key } });
      if (existing) {
        existing.value = value;
        existing.updatedBy = req.user!.id;
        existing.description = description;
        await em.save(SystemConfig, existing);
      } else {
        await em.save(SystemConfig, em.create(SystemConfig, { key, value, updatedBy: req.user!.id, description }));
      }
    };
    await upsert(CONFIG_CHECKER_THRESHOLD, body.checkerThreshold, 'Amounts at or below this need Maker -> Checker only');
    await upsert(CONFIG_HEAD_THRESHOLD, body.headThreshold, 'Amounts above this also need Head and Admin final approval');

    await writeAudit(em, {
      action: 'CONFIG_UPDATED',
      userId: req.user!.id,
      reason: `Approval thresholds updated: checker ${previous.checkerThreshold} -> ${body.checkerThreshold}, head ${previous.headThreshold} -> ${body.headThreshold}`,
      previousStatus: `checker=${previous.checkerThreshold},head=${previous.headThreshold}`,
      newStatus: `checker=${body.checkerThreshold},head=${body.headThreshold}`,
      ip: req.ip ?? null,
    });

    res.json(await getThresholds(em));
  }),
);

const kycDocumentType = z.enum([
  KycDocumentType.NATIONAL_ID,
  KycDocumentType.ID_CARD,
  KycDocumentType.PASSPORT,
  KycDocumentType.FAMILY_BOOK,
  KycDocumentType.SELFIE_WITH_ID,
  KycDocumentType.SIGNATURE,
]);

const updateKycSchema = z.object({
  maxFileSizeKb: z.number().int().min(1).max(102_400).optional(),
  maxFilesPerRequest: z.number().int().min(1).max(10).optional(),
  allowedMimeTypes: z.array(z.string().min(4)).min(1).optional(),
  allowedDocumentTypes: z.array(kycDocumentType).min(1).optional(),
  requiredIdentityTypes: z.array(kycDocumentType).min(1).optional(),
  requireSelfieWithId: z.boolean().optional(),
  requireSignature: z.boolean().optional(),
  requireFamilyBook: z.boolean().optional(),
  acceptExpiredDocuments: z.boolean().optional(),
  expiryWarningDays: z.number().int().min(0).max(3650).optional(),
  maxTotalBytesPerCustomer: z.number().int().min(1).optional(),
  blockDisbursementUntilVerified: z.boolean().optional(),
  reverifyOnDocumentChange: z.boolean().optional(),
});

/** Live KYC policy plus the env-level defaults, so the UI can show both. */
router.get(
  '/kyc',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getKycPolicy(getDataSource().manager);
    res.json({ data: { policy, defaults: DEFAULT_KYC_POLICY, checksum: kycPolicyChecksum(policy) } });
  }),
);

router.put(
  '/kyc',
  requireRole(UserRole.ADMIN),
  validateBody(updateKycSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateKycSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updateKycPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        // Status columns are short codes; the full before/after policy goes into reason.
        previousStatus: kycPolicyChecksum(updated.previous),
        newStatus: kycPolicyChecksum(updated.updated),
        reason: `KYC policy ${describeKycPolicy(updated.previous)}  ->  ${describeKycPolicy(updated.updated)}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({ data: { policy: result, defaults: DEFAULT_KYC_POLICY, checksum: kycPolicyChecksum(result) } });
  }),
);

const updatePasswordSchema = z.object({
  minLength: z.number().int().min(4).max(64).optional(),
  maxLength: z.number().int().min(4).max(128).optional(),
  requireDigit: z.boolean().optional(),
  requireUppercase: z.boolean().optional(),
  requireLowercase: z.boolean().optional(),
  requireSymbol: z.boolean().optional(),
});

/** Live password rules plus the env defaults, so the UI can show both. */
router.get(
  '/password',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getPasswordPolicy(getDataSource().manager);
    res.json({
      data: { policy, defaults: DEFAULT_PASSWORD_POLICY, checksum: passwordPolicyChecksum(policy) },
    });
  }),
);

router.put(
  '/password',
  requireRole(UserRole.ADMIN),
  validateBody(updatePasswordSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updatePasswordSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updatePasswordPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        previousStatus: passwordPolicyChecksum(updated.previous),
        newStatus: passwordPolicyChecksum(updated.updated),
        reason: `Password policy ${describePasswordPolicy(updated.previous)}  ->  ${describePasswordPolicy(updated.updated)}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({
      data: { policy: result, defaults: DEFAULT_PASSWORD_POLICY, checksum: passwordPolicyChecksum(result) },
    });
  }),
);

const updateAvatarSchema = z.object({
  enabled: z.boolean().optional(),
  maxFileSizeKb: z.number().int().min(1).max(10_240).optional(),
  allowedMimeTypes: z.array(z.string().min(4)).min(1).optional(),
});

router.get(
  '/avatar',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getAvatarPolicy(getDataSource().manager);
    res.json({ data: { policy, defaults: DEFAULT_AVATAR_POLICY } });
  }),
);

router.put(
  '/avatar',
  requireRole(UserRole.ADMIN),
  validateBody(updateAvatarSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateAvatarSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updateAvatarPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        reason:
          `Avatar policy enabled=${updated.previous.enabled ? '1' : '0'}` +
          `,<=${updated.previous.maxFileSizeKb}KB  ->  enabled=${updated.updated.enabled ? '1' : '0'}` +
          `,<=${updated.updated.maxFileSizeKb}KB`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({ data: { policy: result, defaults: DEFAULT_AVATAR_POLICY } });
  }),
);

export default router;
