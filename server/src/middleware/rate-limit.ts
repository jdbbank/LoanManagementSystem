import { Request, RequestHandler } from 'express';
import { getDataSource } from '../datasource';
import { RateLimitScope } from '../entities/types';
import { consumeRateBucket, rateLimitFor, rateLimitIdentity } from '../services/rate-limit.service';
import { writeAudit } from '../services/audit.service';
import { asyncHandler } from '../utils/async-handler';
import { AppError } from '../utils/errors';

/**
 * What the caller is told. Both wordings say what to do instead of just refusing, and neither names
 * the ceiling: a number in the answer is a specification of how much traffic an attacker may send.
 */
const MESSAGE_BY_SCOPE: Record<RateLimitScope, string> = {
  [RateLimitScope.LOGIN_IP]: 'Too many sign-in attempts from this device — wait a minute and try again',
  [RateLimitScope.LOGIN_USERNAME]: 'Too many attempts for this account — wait a minute and try again',
  [RateLimitScope.RESET_IP]: 'Too many password-reset attempts from this device — wait a minute and try again',
};

export interface RateLimitOptions {
  scope: RateLimitScope;
  /** What identifies the caller: `req.ip` for an address, a form field for an account. */
  identity: (req: Request) => string | null | undefined;
}

/**
 * Guards one endpoint with one counter.
 *
 * Every ceiling is a separate middleware rather than one global handler because the doors need
 * different keys and different budgets: sign-in is counted per device and per account, the reset
 * workflow per device across all three of its steps.
 *
 * The count is taken before the endpoint runs, so a refused request still costs the caller a slot.
 * A limiter that only counts accepted requests can be drained by a flood that never succeeds.
 */
export function limitRequests(options: RateLimitOptions): RequestHandler {
  return asyncHandler(async (req: Request, res) => {
    const limit = rateLimitFor(options.scope);
    if (limit <= 0) return;
    const identity = rateLimitIdentity(options.identity(req));
    if (!identity) return;

    const ds = getDataSource();
    const outcome = await consumeRateBucket(ds.manager, options.scope, identity);

    // Only the request that crosses the line is written down, so a sustained flood fills the audit
    // log with one row per window instead of one row per packet.
    if (outcome.hits === limit + 1) {
      await writeAudit(ds.manager, {
        action: 'USER_RATE_LIMITED',
        newStatus: options.scope,
        reason: `Ceiling of ${limit} request(s) reached in one window by ${identity}`,
        ip: req.ip ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      });
    }

    if (outcome.allowed) return;
    res.set('Retry-After', String(outcome.retryAfterSeconds));
    throw new AppError(429, MESSAGE_BY_SCOPE[options.scope], {
      code: 'RATE_LIMITED',
      scope: options.scope,
      retryAfterSeconds: outcome.retryAfterSeconds,
    });
  });
}
