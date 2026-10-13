import bcrypt from 'bcryptjs';
import { Request, Router } from 'express';
import { EntityManager } from 'typeorm';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { ResetTokenKind, UserRole } from '../entities/types';
import { User } from '../entities/user.entity';
import { AuthUser, authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { avatarsByUser, deleteAvatar, readAvatar, replaceAvatar } from '../services/avatar.service';
import { getAvatarPolicy } from '../services/avatar-policy.service';
import { writeAudit } from '../services/audit.service';
import { notifyPasswordResetLink, notifyUserCreated } from '../services/notification-events.service';
import { assertPasswordAllowed, getPasswordPolicy } from '../services/password-policy.service';
import { isWithinCooldown, issueResetToken, newLinkSecret } from '../services/password-reset.service';
import { asyncHandler } from '../utils/async-handler';
import { conflict, forbidden, notFound, unprocessable } from '../utils/errors';
import { readSingleFile } from '../utils/upload';

const router = Router();
router.use(authMiddleware, requireAuth);

const publicUser = (u: User, hasAvatar = false) => ({
  id: u.id,
  username: u.username,
  fullName: u.fullName,
  email: u.email,
  isEmailVerified: u.isEmailVerified,
  role: u.role,
  isActive: u.isActive,
  hasAvatar,
  lastLoginAt: u.lastLoginAt,
  passwordChangedAt: u.passwordChangedAt,
  deletedAt: u.deletedAt,
  createdAt: u.createdAt,
});

/** A user owns their own picture and password reset; only ADMIN reaches other accounts. */
function assertSelfOrAdmin(req: Request, userId: string): AuthUser {
  const actor = req.user as AuthUser;
  if (actor.role === UserRole.ADMIN || actor.id === userId) return actor;
  throw forbidden('Only the account owner or an ADMIN can do this');
}

async function loadUser(userId: string): Promise<User> {
  const user = await getDataSource().getRepository(User).findOne({ where: { id: userId } });
  if (!user) throw notFound('User not found');
  return user;
}

router.get(
  '/',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (req, res) => {
    const em = getDataSource().manager;
    // Soft-deleted accounts are hidden by default; the admin list can ask for them.
    const includeDeleted = req.query.includeDeleted === 'true';
    const users = await em.find(User, {
      withDeleted: includeDeleted,
      order: { createdAt: 'ASC' },
    });
    const avatars = await avatarsByUser(em, users.map((u) => u.id));
    res.json({ users: users.map((u) => publicUser(u, avatars.has(u.id))) });
  }),
);

const createUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(1).max(128),
  fullName: z.string().min(1).max(191),
  email: z.string().email().max(191).nullish(),
  role: z.nativeEnum(UserRole),
});

router.post(
  '/',
  requireRole(UserRole.ADMIN),
  validateBody(createUserSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createUserSchema>;
    const ds = getDataSource();
    const email = body.email?.trim() || null;

    assertPasswordAllowed(await getPasswordPolicy(ds.manager), body.password);

    // Soft-deleted rows still hold the unique index, so they must be part of the check.
    const exists = await ds.getRepository(User).findOne({
      withDeleted: true,
      where: email ? [{ username: body.username }, { email }] : { username: body.username },
    });
    if (exists) {
      res.status(409).json({ error: { message: 'Username or email already exists' } });
      return;
    }
    const user = ds.getRepository(User).create({
      username: body.username,
      passwordHash: await bcrypt.hash(body.password, 10),
      fullName: body.fullName,
      email,
      role: body.role,
      passwordChangedAt: new Date(),
    });
    await ds.getRepository(User).save(user);
    await writeAudit(ds.manager, {
      action: 'USER_CREATED',
      userId: req.user!.id,
      reason: `Role ${body.role}`,
      newStatus: body.role,
      ip: req.ip ?? null,
    });
    await notifyUserCreated(ds.manager, {
      userId: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      role: user.role,
      createdByName: req.user!.fullName,
    });
    res.status(201).json({ user: publicUser(user) });
  }),
);

const updateUserSchema = z.object({
  fullName: z.string().min(1).max(191).optional(),
  email: z.string().email().max(191).nullish(),
  role: z.nativeEnum(UserRole).optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(1).max(128).optional(),
});

