import { Router } from 'express';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { KycDocumentType, UserRole } from '../entities/types';
import { writeAudit } from '../services/audit.service';
import {
  ApprovalThresholds,
  MAX_APPROVAL_THRESHOLD,
  getThresholds,
  updateThresholds,
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
import {
  DEFAULT_ACCOUNT_SECURITY_POLICY,
  MAX_FAILED_ATTEMPTS,
  MAX_IDLE_LOCK_DAYS,
  MAX_IDLE_LOCK_POLL_HOURS,
  MAX_PASSWORD_AGE_DAYS,
  MAX_PASSWORD_HISTORY_COUNT,
  accountSecurityPolicyChecksum,
  describeAccountSecurityPolicy,
  getAccountSecurityPolicy,
  updateAccountSecurityPolicy,
} from '../services/account-security-policy.service';
import {
  MAX_COVERAGE_PERCENT,
  MAX_VALUATION_AGE_DAYS,
  DEFAULT_COLLATERAL_POLICY,
  collateralPolicyChecksum,
  describeCollateralPolicy,
  getCollateralPolicy,
  updateCollateralPolicy,
} from '../services/collateral-policy.service';
import {
  DEFAULT_PAYMENT_POLICY,
  MAX_AUTO_DEBIT_LEAD_DAYS,
  describePaymentPolicy,
  getPaymentPolicy,
  paymentPolicyChecksum,
  updatePaymentPolicy,
} from '../services/payment-policy.service';
import {
  MAX_EVIDENCE_FILE_SIZE_KB,
  MAX_EVIDENCE_FILES_PER_REQUEST,
  DEFAULT_EVIDENCE_POLICY,
  describeEvidencePolicy,
  evidencePolicyChecksum,
  getEvidencePolicy,
  updateEvidencePolicy,
} from '../services/evidence-policy.service';
import { sweepIdleLocks } from '../services/account-lock.service';
import { runAutoDebit } from '../services/auto-debit.service';
import { authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';

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
  checkerThreshold: z.number().positive().max(MAX_APPROVAL_THRESHOLD),
  headThreshold: z.number().positive().max(MAX_APPROVAL_THRESHOLD),
});

router.put(
  '/thresholds',
  requireRole(UserRole.ADMIN),
  validateBody(updateThresholdsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as ApprovalThresholds;
    const { updated } = await getDataSource().transaction(async (em) => {
      const written = await updateThresholds(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        reason:
          `Approval thresholds updated: checker ${written.previous.checkerThreshold} -> ${written.updated.checkerThreshold}, ` +
          `head ${written.previous.headThreshold} -> ${written.updated.headThreshold}`,
        previousStatus: `checker=${written.previous.checkerThreshold},head=${written.previous.headThreshold}`,
        newStatus: `checker=${written.updated.checkerThreshold},head=${written.updated.headThreshold}`,
        ip: req.ip ?? null,
      });
      return written;
    });

    res.json(updated);
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

const updateSecuritySchema = z.object({
  maxFailedAttempts: z.number().int().min(0).max(MAX_FAILED_ATTEMPTS).optional(),
  idleLockDays: z.number().int().min(0).max(MAX_IDLE_LOCK_DAYS).optional(),
  idleLockJobEnabled: z.boolean().optional(),
  idleLockPollHours: z.number().int().min(1).max(MAX_IDLE_LOCK_POLL_HOURS).optional(),
  passwordMaxAgeDays: z.number().int().min(0).max(MAX_PASSWORD_AGE_DAYS).optional(),
  passwordExpiryWarnDays: z.number().int().min(0).max(MAX_PASSWORD_AGE_DAYS).optional(),
  passwordHistoryCount: z.number().int().min(0).max(MAX_PASSWORD_HISTORY_COUNT).optional(),
  applyToAdminAccounts: z.boolean().optional(),
});

/** Live account-security rules plus the env defaults, so the UI and the test harness can show both. */
router.get(
  '/security',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getAccountSecurityPolicy(getDataSource().manager);
    res.json({
      data: {
        policy,
        defaults: DEFAULT_ACCOUNT_SECURITY_POLICY,
        checksum: accountSecurityPolicyChecksum(policy),
      },
    });
  }),
);

