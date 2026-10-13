import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { env } from '../config/env';
import { PasswordResetToken } from '../entities/password-reset-token.entity';
import { ResetTokenKind } from '../entities/types';
import { newLinkSecret, newOtp, verifySecret } from './password-reset.service';

/** Only the hash matters to verifySecret, so a partial row is enough. */
const storedRow = (raw: string): PasswordResetToken =>
  ({ tokenHash: createHash('sha256').update(raw).digest('hex') }) as PasswordResetToken;

describe('password reset secrets', () => {
  it('draws a fixed-width numeric code', () => {
    for (let i = 0; i < 200; i += 1) expect(newOtp()).toMatch(/^\d{6}$/);
  });

  it('draws codes that are not sequential', () => {
    const codes = new Set(Array.from({ length: 200 }, () => newOtp()));
    expect(codes.size).toBeGreaterThan(150);
  });

  it('issues a link secret that survives a query string untouched', () => {
    const secret = newLinkSecret();
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(secret.length).toBeGreaterThanOrEqual(32);
  });

  it('matches a guess against the stored hash only', () => {
    const secret = newOtp();
    const wrong = secret === '000000' ? '111111' : '000000';
    expect(verifySecret(storedRow(secret), secret)).toBe(true);
    expect(verifySecret(storedRow(secret), wrong)).toBe(false);
  });

  it('keeps the code window shorter than the link window', () => {
    expect(env.security.otpTtlMinutes).toBeLessThan(env.security.linkTtlMinutes);
    expect(env.security.otpMaxAttempts).toBeGreaterThan(0);
    expect(ResetTokenKind.OTP).not.toBe(ResetTokenKind.LINK);
  });
});