router.patch(
  '/:id',
  requireRole(UserRole.ADMIN),
  validateBody(updateUserSchema),
  asyncHandler(async (req, res) => {
    const ds = getDataSource();
    const user = await loadUser(req.params.id);
    const body = req.body as z.infer<typeof updateUserSchema>;

    if (body.password !== undefined) {
      assertPasswordAllowed(await getPasswordPolicy(ds.manager), body.password);
    }
    if (body.fullName !== undefined) user.fullName = body.fullName;
    if (body.email !== undefined) {
      const email = body.email?.trim() || null;
      if (email !== (user.email ?? null)) {
        const taken = email ? await ds.getRepository(User).findOne({ withDeleted: true, where: { email } }) : null;
        if (taken) {
          res.status(409).json({ error: { message: 'Email already belongs to another user' } });
          return;
        }
        user.email = email;
        // A new address has never been proven, so it must be re-verified.
        user.isEmailVerified = false;
      }
    }
    if (body.role !== undefined) user.role = body.role;
    if (body.isActive !== undefined) user.isActive = body.isActive;
    if (body.password !== undefined) {
      user.passwordHash = await bcrypt.hash(body.password, 10);
      user.passwordChangedAt = new Date();
    }
    await ds.getRepository(User).save(user);
    await writeAudit(ds.manager, {
      action: 'USER_UPDATED',
      userId: req.user!.id,
      reason: `Updated ${user.username}`,
      previousStatus: null,
      newStatus: body.role ?? null,
      ip: req.ip ?? null,
    });
    const avatar = await avatarsByUser(ds.manager, [user.id]);
    res.json({ user: publicUser(user, avatar.has(user.id)) });
  }),
);

/** Raw avatar bytes. The UI fetches this with its auth header and shows an <img>. */
router.get(
  '/:id/avatar',
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    assertSelfOrAdmin(req, userId);
    const em = getDataSource().manager;
    await loadUser(userId);

    const found = await readAvatar(em, userId);
    if (!found) throw notFound('Avatar');

    const safeName = found.avatar.fileName.replace(/[^\w.\- ]/g, '').slice(0, 100) || 'avatar';
    res.set('Content-Type', found.avatar.mimeType);
    res.set('Content-Disposition', `inline; filename="${safeName}"`);
    res.set('Cache-Control', 'private, max-age=300');
    res.send(found.data);
  }),
);