router.put(
  '/security',
  requireRole(UserRole.ADMIN),
  validateBody(updateSecuritySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateSecuritySchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updateAccountSecurityPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        previousStatus: accountSecurityPolicyChecksum(updated.previous),
        newStatus: accountSecurityPolicyChecksum(updated.updated),
        reason: `Account security policy ${describeAccountSecurityPolicy(
          updated.previous,
        )}  ->  ${describeAccountSecurityPolicy(updated.updated)}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({
      data: {
        policy: result,
        defaults: DEFAULT_ACCOUNT_SECURITY_POLICY,
        checksum: accountSecurityPolicyChecksum(result),
      },
    });
  }),
);

const idleSweepRunSchema = z.object({
  userIds: z.array(z.string().uuid()).min(1).max(1_000).optional(),
  asOf: z.string().datetime().optional(),
  dryRun: z.boolean().optional(),
});

/**
 * One idle-lock pass on demand: to see what the quiet rule would reach for, to act on named accounts,
 * or to run the whole book without waiting for the job's next beat. `dryRun` writes nothing, so it needs
 * no switch; a `userIds` list is authorised by the ADMIN who named those accounts and may proceed while
 * the switch is off. A whole-book pass obeys the switch.
 */
router.post(
  '/security/run-idle-sweep',
  requireRole(UserRole.ADMIN),
  validateBody(idleSweepRunSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof idleSweepRunSchema>;
    const run = await sweepIdleLocks({
      asOf: body.asOf ? new Date(body.asOf) : undefined,
      userIds: body.userIds,
      dryRun: body.dryRun,
    });
    if (!run.dryRun) {
      await getDataSource().transaction(async (em) => {
        await writeAudit(em, {
          action: 'IDLE_LOCK_SWEEP_RUN',
          userId: req.user!.id,
          newStatus: run.enabled ? 'ENABLED' : 'ADMIN_SCOPED_RUN',
          reason:
            `Manual idle-lock sweep over ${run.scanned} candidate(s), window ${run.idleLockDays} day(s), ` +
            `switch ${run.enabled ? 'on' : 'off'}: ${run.locked.length} lock(s), ` +
            `${run.skipped.length} skip(s), ${run.failed.length} failure(s)` +
            (body.userIds?.length ? `, named ${body.userIds.length} account(s)` : ''),
          ip: req.ip ?? null,
        });
      });
    }
    res.json({ data: run });
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

const updatePaymentSchema = z.object({
  autoDebitLeadDays: z.number().int().min(0).max(MAX_AUTO_DEBIT_LEAD_DAYS).optional(),
  autoDebitEnabled: z.boolean().optional(),
});

/** Live collection policy plus the env defaults, so the UI can show both. */
router.get(
  '/payment',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getPaymentPolicy(getDataSource().manager);
    res.json({
      data: { policy, defaults: DEFAULT_PAYMENT_POLICY, checksum: paymentPolicyChecksum(policy) },
    });
  }),
);

router.put(
  '/payment',
  requireRole(UserRole.ADMIN),
  validateBody(updatePaymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updatePaymentSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updatePaymentPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        previousStatus: paymentPolicyChecksum(updated.previous),
        newStatus: paymentPolicyChecksum(updated.updated),
        reason: `Payment policy ${describePaymentPolicy(updated.previous)}  ->  ${describePaymentPolicy(updated.updated)}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({
      data: { policy: result, defaults: DEFAULT_PAYMENT_POLICY, checksum: paymentPolicyChecksum(result) },
    });
  }),
);

const updateCollateralSchema = z.object({
  minCoveragePercent: z.number().min(0).max(MAX_COVERAGE_PERCENT).optional(),
  maxValuationAgeDays: z.number().int().min(0).max(MAX_VALUATION_AGE_DAYS).optional(),
  requirePledgeForRestructure: z.boolean().optional(),
});

