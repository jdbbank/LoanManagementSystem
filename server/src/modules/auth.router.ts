import bcrypt from 'bcryptjs';
import { Request, Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { User } from '../entities/user.entity';
import { AccountLockReason, RateLimitScope, ResetTokenKind } from '../entities/types';
import {
  accountLockedMessage,
  idleLockDue,
  lockAccount,
  registerFailedLogin,
  registerSuccessfulLogin,
} from '../services/account-lock.service';
import { getAccountSecurityPolicy } from '../services/account-security-policy.service';
import { writeAudit } from '../services/audit.service';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { limitRequests } from '../middleware/rate-limit';
import { notifyPasswordResetLink, notifyPasswordResetOtp } from '../services/notification-events.service';
import {
  claimSecret,
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
import { getPasswordPolicy } from '../services/password-policy.service';
import { resolveTenant } from '../services/tenant.service';
import {
  PasswordExpiry,
  passwordExpiry,
  passwordExpiryPayload,
  passwordExpiredMessage,
  prepareNewPassword,
  writeNewPassword,
} from '../services/user-password.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError, badRequest, unauthorized, unprocessable } from '../utils/errors';

const router = Router();

interface SignInGate {
  user: User;
  expiry: PasswordExpiry;
  passwordMaxAgeDays: number;
}

/**
 * The chain every request that arrives with a plaintext staff password runs, whether it wants a
 * session or wants to replace a password the rotation rule has stopped.
 *
 * The failure counter and the lock are checked here rather than at each call site, because a second
 * door that verifies passwords must not become a way to guess past the lock: wrong answers spend the
 * same counter and are answered exactly like a failed sign-in. Only a correct password is ever told
 * more, and whoever reads that answer already holds the password.
 *
 * The quiet-account rule fires here as well as in the sweep, and it obeys no job switch: a door that
 * handed out a session because a background pass had not run yet would not be enforcing anything.
 *
 * The account is found inside the organisation this deployment answers for, so a name that belongs to
 * a different tenant is not this person's account and cannot be signed into through this door.
 */
async function openSignInGate(username: string, password: string, req: Request): Promise<SignInGate> {
  const ds = getDataSource();
  const tenant = await resolveTenant(ds.manager);
  const user = await ds.getRepository(User).findOne({ where: { tenantId: tenant.id, username } });
  if (!user || !user.isActive) throw unauthorized('Invalid credentials');
  const ok = await bcrypt.compare(password, user.passwordHash);
  const policy = await getAccountSecurityPolicy(ds.manager);

  if (!ok) {
    const outcome = await ds.transaction((em) => registerFailedLogin(em, user.id, policy));
    if (outcome.kind === 'locked') {
      await writeAudit(ds.manager, {
        action: 'USER_ACCOUNT_LOCKED',
        userId: user.id,
        newStatus: AccountLockReason.FAILED_ATTEMPTS,
        reason:
          `${outcome.attempts} failed sign-ins in a row (limit ${policy.maxFailedAttempts}) — ` +
          'account locked, ADMIN unlock required',
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    }
    throw unauthorized('Invalid credentials');
  }

  const idle = idleLockDue(policy, user);
  if (!user.lockedAt && idle.due) {
    const at = new Date();
    const tripped = await ds.transaction((em) => lockAccount(em, user.id, AccountLockReason.IDLE, at));
    if (tripped) {
      await writeAudit(ds.manager, {
        action: 'USER_ACCOUNT_LOCKED',
        userId: user.id,
        newStatus: AccountLockReason.IDLE,
        reason:
          `Idle lock at sign-in: no sign-in or password event since ${idle.idleSince?.toISOString() ?? 'never recorded'} ` +
          `(${idle.daysIdle} day(s), window ${policy.idleLockDays}) — ADMIN unlock required`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      user.lockedAt = at;
      user.lockReason = AccountLockReason.IDLE;
    } else {
      // A second rule wrote the lock in the same instant, so refuse with the one that is stored rather
      // than the instant this request would have used.
      const stored = await ds.getRepository(User).findOneByOrFail({ id: user.id });
      user.lockedAt = stored.lockedAt;
      user.lockReason = stored.lockReason;
    }
  }

  if (user.lockedAt) {
    await writeAudit(ds.manager, {
      action: 'USER_LOGIN_BLOCKED',
      userId: user.id,
      newStatus: user.lockReason,
      reason: `Correct password refused: locked since ${user.lockedAt.toISOString()} (${user.lockReason ?? 'no reason recorded'})`,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    throw new AppError(403, accountLockedMessage(user.lockReason), {
      code: 'ACCOUNT_LOCKED',
      lockReason: user.lockReason,
      lockedAt: user.lockedAt,
    });
  }

  return { user, expiry: passwordExpiry(policy, user), passwordMaxAgeDays: policy.passwordMaxAgeDays };
}

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

router.post(
  '/login',
  // The device ceiling counts first, so junk requests that never reach a username still spend budget.
  // The account ceiling has to come after validation, because the username it keys on is what
  // validation reports as missing or malformed.
  limitRequests({ scope: RateLimitScope.LOGIN_IP, identity: (req) => req.ip }),
  validateBody(loginSchema),
  limitRequests({
    scope: RateLimitScope.LOGIN_USERNAME,
    identity: (req) => (req.body as z.infer<typeof loginSchema>).username,
  }),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as z.infer<typeof loginSchema>;
    const ds = getDataSource();
    const { user, expiry, passwordMaxAgeDays } = await openSignInGate(username, password, req);

    // An expired password still proves who is typing, so the counter and the idle clock move; what
    // the rule withholds is the session, and the answer says how to get one.
    if (expiry.expired) {
      await ds.transaction((em) => registerSuccessfulLogin(em, user.id, new Date()));
      const daysOverdue = expiry.daysLeft === null ? 0 : Math.max(0, -expiry.daysLeft);
      await writeAudit(ds.manager, {
        action: 'USER_LOGIN_BLOCKED',
        userId: user.id,
        newStatus: 'PASSWORD_EXPIRED',
        reason:
          `Correct password refused: held past the ${passwordMaxAgeDays}-day limit ` +
          `(last change ${user.passwordChangedAt ? user.passwordChangedAt.toISOString() : 'never recorded'}, ${daysOverdue} day(s) overdue)`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      throw new AppError(403, passwordExpiredMessage(daysOverdue), {
        code: 'PASSWORD_EXPIRED',
        ...passwordExpiryPayload(expiry),
      });
    }

    const identity = { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
    // authMiddleware revokes sessions against passwordChangedAt. `iat` names a whole second, which is
    // too coarse inside the second a password changed, so the exact instant is carried beside it.
    // The tenant rides along for the same reason the identity does: it is part of who signed in, not a
    // fact the middleware has to look up again on every request.
    const token = jwt.sign(
      { ...identity, tenantId: user.tenantId, mintedAtMs: Date.now() },
      env.jwt.secret,
      {
        expiresIn: env.jwt.expiresIn,
      } as jwt.SignOptions,
    );

    await ds.transaction((em) => registerSuccessfulLogin(em, user.id, new Date()));

    await writeAudit(getDataSource().manager, {
      action: 'USER_LOGIN',
      userId: user.id,
      reason: `Role ${user.role}`,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });

    res.json({ token, user: identity });
  }),
);

router.get('/me', authMiddleware, requireAuth, (req, res) => {
  res.json({ user: req.user });
});

/**
 * Records that this person signed out.
 *
 * The bearer token is not destroyed here: it is a stateless JWT and there is no session store to mark
 * dead yet, so this answers the question the audit trail has to be able to ask — did this account sign
 * out, from where, when — while the client drops the token it was holding. The release that stores
 * sessions revokes on this same route, which is why the clients can start calling it now.
 */
router.post(
  '/logout',
  authMiddleware,
  requireAuth,
  asyncHandler(async (req, res) => {
    await writeAudit(getDataSource().manager, {
      action: 'USER_LOGOUT',
      userId: req.user!.id,
      reason: `Role ${req.user!.role}`,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
    res.status(204).end();
  }),
);

/**
 * Forgot-password answers are identical whether or not the address exists, so the endpoint
 * cannot be used to enumerate staff accounts.
 */
const RESET_ACKNOWLEDGED = 'If that address belongs to an active account, a 6-digit code is on its way.';
const OTP_REJECTED = 'Invalid or expired verification code';
const LINK_REJECTED = 'That reset link is no longer valid — request a new one';

const forgotPasswordSchema = z.object({ email: z.string().email().max(191) });

/**
 * The three reset doors share one ceiling per device, because they are one workflow: asking for a
 * code, confirming it and spending the link are three requests that a person who is locked out makes
 * in a row. Counting them separately would triple the traffic one address may send for no extra
 * protection, since the secrets they carry are the same secret.
 */
router.post(
  '/forgot-password',
  limitRequests({ scope: RateLimitScope.RESET_IP, identity: (req) => req.ip }),
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof forgotPasswordSchema>;
    const ds = getDataSource();
    const tenant = await resolveTenant(ds.manager);
    const user = await ds
      .getRepository(User)
      .findOne({ where: { tenantId: tenant.id, email: email.trim() } });
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
  limitRequests({ scope: RateLimitScope.RESET_IP, identity: (req) => req.ip }),
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const { email, otp } = req.body as z.infer<typeof verifyOtpSchema>;
    const ds = getDataSource();
    const em = ds.manager;

    if (await isIpThrottled(em, req.ip)) {
      throw new AppError(429, 'Too many attempts from this device — wait a minute and try again');
    }

    const tenant = await resolveTenant(em);
    const user = await ds
      .getRepository(User)
      .findOne({ where: { tenantId: tenant.id, email: email.trim() } });
    if (!user || !user.isActive) throw badRequest(OTP_REJECTED);

    // One transaction owns the read, the attempt counter and the spend. The rejection is thrown
    // after it commits so a counted wrong guess is never rolled back into thin air.
    const outcome = await ds.transaction(async (tx) => {
      const secret = await findActiveSecretForUser(tx, user.id, ResetTokenKind.OTP);
      if (!secret) return { kind: 'rejected' as const };

      if (!verifySecret(secret, otp)) {
        const attempt = await registerBadAttempt(tx, secret);
        if (attempt.kind === 'burned') {
          await writeAudit(tx, {
            action: 'USER_RESET_BURNED',
            userId: user.id,
            reason: `Reset code burned after ${env.security.otpMaxAttempts} wrong attempts (${user.username})`,
            ip: req.ip ?? null,
          });
        }
        return { kind: 'rejected' as const };
      }

      // Only the request that spends the code may issue a link (F-CONC-4).
      if (!(await claimSecret(tx, secret))) return { kind: 'rejected' as const };

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
      return { kind: 'verified' as const, raw: token.raw, expiresAt: token.row.expiresAt };
    });

    if (outcome.kind === 'rejected') throw badRequest(OTP_REJECTED);

    res.json({
      verified: true,
      resetUrl: `/reset-password?token=${outcome.raw}`,
      expiresAt: outcome.expiresAt,
    });
  }),
);

const resetPasswordSchema = z.object({
  token: z.string().min(16).max(512),
  password: z.string().min(1).max(128),
});

/**
 * Consumes the link, sets the new password under the live policy and the no-repeat rule, then retires
 * every other secret of that account so an ignored code cannot be replayed afterwards.
 */
router.post(
  '/reset-password',
  limitRequests({ scope: RateLimitScope.RESET_IP, identity: (req) => req.ip }),
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body as z.infer<typeof resetPasswordSchema>;
    const ds = getDataSource();
    const em = ds.manager;

    const secret = await findActiveSecret(em, ResetTokenKind.LINK, token);
    if (!secret) throw badRequest(LINK_REJECTED);

    const user = await ds.getRepository(User).findOne({ where: { id: secret.userId } });
    if (!user || !user.isActive) throw badRequest(LINK_REJECTED);

    // Hashed before the transaction so bcrypt does not hold the secret row locked. A link is spent on
    // the current password, so it has to clear the reuse rule too or it becomes the loophole.
    const passwordHash = await prepareNewPassword(em, user, password);

    const reset = await ds.transaction(async (tx) => {
      // The link is spent by the first request only; a parallel one must not overwrite the password.
      if (!(await claimSecret(tx, secret))) return false;

      await retireAllSecrets(tx, user.id);
      await writeNewPassword(tx, user, passwordHash);
      await writeAudit(tx, {
        action: 'USER_PASSWORD_RESET',
        userId: user.id,
        previousStatus: null,
        newStatus: user.role,
        reason: `Password reset through the self-service link (${user.username})`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return true;
    });

    if (!reset) throw badRequest(LINK_REJECTED);

    res.json({ reset: true, message: 'Password updated — sign in with the new password' });
  }),
);

const changeExpiredSchema = z.object({
  username: z.string().min(1).max(64),
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});

/**
 * The way back in for a password the rotation rule has stopped, answered from the login form because
 * the person has no session yet. It proves the current password through the same gate as sign-in —
 * same wrong-password counter, same lock — so it cannot turn into a second way to guess, and it stops
 * short of issuing a token: the point of the gate is that this password is no longer acceptable.
 */
router.post(
  '/change-expired-password',
  // This door takes a current password, so it carries the same two ceilings as sign-in; a second door
  // that accepts passwords without counting them is the hole a brute-force run would be built around.
  limitRequests({ scope: RateLimitScope.LOGIN_IP, identity: (req) => req.ip }),
  validateBody(changeExpiredSchema),
  limitRequests({
    scope: RateLimitScope.LOGIN_USERNAME,
    identity: (req) => (req.body as z.infer<typeof changeExpiredSchema>).username,
  }),
  asyncHandler(async (req, res) => {
    const { username, currentPassword, newPassword } = req.body as z.infer<typeof changeExpiredSchema>;
    const ds = getDataSource();
    const { user, expiry, passwordMaxAgeDays } = await openSignInGate(username, currentPassword, req);

    if (!expiry.expired) {
      throw unprocessable(
        'This password is not due for a change yet — sign in and change it from your profile',
        { code: 'PASSWORD_NOT_EXPIRED' },
      );
    }

    const passwordHash = await prepareNewPassword(ds.manager, user, newPassword);
    const changedAt = new Date();
    await ds.transaction(async (em) => {
      // A code or link issued before this change must not stay spendable, exactly as a profile change.
      await retireAllSecrets(em, user.id);
      await writeNewPassword(em, user, passwordHash, changedAt);
      await registerSuccessfulLogin(em, user.id, changedAt);
      await writeAudit(em, {
        action: 'USER_PASSWORD_CHANGED',
        userId: user.id,
        newStatus: user.role,
        reason: `Password replaced at the rotation gate by ${user.username} (${passwordMaxAgeDays}-day limit)`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    res.json({ changed: true, message: 'Password updated — sign in with the new password' });
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