router.put(
  '/:id/avatar',
  asyncHandler(async (req: Request, res) => {
    const userId = req.params.id;
    const actor = assertSelfOrAdmin(req, userId);
    const ds = getDataSource();
    const user = await loadUser(userId);

    const policy = await getAvatarPolicy(ds.manager);
    const file = await readSingleFile(req, res, policy.maxFileSizeKb, 1);

    const result = await ds.transaction(async (em) => {
      const saved = await replaceAvatar(em, {
        userId,
        actorId: actor.id,
        fileName: file.originalname,
        buffer: file.buffer,
        policy,
      });

      await writeAudit(em, {
        action: 'USER_AVATAR_UPDATED',
        userId: actor.id,
        reason: `${user.username} avatar ${saved.mimeType} (${saved.sizeBytes} bytes, sha256 ${saved.checksum.slice(0, 12)})`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return saved;
    });

    res.status(201).json({
      user: publicUser(user, true),
      avatar: {
        id: result.id,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        updatedAt: result.updatedAt,
      },
    });
  }),
);

router.delete(
  '/:id/avatar',
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const actor = assertSelfOrAdmin(req, userId);
    const ds = getDataSource();
    const user = await loadUser(userId);

    const removed = await ds.transaction(async (em) => {
      const deleted = await deleteAvatar(em, userId);
      if (!deleted) return false;
      await writeAudit(em, {
        action: 'USER_AVATAR_DELETED',
        userId: actor.id,
        reason: `${user.username} avatar removed`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
      return true;
    });

    if (!removed) throw notFound('Avatar');
    res.json({ user: publicUser(user, false) });
  }),
);

/**
 * Soft delete: the account disappears from every finder (so login and assignment both
 * stop) while its audit trail and loan history stay joinable.
 */
router.delete(
  '/:id',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (req, res) => {
    const actor = req.user as AuthUser;
    const user = await loadUser(req.params.id);
    if (user.id === actor.id) throw unprocessable('You cannot delete the account you are signed in with');

    const ds = getDataSource();
    await ds.transaction(async (em) => {
      user.isActive = false;
      await em.save(User, user);
      await em.softRemove(User, user);
      await writeAudit(em, {
        action: 'USER_DELETED',
        userId: actor.id,
        previousStatus: user.role,
        newStatus: 'DELETED',
        reason: `Deactivated and soft-deleted ${user.username}`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    res.json({ deleted: true, id: user.id });
  }),
);

/** Undo of a soft delete, ADMIN-only, kept because deletion is otherwise a dead end. */
router.post(
  '/:id/restore',
  requireRole(UserRole.ADMIN),
  validateBody(z.object({ reactivate: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    const actor = req.user as AuthUser;
    const reactivate = (req.body as { reactivate?: boolean }).reactivate ?? false;
    const ds = getDataSource();

    // withDeleted() is the only way back — the row is invisible to a normal finder.
    const user = await ds.getRepository(User).findOne({ where: { id: req.params.id }, withDeleted: true });
    if (!user) throw notFound('User not found');
    if (!user.deletedAt) throw conflict('This account is not deleted');

    await ds.transaction(async (em) => {
      // restore() only clears deletedAt, so the reactivation needs its own write.
      await em.restore(User, user.id);
      user.deletedAt = null;
      if (reactivate) user.isActive = true;
      await em.save(User, user);
      await writeAudit(em, {
        action: 'USER_RESTORED',
        userId: actor.id,
        newStatus: user.role,
        reason: `Restored ${user.username}${reactivate ? ' and reactivated' : ''}`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    });

    res.json({ user: publicUser(user, false) });
  }),
);

async function sendResetLink(
  em: EntityManager,
  actor: AuthUser,
  user: User,
  ip: string | null | undefined,
  userAgent: string | null | undefined,
): Promise<{ expiresAt: Date }> {
  if (!user.email) throw unprocessable(`${user.username} has no email address — set one before resetting`);
  if (!user.isActive) throw unprocessable(`${user.username} is deactivated — reactivate the account first`);
  if (await isWithinCooldown(em, user.id, ResetTokenKind.LINK)) {
    throw unprocessable('A reset link was sent moments ago — wait before sending another');
  }

  const issued = await issueResetToken(em, {
    userId: user.id,
    kind: ResetTokenKind.LINK,
    secret: newLinkSecret(),
    ip: ip ?? null,
  });

  await notifyPasswordResetLink(em, {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    username: user.username,
    resetUrl: `${env.webBaseUrl}/reset-password?token=${issued.raw}`,
    expiresMinutes: env.security.linkTtlMinutes,
  });

  await writeAudit(em, {
    action: 'USER_RESET_SENT',
    userId: actor.id,
    reason: `Password reset link sent to ${user.email} (${user.username})`,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
  });

  return { expiresAt: issued.row.expiresAt };
}

router.post(
  '/:id/send-reset-link',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (req, res) => {
    const actor = req.user as AuthUser;
    const user = await loadUser(req.params.id);

    const result = await getDataSource().transaction(async (em) =>
      sendResetLink(em, actor, user, req.ip, req.headers['user-agent']),
    );

    res.json({ sent: true, username: user.username, expiresAt: result.expiresAt });
  }),
);

const bulkResetSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});

/** Same operation for a whole list of accounts; per-user failures never abort the batch. */
router.post(
  '/send-reset-links',
  requireRole(UserRole.ADMIN),
  validateBody(bulkResetSchema),
  asyncHandler(async (req, res) => {
    const actor = req.user as AuthUser;
    const { ids } = req.body as z.infer<typeof bulkResetSchema>;
    const ds = getDataSource();

    const result = await ds.transaction(async (em) => {
      const sent: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];

      for (const id of ids) {
        const user = await em.findOne(User, { where: { id } });
        if (!user) {
          skipped.push({ id, reason: 'User not found' });
          continue;
        }
        try {
          await sendResetLink(em, actor, user, req.ip, req.headers['user-agent']);
          sent.push(user.username);
        } catch (error) {
          skipped.push({ id, reason: error instanceof Error ? error.message : 'Could not send' });
        }
      }
      return { sent, skipped };
    });

    res.json(result);
  }),
);

export default router;
