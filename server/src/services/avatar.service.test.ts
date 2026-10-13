import { describe, expect, it } from 'vitest';
import type { AvatarPolicy } from '../entities/types';
import { AVATAR_CONFIG_KEYS, DEFAULT_AVATAR_POLICY } from './avatar-policy.service';
import { assertAvatarAllowed } from './avatar.service';
import { AppError } from '../utils/errors';

const POLICY: AvatarPolicy = {
  enabled: true,
  maxFileSizeKb: 1,
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
};

/** Bytes that start with a real magic signature, padded to a plausible size. */
const bytes = (head: number[]): Buffer =>
  Buffer.from([...head, ...Array.from({ length: 40 }, (_, i) => (i * 7) % 251)]);

const jpeg = bytes([0xff, 0xd8, 0xff]);
const png = bytes([0x89, 0x50, 0x4e, 0x47]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WEBP'), Buffer.alloc(32)]);

const messageOf = (run: () => unknown): { status?: number; message: string } => {
  try {
    run();
    return { message: 'no error' };
  } catch (error) {
    return { status: (error as AppError).status, message: (error as Error).message };
  }
};

describe('avatar policy registry', () => {
  it('has a system_config key for every policy field, all avatar.-prefixed', () => {
    const fields = Object.keys(DEFAULT_AVATAR_POLICY) as (keyof AvatarPolicy)[];
    expect(Object.keys(AVATAR_CONFIG_KEYS).sort()).toEqual(fields.sort());
    expect(Object.values(AVATAR_CONFIG_KEYS).every((entry) => entry.key.startsWith('avatar.'))).toBe(true);
  });
});

describe('assertAvatarAllowed', () => {
  it('accepts the three image signatures', () => {
    expect(assertAvatarAllowed(POLICY, jpeg).mimeType).toBe('image/jpeg');
    expect(assertAvatarAllowed(POLICY, png).mimeType).toBe('image/png');
    expect(assertAvatarAllowed(POLICY, webp).mimeType).toBe('image/webp');
  });

  it('rejects anything that is not an image, whatever the file name claims', () => {
    const pdf = Buffer.from('%PDF-1.7'.padEnd(64, 'A'));
    const result = messageOf(() => assertAvatarAllowed(POLICY, pdf));
    expect(result.status).toBe(415);
    expect(result.message).toContain('Only image uploads');
  });

  it('rejects a mime type the policy does not allow', () => {
    const result = messageOf(() =>
      assertAvatarAllowed({ ...POLICY, allowedMimeTypes: ['image/png'] }, jpeg),
    );
    expect(result.status).toBe(415);
    expect(result.message).toContain('image/jpeg');
  });

  it('rejects an image over the configured size', () => {
    const big = Buffer.concat([jpeg, Buffer.alloc(1024 * 1024)]);
    const result = messageOf(() => assertAvatarAllowed(POLICY, big));
    expect(result.status).toBe(422);
    expect(result.message).toContain('too large');
  });

  it('refuses every upload while avatars are switched off', () => {
    const result = messageOf(() => assertAvatarAllowed({ ...POLICY, enabled: false }, jpeg));
    expect(result.status).toBe(422);
    expect(result.message).toContain('disabled');
  });

  it('rejects a truncated buffer that cannot carry a signature', () => {
    expect(messageOf(() => assertAvatarAllowed(POLICY, Buffer.from([0xff, 0xd8]))).status).toBe(415);
  });
});
