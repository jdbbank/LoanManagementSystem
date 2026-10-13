import { describe, expect, it } from 'vitest';
import { seal, sealJson, unseal, unsealJson } from './seal';

describe('seal (notification outbox at-rest encryption)', () => {
  it('round-trips a secret payload', () => {
    const sealed = seal('otp=482913');
    expect(sealed.startsWith('sealed:v1:')).toBe(true);
    expect(sealed).not.toContain('482913');
    expect(unseal(sealed)).toBe('otp=482913');
  });

  it('uses a fresh IV per call so identical plaintexts never share ciphertext', () => {
    expect(seal('same')).not.toBe(seal('same'));
  });

  it('detects tampering through the GCM auth tag', () => {
    const sealed = seal('https://app/reset?token=abc');
    const parts = sealed.slice('sealed:v1:'.length).split('.');
    const data = Buffer.from(parts[2], 'base64');
    data[0] ^= 0xff;
    parts[2] = data.toString('base64');
    expect(() => unseal(`sealed:v1:${parts.join('.')}`)).toThrow();
  });

  it('leaves legacy unsealed rows readable', () => {
    expect(unseal('plain text written before sealing existed')).toBe('plain text written before sealing existed');
  });

  it('round-trips JSON', () => {
    const value = { otp: '482913', username: 'maker1', expiresMinutes: 10 };
    expect(unsealJson<typeof value>(sealJson(value))).toEqual(value);
  });
});
