import { describe, expect, it } from 'vitest';
import { isSessionRevoked, sessionRejection } from './auth';
import { AccountLockReason } from '../entities/types';

// The whole finding is one second: a password change lands inside a second that `iat` also names.
const CHANGED = new Date('2026-10-14T03:42:40.345Z');
const ms = (iso: string) => Date.parse(iso);
const iat = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('isSessionRevoked (a password change drops the sessions that precede it)', () => {
  it('revokes a token minted earlier in the same second as the change', () => {
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:40Z'), mintedAtMs: ms('2026-10-14T03:42:40.100Z') })).toBe(true);
  });

  it('keeps the sign-in made just after the change, still inside that second', () => {
    const changed = new Date('2026-10-14T03:42:44.747Z');
    expect(isSessionRevoked(changed, { iat: iat('2026-10-14T03:42:44Z'), mintedAtMs: ms('2026-10-14T03:42:44.900Z') })).toBe(false);
  });

  it('keeps a token minted exactly at the change instant', () => {
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:40Z'), mintedAtMs: CHANGED.getTime() })).toBe(false);
  });

  it('revokes a token from the previous second and keeps one from the next', () => {
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:39Z'), mintedAtMs: ms('2026-10-14T03:42:39.999Z') })).toBe(true);
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:41Z'), mintedAtMs: ms('2026-10-14T03:42:41.001Z') })).toBe(false);
  });

  it('reads a token without the mint instant at the start of its iat second, so it can only be dropped early', () => {
    // Both of these were minted after the change, yet the coarsest reading of `iat` is its second's start.
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:40Z') })).toBe(true);
    expect(isSessionRevoked(CHANGED, {})).toBe(true);
    expect(isSessionRevoked(CHANGED, { iat: iat('2026-10-14T03:42:41Z') })).toBe(false);
  });

  it('never revokes an account that has no recorded change time', () => {
    expect(isSessionRevoked(null, { iat: iat('2026-10-14T03:42:41Z') })).toBe(false);
  });
});

describe('sessionRejection (what a held-over token still is not allowed to do)', () => {
  const LOCKED_AT = new Date('2026-10-14T05:00:00.000Z');
  const on = (
    overrides: Partial<{ isActive: boolean; lockedAt: Date | null; lockReason: AccountLockReason | null }> = {},
  ) => ({
    isActive: true,
    lockedAt: null as Date | null,
    lockReason: null as AccountLockReason | null,
    passwordChangedAt: CHANGED,
    ...overrides,
  });
  // Minted after the change, so nothing but the flags below can drop it.
  const live = { iat: iat('2026-10-14T03:42:41Z'), mintedAtMs: ms('2026-10-14T03:42:41.001Z') };
  // Minted before the change, so the session is revoked on its own.
  const stale = { iat: iat('2026-10-14T03:42:39Z'), mintedAtMs: ms('2026-10-14T03:42:39.999Z') };

  it('keeps a token the account still holds the right to use', () => {
    expect(sessionRejection(on(), live)).toBeNull();
  });

  it('drops the session of a disabled account', () => {
    const rejection = sessionRejection(on({ isActive: false }), live);
    expect(rejection?.status).toBe(401);
    expect(rejection?.message).toBe('Account is disabled');
  });

  it('drops the session a lock overtook, with the answer login gives', () => {
    // The sweep, or a guess reaching the failure limit, can lock an account that is already signed in;
    // without this branch it keeps working until its token expires on its own.
    const rejection = sessionRejection(on({ lockedAt: LOCKED_AT, lockReason: AccountLockReason.IDLE }), live);
    expect(rejection?.status).toBe(403);
    expect(rejection?.details).toEqual({
      code: 'ACCOUNT_LOCKED',
      lockReason: AccountLockReason.IDLE,
      lockedAt: LOCKED_AT,
    });
    expect(rejection?.message).toContain('ADMIN');
    expect(rejection?.message).toContain('not signed in for a long time');
  });

  it('names the lock when the account is locked and its session is revoked as well', () => {
    // Both are true the moment a password changes under a locked account, and only one of the two
    // answers tells the person who to ask.
    const rejection = sessionRejection(
      on({ lockedAt: LOCKED_AT, lockReason: AccountLockReason.FAILED_ATTEMPTS }),
      stale,
    );
    expect(rejection?.status).toBe(403);
    expect(rejection?.message).toContain('failed sign-in attempts');
  });

  it('still revokes a token minted before the password changed', () => {
    const rejection = sessionRejection(on(), stale);
    expect(rejection?.status).toBe(401);
    expect(rejection?.message).toBe('Session is no longer valid, please sign in again');
  });
});
