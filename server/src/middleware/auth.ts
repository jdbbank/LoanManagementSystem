import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { UserRole } from '../entities/types';
import { User } from '../entities/user.entity';
import { accountLockedMessage } from '../services/account-lock.service';
import { AppError, forbidden, unauthorized } from '../utils/errors';

export interface AuthUser {
  id: string;
  /**
   * Which organisation the account belongs to. It travels with the identity rather than being looked
   * up per request because a token already asserts who signed in, and the tenant is part of that fact.
   */
  tenantId: string;
  username: string;
  fullName: string;
  role: UserRole;
}

interface TokenPayload extends AuthUser {
  iat?: number;
  mintedAtMs?: number;
}

/**
 * True when this token was minted before the account's last password change, so that change revoked it.
 *
 * Second resolution cannot decide that in the second the change happened, and both answers are
 * reachable there: a token minted milliseconds BEFORE the change is an old session that must drop,
 * while one minted milliseconds AFTER it is the sign-in the change itself asked for and must work.
 * Login therefore records its exact instant beside `iat`, and the comparison is in milliseconds.
 * A token minted before that claim existed falls back to `iat` at the start of its second, which is
 * never later than the real instant, so such a token can only be revoked early — never kept alive.
 */
export function isSessionRevoked(
  passwordChangedAt: Date | null,
  claims: { iat?: number; mintedAtMs?: number },
): boolean {
  if (!passwordChangedAt) return false;
  const mintedAtMs = claims.mintedAtMs ?? (claims.iat ?? 0) * 1000;
  return mintedAtMs < passwordChangedAt.getTime();
}

/**
 * Why this token no longer carries authority, or null when it still does.
 *
 * A token proves who minted it, not that the account still holds the right to use it. The lock is
 * answered before the revoked session because it is the fact the person can act on — the session
 * would drop either way, but only the lock says who to ask — and it is the same 403 shape login
 * answers with, so one client branch covers both doors.
 *
 * No audit line belongs here: the lock is recorded where it fired, and this answers every request the
 * held-over session makes. Recovery stays reachable because `app.ts` mounts `/api/auth` — where the
 * emailed reset link and the forced-change doors live — before this middleware runs.
 */
export function sessionRejection(
  user: Pick<User, 'isActive' | 'lockedAt' | 'lockReason' | 'passwordChangedAt'>,
  claims: { iat?: number; mintedAtMs?: number },
): AppError | null {
  if (!user.isActive) return unauthorized('Account is disabled');
  if (user.lockedAt) {
    return new AppError(403, accountLockedMessage(user.lockReason), {
      code: 'ACCOUNT_LOCKED',
      lockReason: user.lockReason,
      lockedAt: user.lockedAt,
    });
  }
  if (isSessionRevoked(user.passwordChangedAt, claims)) {
    return unauthorized('Session is no longer valid, please sign in again');
  }
  return null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(unauthorized('Missing bearer token'));
    return;
  }
  let payload: TokenPayload;
  try {
    payload = jwt.verify(header.slice(7), env.jwt.secret) as TokenPayload;
  } catch {
    next(unauthorized('Invalid or expired token'));
    return;
  }
  // A signed token is not authority on its own: the account must still exist, and `sessionRejection`
  // decides whether it still holds the right to use this token.
  void getDataSource()
    .getRepository(User)
    .findOne({ where: { id: payload.id } })
    .then((user) => {
      if (!user) {
        next(unauthorized('Account no longer exists'));
        return;
      }
      const rejection = sessionRejection(user, payload);
      if (rejection) {
        next(rejection);
        return;
      }
      req.user = {
        id: user.id,
        tenantId: user.tenantId,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
      };
      next();
    })
    .catch(next);
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) {
    next(unauthorized());
    return;
  }
  next();
}

/** Roles allowed to decide an approval level. ADMIN can act at any level. */
const LEVEL_ROLES: Record<string, UserRole[]> = {
  CHECKER: [UserRole.CHECKER, UserRole.ADMIN],
  HEAD: [UserRole.HEAD_APPROVER, UserRole.ADMIN],
  ADMIN: [UserRole.ADMIN],
};

export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(forbidden(`Requires role: ${roles.join(' or ')}`));
      return;
    }
    next();
  };
}

export function canDecideLevel(user: AuthUser, level: string): boolean {
  const allowed = LEVEL_ROLES[level];
  return !!allowed && allowed.includes(user.role);
}

export const OPERATOR_ROLES: UserRole[] = [UserRole.MAKER, UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN];
