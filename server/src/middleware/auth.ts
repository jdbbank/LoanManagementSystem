import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { UserRole } from '../entities/types';
import { User } from '../entities/user.entity';
import { forbidden, unauthorized } from '../utils/errors';

export interface AuthUser {
  id: string;
  username: string;
  fullName: string;
  role: UserRole;
}

interface TokenPayload extends AuthUser {
  iat?: number;
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
  // A signed token is not authority on its own: the account must still exist, be active, and
  // have not changed its password since the token was issued.
  void getDataSource()
    .getRepository(User)
    .findOne({ where: { id: payload.id } })
    .then((user) => {
      if (!user) {
        next(unauthorized('Account no longer exists'));
        return;
      }
      if (!user.isActive) {
        next(unauthorized('Account is disabled'));
        return;
      }
      // JWT only carries second resolution, so the change is compared at the same resolution.
      const changedAtSecond = user.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0;
      if ((payload.iat ?? 0) < changedAtSecond) {
        next(unauthorized('Session is no longer valid, please sign in again'));
        return;
      }
      req.user = { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
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
