import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { env } from '../config/env';

const PREFIX = 'sealed:v1:';

/** One key for the whole deployment: the notification secret is an env value, not per row. */
const KEY = createHash('sha256').update(env.notification.secretKey).digest();

/**
 * AES-256-GCM for anything that has to carry a secret (OTP, reset link) into the outbox, so a
 * database dump never shows it in plain text. The dispatcher opens it again at send time.
 */
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

/** Rows written before sealing existed, or rows that never carried a secret, stay readable. */
export function unseal(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const [iv, tag, data] = value.slice(PREFIX.length).split('.');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

export const sealJson = (value: unknown): string => seal(JSON.stringify(value));

export function unsealJson<T>(value: string): T {
  return JSON.parse(unseal(value)) as T;
}
