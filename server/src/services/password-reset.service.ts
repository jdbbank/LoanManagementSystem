import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { EntityManager, IsNull, MoreThan } from 'typeorm';
import { env } from '../config/env';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { ResetTokenKind } from '../entities/types';

/**
 * Password-reset secrets. Only a keyed digest of a secret is stored, so a leaked database cannot be
 * turned into a login. Rows survive use for the audit trail.
 *
 * Hashing rather than encrypting is deliberate, and so is the key. A plain SHA-256 was crackable at
 * the size these secrets are: an OTP is six digits, so a dump-holder could hash all million possible
 * codes and match every outstanding row in seconds. With HMAC the attacker needs the pepper as well,
 * which lives in the service's environment rather than in the table it would be read from.
 */
const hashToken = (raw: string): string => createHmac('sha256', env.security.tokenPepper).update(raw).digest('hex');

const ttlMinutes = (kind: ResetTokenKind): number =>
  kind === ResetTokenKind.OTP ? env.security.otpTtlMinutes : env.security.linkTtlMinutes;

export interface IssuedToken {
  raw: string;
  row: PasswordResetToken;
}

/** 6 digits, cryptographically drawn, never sequential. */
export function newOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** URL-safe secret for the one-shot reset link. */
export function newLinkSecret(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Creates a secret of the given kind and retires the user's still-unused secrets of the
 * same kind, so only the newest one ever works.
 */
export async function issueResetToken(
  em: EntityManager,
  input: { userId: string; kind: ResetTokenKind; secret: string; ip?: string | null },
): Promise<IssuedToken> {
  await em
    .createQueryBuilder()
    .update(PasswordResetToken)
    .set({ usedAt: new Date() })
    .where('userId = :userId', { userId: input.userId })
    .andWhere('kind = :kind', { kind: input.kind })
    .andWhere('usedAt IS NULL')
    .execute();

  const row = em.create(PasswordResetToken, {
    userId: input.userId,
    tokenHash: hashToken(input.secret),
    kind: input.kind,
    expiresAt: new Date(Date.now() + ttlMinutes(input.kind) * 60_000),
    requestedIp: input.ip ?? null,
  });
  await em.save(PasswordResetToken, row);
  return { raw: input.secret, row };
}

export async function findActiveSecret(
  em: EntityManager,
  kind: ResetTokenKind,
  secret: string,
): Promise<PasswordResetToken | null> {
  return em.findOne(PasswordResetToken, {
    where: { kind, tokenHash: hashToken(secret), usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
  });
}

/**
 * The live secret of one kind for one account. issueResetToken retires the previous ones,
 * so this is the row a wrong guess must be charged against.
 */
export async function findActiveSecretForUser(
  em: EntityManager,
  userId: string,
  kind: ResetTokenKind,
): Promise<PasswordResetToken | null> {
  return em.findOne(PasswordResetToken, {
    where: { userId, kind, usedAt: IsNull(), expiresAt: MoreThan(new Date()) },
    order: { createdAt: 'DESC' },
  });
}

/**
 * Comparison against the stored digest, so the plaintext never leaves the caller's request.
 *
 * The strings are the same length by construction, so a difference in length is the only case where
 * the answer can be given early; `timingSafeEqual` refuses unequal buffers rather than leaking through
 * the byte it stops on.
 */
export function verifySecret(row: PasswordResetToken, raw: string): boolean {
  const candidate = Buffer.from(hashToken(raw), 'utf8');
  const stored = Buffer.from(row.tokenHash, 'utf8');
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/** Every password in the world invalidates every outstanding secret of that account. */export async function retireAllSecrets(em: EntityManager, userId: string): Promise<number> {
  const result = await em
    .createQueryBuilder()
    .update(PasswordResetToken)
    .set({ usedAt: new Date() })
    .where('userId = :userId', { userId })
    .andWhere('usedAt IS NULL')
    .execute();
  return result.affected ?? 0;
}

/**
 * Spends a secret and says whether THIS caller is the one that spent it. Concurrent requests all
 * read the same unused row, so re-checking `usedAt IS NULL` inside the write is what keeps a code
 * single-use (F-CONC-4).
 */
export async function claimSecret(em: EntityManager, row: PasswordResetToken): Promise<boolean> {
  const result = await em
    .createQueryBuilder()
    .update(PasswordResetToken)
    .set({ usedAt: new Date() })
    .where('id = :id', { id: row.id })
    .andWhere('usedAt IS NULL')
    .execute();
  return (result.affected ?? 0) === 1;
}

export type AttemptOutcome = { kind: 'left'; left: number } | { kind: 'burned' } | { kind: 'spent' };

/**
 * Counts one wrong guess. The counter is raised in SQL rather than in JS, because parallel guesses
 * read-modify-writing the same row lost counts and left a burned code usable (F-CONC-4).
 */
export async function registerBadAttempt(em: EntityManager, row: PasswordResetToken): Promise<AttemptOutcome> {
  await em
    .createQueryBuilder()
    .update(PasswordResetToken)
    .set({ attempts: () => 'attempts + 1' })
    .where('id = :id', { id: row.id })
    .andWhere('usedAt IS NULL')
    .execute();

  const fresh = await em.findOneByOrFail(PasswordResetToken, { id: row.id });
  if (fresh.usedAt) return { kind: 'spent' };

  const left = env.security.otpMaxAttempts - fresh.attempts;
  if (left > 0) return { kind: 'left', left };
  return (await claimSecret(em, row)) ? { kind: 'burned' } : { kind: 'spent' };
}

/** True when this user asked for the same kind of secret inside the cooldown window. */
export async function isWithinCooldown(
  em: EntityManager,
  userId: string,
  kind: ResetTokenKind,
): Promise<boolean> {
  const since = new Date(Date.now() - env.security.requestCooldownSeconds * 1000);
  const row = await em.findOne(PasswordResetToken, {
    where: { userId, kind, createdAt: MoreThan(since) },
  });
  return row !== null;
}

/**
 * Cooldown for one IP across every account, so a forgotten-password form cannot be used
 * to spray codes at a whole user table.
 */
export async function isIpThrottled(em: EntityManager, ip: string | null | undefined): Promise<boolean> {
  if (!ip) return false;
  const since = new Date(Date.now() - env.security.requestCooldownSeconds * 1000);
  const count = await em.count(PasswordResetToken, {
    where: { requestedIp: ip, createdAt: MoreThan(since) },
  });
  return count >= env.security.otpMaxAttempts;
}

/** Housekeeping: expired or spent secrets are dead weight but must stay for the audit trail. */
export async function expireStaleSecrets(em: EntityManager): Promise<number> {
  const result = await em
    .createQueryBuilder()
    .update(PasswordResetToken)
    .set({ usedAt: new Date() })
    .where('usedAt IS NULL')
    .andWhere('expiresAt < :now', { now: new Date() })
    .execute();
  return result.affected ?? 0;
}