/** Live collateral rules plus the env defaults, so the UI can show both. */
router.get(
  '/collateral',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getCollateralPolicy(getDataSource().manager);
    res.json({
      data: { policy, defaults: DEFAULT_COLLATERAL_POLICY, checksum: collateralPolicyChecksum(policy) },
    });
  }),
);

router.put(
  '/collateral',
  requireRole(UserRole.ADMIN),
  validateBody(updateCollateralSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateCollateralSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updateCollateralPolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        previousStatus: collateralPolicyChecksum(updated.previous),
        newStatus: collateralPolicyChecksum(updated.updated),
        reason: `Collateral policy ${describeCollateralPolicy(updated.previous)}  ->  ${describeCollateralPolicy(
          updated.updated,
        )}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({
      data: { policy: result, defaults: DEFAULT_COLLATERAL_POLICY, checksum: collateralPolicyChecksum(result) },
    });
  }),
);

const updateEvidenceSchema = z.object({
  maxFileSizeKb: z.number().int().min(1).max(MAX_EVIDENCE_FILE_SIZE_KB).optional(),
  maxFilesPerRequest: z.number().int().min(1).max(MAX_EVIDENCE_FILES_PER_REQUEST).optional(),
  allowedMimeTypes: z.array(z.string().min(4)).min(1).optional(),
  maxTotalBytesPerOwner: z.number().int().min(1).optional(),
});

/** Live evidence rules plus the env defaults, so the UI can show both. */
router.get(
  '/evidence',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const policy = await getEvidencePolicy(getDataSource().manager);
    res.json({
      data: { policy, defaults: DEFAULT_EVIDENCE_POLICY, checksum: evidencePolicyChecksum(policy) },
    });
  }),
);

router.put(
  '/evidence',
  requireRole(UserRole.ADMIN),
  validateBody(updateEvidenceSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof updateEvidenceSchema>;
    const result = await getDataSource().transaction(async (em) => {
      const updated = await updateEvidencePolicy(em, body, req.user!.id);
      await writeAudit(em, {
        action: 'CONFIG_UPDATED',
        userId: req.user!.id,
        previousStatus: evidencePolicyChecksum(updated.previous),
        newStatus: evidencePolicyChecksum(updated.updated),
        reason: `Evidence policy ${describeEvidencePolicy(updated.previous)}  ->  ${describeEvidencePolicy(updated.updated)}`,
        ip: req.ip ?? null,
      });
      return updated.updated;
    });
    res.json({
      data: { policy: result, defaults: DEFAULT_EVIDENCE_POLICY, checksum: evidencePolicyChecksum(result) },
    });
  }),
);

const autoDebitRunSchema = z.object({
  loanId: z.string().uuid().optional(),
  asOf: z.string().datetime().optional(),
  dryRun: z.boolean().optional(),
});

/**
 * One auto-debit pass on demand: for a branch that wants the due instalments collected at end of day
 * rather than on the next tick, for a single loan, or as a dry run that only reports the decisions.
 * `dryRun` writes nothing, so it needs no switch; a `loanId` is authorised by the ADMIN who named that
 * loan and may proceed while the global switch is off. A whole-book pass obeys the switch.
 */
router.post(
  '/payment/auto-debit/run',
  requireRole(UserRole.ADMIN),
  validateBody(autoDebitRunSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof autoDebitRunSchema>;
    const run = await runAutoDebit({
      asOf: body.asOf ? new Date(body.asOf) : undefined,
      loanId: body.loanId,
      dryRun: body.dryRun,
    });
    if (!run.dryRun) {
      await getDataSource().transaction(async (em) => {
        await writeAudit(em, {
          action: 'AUTO_DEBIT_RUN',
          userId: req.user!.id,
          newStatus: run.enabled ? 'ENABLED' : 'ADMIN_SCOPED_RUN',
          reason:
            `Manual auto-debit pass over ${run.scanned} active loan(s), lead ${run.leadDays} day(s), ` +
            `switch ${run.enabled ? 'on' : 'off'}: ${run.debited.length} debit(s), ` +
            `${run.skipped.length} skip(s), ${run.failed.length} failure(s)`,
          ip: req.ip ?? null,
        });
      });
    }
    res.json({ data: run });
  }),
);

export default router;
