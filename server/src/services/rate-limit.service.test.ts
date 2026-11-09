import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { RateLimitScope } from '../entities/types';
import { rateLimitBucketKey, rateLimitFor, rateLimitIdentity } from './rate-limit.service';

describe('request ceilings', () => {
  it('folds an account key the way the database compares one', () => {
    // MySQL matches usernames case-insensitively, so "Admin" and "admin" are one account and have to
    // share one counter or the ceiling is a suggestion.
    expect(rateLimitIdentity('  Admin ')).toBe(rateLimitIdentity('admin'));
    expect(rateLimitIdentity(null)).toBe('');
    expect(rateLimitIdentity(undefined)).toBe('');
  });

  it('keeps a key inside the column that stores it', () => {
    const key = rateLimitBucketKey(RateLimitScope.LOGIN_USERNAME, rateLimitIdentity('u'.repeat(500)), 7);
    expect(key.length).toBeLessThanOrEqual(191);
    expect(key.startsWith(`${RateLimitScope.LOGIN_USERNAME}:`)).toBe(true);
    expect(key.endsWith(':7')).toBe(true);
  });

  it('gives every window its own row instead of resetting one', () => {
    const identity = rateLimitIdentity('maker1');
    expect(rateLimitBucketKey(RateLimitScope.LOGIN_IP, identity, 100)).not.toBe(
      rateLimitBucketKey(RateLimitScope.LOGIN_IP, identity, 101),
    );
  });

  it('takes its ceilings from the environment and never goes negative', () => {
    expect(rateLimitFor(RateLimitScope.LOGIN_IP)).toBe(Math.max(0, env.rateLimit.loginPerIp));
    expect(rateLimitFor(RateLimitScope.RESET_IP)).toBe(Math.max(0, env.rateLimit.resetPerIp));
  });

  it('keeps the account ceiling the tighter of the two sign-in ceilings', () => {
    // The device ceiling exists to blunt a spread across many accounts; guessing one password is
    // stopped by the account ceiling and the failure lock, so it must never be the looser of the two.
    expect(rateLimitFor(RateLimitScope.LOGIN_USERNAME)).toBeLessThanOrEqual(
      rateLimitFor(RateLimitScope.LOGIN_IP),
    );
  });

  it('sizes a window from the environment', () => {
    expect(env.rateLimit.windowSeconds).toBeGreaterThan(0);
    expect(env.rateLimit.pruneIntervalMs).toBeGreaterThanOrEqual(env.rateLimit.windowSeconds * 1000);
  });
});
