import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { User } from '../entities/user.entity';
import { ResetTokenKind } from '../entities/types';
import { writeAudit } from '../services/audit.service';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { notifyPasswordResetLink, notifyPasswordResetOtp } from '../services/notification-events.service';
import {
  consumeSecret,
  findActiveSecret,
  findActiveSecretForUser,
  issueResetToken,
  isIpThrottled,
  isWithinCooldown,
  newLinkSecret,
  newOtp,
  registerBadAttempt,
  retireAllSecrets,
  verifySecret,
} from '../services/password-reset.service';
import { assertPasswordAllowed, getPasswordPolicy } from '../services/password-policy.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError, badRequest, unauthorized } from '../utils/errors';

const router = Router();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const user = await getDataSource().getRepository(User).findOne({ where: { username } });
    if (!user || !user.isActive) throw unauthorized('Invalid credentials');
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid credentials');

    const payload = { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
    const token = jwt.sign(payload, env.jwt.secret, { expiresIn: env.jwt.expiresIn } as jwt.SignOptions);

    user.lastLoginAt = new Date();
    await getDataSource().getRepository(User).save(user);

    await writeAudit(getDataSource().manager, {
      action: 'USER_LOGIN',
      userId: user.id,
      reason: `Role ${user.role}`,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.json({ token, user: payload });
  }),
);

router.get('/me', authMiddleware, requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Forgot-password answers are identical whether or not the address exists, so the endpoint
 * cannot be used to enumerate staff accounts.
 */
const RESET_ACKNOWLEDGED = 'If that address belongs to an active account, a 6-digit code is on its way.';
const OTP_REJECTED = 'Invalid or expired verification code';
const LINK_REJECTED = 'That reset link is no longer valid — request a new one';

const forgotPasswordSchema = z.object({ email: z.string().email().max(191) });

router.post(
  '/forgot-password',
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotPasswordSchema>;
    const ds = getDataSource();
    const user = await ds.getRepository(User).findOne({ where: { email: email.trim() } });
    if (!user) {
      res.status(202).json({ message: RESET_ACKNOWLEDGED });
      return;
    }

    const em = ds.manager;
    if (!user.isActive || (await isIpThrottled(em, req.ip)) || (await isWithinCooldown(em, user.id, ResetTokenKind.OTP))) {
      res.status(202).json({ message: RESET_ACKNOWLEDGED });
      return;
    }

    await ds.transaction(async (tx) => {
      const issued = await issueResetToken(tx, {
        userId: user.id,
        kind: ResetTokenKind.OTP,
        secret: newOtp(),
        ip: req.ip ?? null,
      });
      await notifyPasswordResetOtp(tx, {
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        otp: issued.raw,
        expiresMinutes: env.security.otpTtlMinutes,
      });
      await writeAudit(tx, {
        action: 'USER_RESET_REQUESTED',
        userId: user.id,
        reason: `Reset code sent to ${user.email} (${user.username})`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    res.status(202).json({ message: RESET_ACKNOWLEDGED });
  }),
);

const verifyOtpSchema = z.object({
  email: z.string().email().max(191),
  otp: z.string().regex(/^\d{6}$/),
});

/** A right code trades itself for a single-use reset link; a wrong one burns the code. */
router.post(
  '/verify-otp',
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const { email, otp } = req.body as z.infer<typeof verifyOtpSchema>;
    const ds = getDataSource();
    const em = ds.manager;

    if (await isIpThrottled(em, req.ip)) {
      throw new AppError(429, 'Too many attempts from this device — wait a minute and try again');
    }

    const user = await ds.getRepository(User).findOne({ where: { email: email.trim() } });
    if (!user || !user.isActive) throw badRequest(OTP_REJECTED);

    const secret = await findActiveSecretForUser(em, user.id, ResetTokenKind.OTP);
    if (!secret) throw badRequest(OTP_REJECTED);

    if (!verifySecret(secret, otp)) {
      const attemptsLeft = await registerBadAttempt(em, secret);
      if (attemptsLeft === null) {
        await writeAudit(em, {
          action: 'USER_RESET_BURNED',
          userId: user.id,
          reason: `Reset code burned after ${env.security.otpMaxAttempts} wrong attempts (${user.username})`,
          ip: req.ip ?? null,
        });
      }
      throw badRequest(OTP_REJECTED);
    }

    const issued = await ds.transaction(async (tx) => {
      await consumeSecret(tx, secret);
      const token = await issueResetToken(tx, {
        userId: user.id,
        kind: ResetTokenKind.LINK,
        secret: newLinkSecret(),
        ip: req.ip ?? null,
      });
      await notifyPasswordResetLink(tx, {
        userId: user.id,
        email: user.email,
        fullName: user.fullName,
        username: user.username,
        resetUrl: `${env.webBaseUrl}/reset-password?token=${token.raw}`,
        expiresMinutes: env.security.linkTtlMinutes,
      });
      await writeAudit(tx, {
        action: 'USER_RESET_VERIFIED',
        userId: user.id,
        reason: `Reset code confirmed for ${user.username}; link issued`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return token;
    });

    res.json({
      verified: true,
      resetUrl: `/reset-password?token=${issued.raw}`,
      expiresAt: issued.row.expiresAt,
    });
  }),
);

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(1).max(128),
});

/**
 * Consumes the link, sets the new password under the live policy, then retires every other
 * secret of that account so an ignored code cannot be replayed afterwards.
 */
router.post(
  '/reset-password',
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetPasswordSchema>;
    const ds = getDataSource();
    const em = ds.manager;

    const secret = await findActiveSecret(em, ResetTokenKind.LINK, token);
    if (!secret) throw badRequest(LINK_REJECTED);

    const user = await ds.getRepository(User).findOne({ where: { id: secret.userId } });
    if (!user || !user.isActive) throw badRequest(LINK_REJECTED);

    assertPasswordAllowed(await getPasswordPolicy(em), password);

    await ds.transaction(async (tx) => {
      await consumeSecret(tx, secret);
      await retireAllSecrets(tx, user.id);
      user.passwordHash = await bcrypt.hash(password, 10);
      user.passwordChangedAt = new Date();
      await tx.save(User, user);
      await writeAudit(tx, {
        action: 'USER_PASSWORD_RESET',
        userId: user.id,
        previousStatus: null,
        newStatus: user.role,
        reason: `Password reset through the self-service link (${user.username})`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    res.json({ reset: true, message: 'Password updated — sign in with the new password' });
  }),
);

/** The login page shows the rules before a user types a password, so this one is public. */
router.get(
  '/password-policy',
  asyncHandler(async (_req, res) => {
    res.json({ data: { policy: await getPasswordPolicy(getDataSource().manager) } });
  }),
);

export default router;
