import { describe, expect, it } from 'vitest';
import { redactSecretsFrom } from './logger';

describe('redactSecretsFrom (last line of defence before the log file)', () => {
  it('hides the OTP digits in the Lao reset-code subject', () => {
    const line = '[notify:log] PASSWORD_RESET_OTP -> a@b.la | ເລກຢືນຢັນ 052783 ສຳລັບການຕັ້ງລະຫັດຜ່ານໃໝ່';
    const out = redactSecretsFrom(line);
    expect(out).not.toContain('052783');
    expect(out).toContain('<redacted>');
  });

  it('hides the OTP digits in an English verification-code subject', () => {
    expect(redactSecretsFrom('Your verification code is 482913')).not.toContain('482913');
  });

  it('hides a reset token carried in a URL', () => {
    const out = redactSecretsFrom('open /reset-password?token=Zm9vYmFyMTIzNDU2Nzg5YWJjZGVm');
    expect(out).not.toContain('Zm9vYmFy');
    expect(out).toContain('<redacted>');
  });

  it('leaves ordinary financial lines untouched', () => {
    const line = '[pay] posted 300000 LAK on LN-000123';
    expect(redactSecretsFrom(line)).toBe(line);
  });
});
