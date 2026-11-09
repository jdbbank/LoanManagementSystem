import { EntityManager, LessThan } from 'typeorm';
import { getDataSource } from '../datasource';
import { env } from '../config/env';
import { SecurityRateBucket } from '../entities/security-rate-bucket.entity';
import { RateLimitScope } from '../entities/types';
import { logger } from '../utils/logger';

/**
 * Request ceilings for the endpoints that accept a password or a reset secret.
 *
 * The counter lives in the database rather than in the process because the API runs as more than one
 * container behind the gateway: an in-memory map would give every replica its own budget, so the
 * ceiling an attacker sees depends on which replica answers. It is also why the count is raised in SQL
 * instead of read, added to and written back — two requests in the same instant that both read the
 * pre-lock value would each spend one slot and report one hit.
 *
 * A window is not reset by anybody. Its index is part of the row key, so the first request of the next
 * window opens a new row and the old one is left for the prune job.
 */
const WINDOW_MS = Math.max(1, env.rateLimit.windowSeconds) * 1000;

/**
 * One statement, not a read plus a write. `LAST_INSERT_ID(hits + 1)` makes MySQL hand back the counter
 * as this request left it, so a parallel request cannot be miscounted as ours; a brand new row reports
 * no insert id at all, which is the same thing as saying this request is hit number one.
 */
const BUMP_BUCKET_SQL = `
  INSERT INTO security_rate_buckets (\`id\`, \`bucketKey\`, \`scope\`, \`identity\`, \`hits\`, \`expiresAt\`, \`updatedAt\`)
  VALUES (UUID(), ?, ?, ?, 1, ?, CURRENT_TIMESTAMP(3))
  ON DUPLICATE KEY UPDATE \`hits\` = LAST_INSERT_ID(\`hits\` + 1), \`updatedAt\` = CURRENT_TIMESTAMP(3)
`;

const LIMIT_BY_SCOPE: Record<RateLimitScope, number> = {
  [RateLimitScope.LOGIN_IP]: env.rateLimit.loginPerIp,
  [RateLimitScope.LOGIN_USERNAME]: env.rateLimit.loginPerUsername,
  [RateLimitScope.RESET_IP]: env.rateLimit.resetPerIp,
};

/** 0 reads as "this ceiling is switched off", the same reading every other numeric rule gives 0. */
export function rateLimitFor(scope: RateLimitScope): number {
  return Math.max(0, LIMIT_BY_SCOPE[scope] ?? 0);
}

/**
 * What a caller is keyed on: an address, or a username in the case the sign-in path uses.
 *
 * Usernames are folded to lower case because MySQL compares them case-insensitively under the
 * default collation, so "Admin" and "admin" are one account and must be one budget. The value is
 * cut to a length the column can hold rather than truncated by the database, because a silent
 * truncate would let two long names share one counter.
 */
export function rateLimitIdentity(raw: string | null | undefined): string {
  return (raw ?? '').trim().toLowerCase().slice(0, 120);
}

export function rateLimitBucketKey(scope: RateLimitScope, identity: string, windowIndex: number): string {
  return `${scope}:${identity}:${windowIndex}`;
}

export interface RateDecision {
  allowed: boolean;
  /** Requests this caller has made in the current window, counting this one. */
  hits: number;
  limit: number;
  retryAfterSeconds: number;
  /** True when the counter could not be written because this database has no `security_rate_buckets` yet. */
  storageMissing: boolean;
}

function decision(hits: number, limit: number, storageMissing = false): RateDecision {
  const now = Date.now();
  const windowEndsAt = (Math.floor(now / WINDOW_MS) + 1) * WINDOW_MS;
  return {
    allowed: limit <= 0 || hits <= limit,
    hits,
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((windowEndsAt - now) / 1000)),
    storageMissing,
  };
}

/**
 * Counts this request against the caller's window and says whether it is still inside the ceiling.
 *
 * When the counter cannot be written the request is refused, with one exception: a database that has
 * not been migrated yet is a deployment the operator is standing in the middle of, and locking every
 * sign-in in the branch until they run `npm run db:migrate` is a worse outage than the one the ceiling
 * guards against. Any other storage failure is refused, because a limiter that quietly stops counting
 * is the thing a brute-force run is waiting for.
 */
export async function consumeRateBucket(
  em: EntityManager,
  scope: RateLimitScope,
  rawIdentity: string | null | undefined,
): Promise<RateDecision> {
  const limit = rateLimitFor(scope);
  const identity = rateLimitIdentity(rawIdentity);
  if (!identity) return decision(0, limit);

  const windowIndex = Math.floor(Date.now() / WINDOW_MS);
  const bucketKey = rateLimitBucketKey(scope, identity, windowIndex);
  const expiresAt = new Date((windowIndex + 2) * WINDOW_MS);

  try {
    const result = (await em.query(BUMP_BUCKET_SQL, [bucketKey, scope, identity, expiresAt])) as {
      insertId?: number;
    };
    return decision(result?.insertId ? result.insertId : 1, limit);
  } catch (error) {
    if ((error as { code?: string })?.code === 'ER_NO_SUCH_TABLE') {
      logger.error(
        '[rate-limit] security_rate_buckets is missing — run npm run db:migrate; requests pass uncounted until then',
      );
      return decision(0, limit, true);
    }
    logger.error('[rate-limit] counter write failed, request refused', error);
    throw error;
  }
}

/** Windows that have closed are dead weight, and this table is written by every guarded request. */
export async function pruneRateBuckets(em: EntityManager): Promise<number> {
  const result = await em.getRepository(SecurityRateBucket).delete({ expiresAt: LessThan(new Date()) });
  return result.affected ?? 0;
}

let pruneTimer: NodeJS.Timeout | null = null;
let pruneInFlight = false;

async function pruneTick(): Promise<void> {
  if (pruneInFlight) return;
  pruneInFlight = true;
  try {
    const removed = await pruneRateBuckets(getDataSource().manager);
    if (removed > 0) logger.info(`[rate-limit] pruned ${removed} closed window(s)`);
  } catch (error) {
    // The rows are only ever a few minutes past their window, so a failed beat costs space, not safety.
    logger.error('[rate-limit] prune tick failed', error);
  } finally {
    pruneInFlight = false;
  }
}

export function startRateBucketPruneJob(): void {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => void pruneTick(), Math.max(60_000, env.rateLimit.pruneIntervalMs));
  pruneTimer.unref();
  logger.info(
    `[rate-limit] prune armed: every ${Math.max(60_000, env.rateLimit.pruneIntervalMs) / 60000} min, ` +
      `window ${WINDOW_MS / 1000}s, ceilings login/ip=${env.rateLimit.loginPerIp} ` +
      `login/user=${env.rateLimit.loginPerUsername} reset/ip=${env.rateLimit.resetPerIp} (0 = off)`,
  );
}

export async function stopRateBucketPruneJob(): Promise<void> {
  if (pruneTimer) clearInterval(pruneTimer);
  pruneTimer = null;
}
