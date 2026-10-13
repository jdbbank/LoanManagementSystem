import { describe, expect, it } from 'vitest';
import type { PasswordPolicy } from '../entities/types';
import {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_CONFIG_KEYS,
  assertPasswordAllowed,
  describePasswordPolicy,
  passwordPolicyChecksum,
  passwordViolations,
} from './password-policy.service';
import { AppError } from '../utils/errors';

const POLICY: PasswordPolicy = {
  minLength: 6,
  maxLength: 8,
  requireDigit: true,
  requireUppercase: true,
  requireLowercase: true,
  requireSymbol: false,
};

describe('password configuration registry', () => {
  it('has a system_config key for every policy field', () => {
    const fields = Object.keys(DEFAULT_PASSWORD_POLICY) as (keyof PasswordPolicy)[];
    expect(Object.keys(PASSWORD_CONFIG_KEYS).sort()).toEqual(fields.sort());
  });

  it('names every key with the password. prefix and no duplicates', () => {
    const keys = Object.values(PASSWORD_CONFIG_KEYS).map((entry) => entry.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key.startsWith('password.'))).toBe(true);
  });
});

describe('passwordViolations', () => {
  it('accepts a password that matches every rule', () => {
    expect(passwordViolations(POLICY, 'Admin123')).toEqual([]);
  });

  it('reports length and character gaps as machine-readable codes', () => {
    expect(passwordViolations(POLICY, 'Ab1')).toEqual(['TOO_SHORT']);
    expect(passwordViolations(POLICY, 'Admin1234')).toEqual(['TOO_LONG']);
    expect(passwordViolations(POLICY, 'admin123')).toEqual(['MISSING_UPPERCASE']);
    expect(passwordViolations(POLICY, 'ADMIN123')).toEqual(['MISSING_LOWERCASE']);
    expect(passwordViolations(POLICY, 'Adminabc')).toEqual(['MISSING_DIGIT']);
  });

  it('only demands a symbol when the policy asks for one', () => {
    expect(passwordViolations(POLICY, 'Admin123')).not.toContain('MISSING_SYMBOL');
    expect(passwordViolations({ ...POLICY, requireSymbol: true }, 'Admin123')).toEqual(['MISSING_SYMBOL']);
  });

  it('can fall back to a length-only rule set', () => {
    const lengthOnly: PasswordPolicy = {
      ...POLICY,
      requireDigit: false,
      requireUppercase: false,
      requireLowercase: false,
    };
    expect(passwordViolations(lengthOnly, 'abcdefgh')).toEqual([]);
  });
});

describe('assertPasswordAllowed', () => {
  it('throws an unprocessable error listing every violation', () => {
    let thrown: unknown = null;
    try {
      assertPasswordAllowed(POLICY, 'abc');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).status).toBe(422);
    expect((thrown as AppError).message).toContain('TOO_SHORT');
    expect((thrown as AppError).message).toContain('MISSING_UPPERCASE');
    expect((thrown as AppError).message).toContain('MISSING_DIGIT');
  });

  it('keeps the shipped defaults wide enough for the seeded demo accounts', () => {
    // Regression guard: tightening the default must never lock out a documented login.
    expect(passwordViolations(DEFAULT_PASSWORD_POLICY, 'Admin@123')).toEqual([]);
  });
});

describe('describePasswordPolicy', () => {
  it('summarises length range and the enabled character rules', () => {
    expect(describePasswordPolicy(POLICY)).toBe('length 6-8, digit|uppercase|lowercase');
    expect(describePasswordPolicy({ ...POLICY, requireDigit: false, requireSymbol: true })).toBe(
      'length 6-8, uppercase|lowercase|symbol',
    );
  });

  it('checksums the same policy identically and a changed one differently', () => {
    expect(passwordPolicyChecksum(POLICY)).toBe(passwordPolicyChecksum({ ...POLICY }));
    expect(passwordPolicyChecksum(POLICY)).not.toBe(passwordPolicyChecksum({ ...POLICY, minLength: 7 }));
  });
});
