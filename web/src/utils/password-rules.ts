import type { PasswordPolicy } from '../api/types';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Rule list built from the live policy so a hint can never drift from what the server enforces. */
export function passwordRuleHints(policy: PasswordPolicy | undefined, t: Translate): string {
  if (!policy) return '';
  const required = [
    policy.requireDigit ? t('users.ruleDigit') : null,
    policy.requireUppercase ? t('users.ruleUppercase') : null,
    policy.requireLowercase ? t('users.ruleLowercase') : null,
    policy.requireSymbol ? t('users.ruleSymbol') : null,
  ].filter(Boolean);
  return t('users.passwordRules', {
    min: policy.minLength,
    max: policy.maxLength,
    rules: required.length > 0 ? required.join(', ') : t('users.passwordLengthOnly'),
  });
}
