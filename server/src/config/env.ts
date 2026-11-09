import 'dotenv/config';

function requireEnv(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Boolean env flag — values are case-insensitive 'true'/'1'. */
function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

/** Which physical transport carries rendered notifications out of the backend. */
export type NotifyTransport = 'log' | 'kafka' | 'http';

const NOTIFY_TRANSPORTS: NotifyTransport[] = ['log', 'kafka', 'http'];

function transportEnv(key: string, fallback: NotifyTransport): NotifyTransport {
  const value = (process.env[key] ?? fallback).trim().toLowerCase();
  return (NOTIFY_TRANSPORTS as string[]).includes(value) ? (value as NotifyTransport) : 'log';
}

/**
 * Browser origins allowed to call the API cross-origin. The web app reaches the API through
 * same-origin paths in every known deployment (the Vite dev server proxies `/api`, the web image
 * proxies `/api` to the backend), so the default is an empty list and nothing gets an
 * Access-Control-Allow-Origin header. An origin only belongs here when a real client calls the API
 * from a different scheme/host/port, which is what the wildcard CORS setting used to allow for
 * every website on the internet.
 */
function originListEnv(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v.length > 0);
}

export const env = {
  port: parseInt(requireEnv('PORT', '4000'), 10),
  nodeEnv: requireEnv('NODE_ENV', 'development'),
  isProduction: process.env.NODE_ENV === 'production',
  /** Public address of the web app, used whenever an email carries a link back to the UI. */
  webBaseUrl: requireEnv('WEB_PUBLIC_URL', 'http://localhost:5173'),
  cors: {
    allowList: originListEnv('CORS_ALLOWED_ORIGINS'),
  },
  /**
   * Which organisation this deployment answers for, while it still answers for only one. The code, not
   * the row id, is what belongs in an environment: it is the value an operator can read and set, and
   * the migration seeds the tenant under the same name.
   */
  tenant: {
    defaultCode: requireEnv('DEFAULT_TENANT_CODE', 'default'),
  },

  db: {
    host: requireEnv('DB_HOST', '127.0.0.1'),
    port: parseInt(requireEnv('DB_PORT', '3307'), 10),
    user: requireEnv('DB_USER', 'root'),
    password: requireEnv('DB_PASSWORD', 'loanpass'),
    name: requireEnv('DB_NAME', 'loan_management'),
    /**
     * Escape hatch only. The schema of record is `src/migrations`, applied by `npm run db:migrate`;
     * this flag lets a scratch database be rebuilt from the entities instead. It is deliberately not
     * implied by NODE_ENV any more, so no environment can silently rewrite the tables under a migration.
     */
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
  },
  jwt: {
    secret: requireEnv('JWT_SECRET', 'dev-secret'),
    expiresIn: requireEnv('JWT_EXPIRES_IN', '1h'),
  },
  /**
   * Lowest layer of the KYC policy. Every value can be overridden at runtime by the
   * matching `kyc.*` row in system_config (ADMIN edits it through /api/config/kyc).
   */
  kyc: {
    maxFileSizeKb: parseInt(requireEnv('KYC_MAX_FILE_SIZE_KB', '5120'), 10),
    maxFilesPerRequest: parseInt(requireEnv('KYC_MAX_FILES_PER_REQUEST', '1'), 10),
    allowedMimeTypes: requireEnv('KYC_ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp'),
    allowedDocumentTypes: requireEnv(
      'KYC_ALLOWED_DOCUMENT_TYPES',
      'NATIONAL_ID,ID_CARD,PASSPORT,FAMILY_BOOK,SELFIE_WITH_ID,SIGNATURE',
    ),
    requiredIdentityTypes: requireEnv('KYC_REQUIRED_IDENTITY_TYPES', 'NATIONAL_ID,ID_CARD,PASSPORT'),
    requireSelfieWithId: boolEnv('KYC_REQUIRE_SELFIE_WITH_ID', true),
    requireSignature: boolEnv('KYC_REQUIRE_SIGNATURE', true),
    requireFamilyBook: boolEnv('KYC_REQUIRE_FAMILY_BOOK', false),
    acceptExpiredDocuments: boolEnv('KYC_ACCEPT_EXPIRED_DOCUMENTS', false),
    expiryWarningDays: parseInt(requireEnv('KYC_EXPIRY_WARNING_DAYS', '60'), 10),
    maxTotalBytesPerCustomer: parseInt(requireEnv('KYC_MAX_TOTAL_BYTES_PER_CUSTOMER', '31457280'), 10),
    blockDisbursementUntilVerified: boolEnv('KYC_BLOCK_DISBURSEMENT_UNTIL_VERIFIED', true),
    reverifyOnDocumentChange: boolEnv('KYC_REVERIFY_ON_DOCUMENT_CHANGE', true),
  },
  /**
   * Lowest layer of the repayment-collection policy; `payment.*` rows in system_config override it
   * at runtime through /api/config/payment, same layering as the KYC and password policies.
   * The job starts switched off on purpose: no branch should have money move by itself until an
   * ADMIN turns it on.
   */
  payment: {
    autoDebitLeadDays: parseInt(requireEnv('AUTO_DEBIT_LEAD_DAYS', '3'), 10),
    autoDebitEnabled: boolEnv('AUTO_DEBIT_ENABLED', false),
    /** How often the job looks for instalments entering its lead window. */
    pollIntervalMs: parseInt(requireEnv('AUTO_DEBIT_POLL_INTERVAL_MS', '900000'), 10),
  },
  /**
   * Lowest layer of the collateral policy; `collateral.*` rows in system_config override it at runtime
   * through /api/config/collateral, same layering as the KYC, payment and password policies.
   * Coverage is measured against what is still owed, so 100 means the pledges are worth the debt.
   */
  collateral: {
    minCoveragePercent: parseInt(requireEnv('COLLATERAL_MIN_COVERAGE_PERCENT', '100'), 10),
    maxValuationAgeDays: parseInt(requireEnv('COLLATERAL_MAX_VALUATION_AGE_DAYS', '365'), 10),
    requirePledgeForRestructure: boolEnv('COLLATERAL_REQUIRE_PLEDGE_FOR_RESTRUCTURE', true),
  },
  /**
   * Lowest layer of the financial-evidence policy; `evidence.*` rows in system_config override it at
   * runtime through /api/config/evidence, same layering as the KYC and collateral policies. The quota
   * is per owner — one customer or one loan — and separate from the KYC quota, so filing a transfer
   * slip can never eat the space a customer's identity documents are stored in.
   */
  evidence: {
    maxFileSizeKb: parseInt(requireEnv('EVIDENCE_MAX_FILE_SIZE_KB', '2048'), 10),
    maxFilesPerRequest: parseInt(requireEnv('EVIDENCE_MAX_FILES_PER_REQUEST', '1'), 10),
    allowedMimeTypes: requireEnv('EVIDENCE_ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp'),
    maxTotalBytesPerOwner: parseInt(requireEnv('EVIDENCE_MAX_TOTAL_BYTES_PER_OWNER', '10485760'), 10),
  },
  /**
   * Lowest layer of the password rules; `password.*` rows in system_config override it
   * at runtime, same layering as the KYC policy. The defaults accept the seeded demo
   * passwords (e.g. `Admin@123`, 9 characters); a branch that wants 6-8 characters
   * tightens maxLength to 8 through /api/config/password without a restart.
   */
  password: {
    minLength: parseInt(requireEnv('PASSWORD_MIN_LENGTH', '6'), 10),
    maxLength: parseInt(requireEnv('PASSWORD_MAX_LENGTH', '16'), 10),
    requireDigit: boolEnv('PASSWORD_REQUIRE_DIGIT', true),
    requireUppercase: boolEnv('PASSWORD_REQUIRE_UPPERCASE', true),
    requireLowercase: boolEnv('PASSWORD_REQUIRE_LOWERCASE', true),
    requireSymbol: boolEnv('PASSWORD_REQUIRE_SYMBOL', false),
  },
  /** Limits for staff avatar images; `avatar.*` rows override them at runtime. */
  avatar: {
    enabled: boolEnv('AVATAR_ENABLED', true),
    maxFileSizeKb: parseInt(requireEnv('AVATAR_MAX_FILE_SIZE_KB', '512'), 10),
    allowedMimeTypes: requireEnv('AVATAR_ALLOWED_MIME_TYPES', 'image/jpeg,image/png,image/webp'),
  },
  /**
   * Forgot-password timings and the lowest layer of the account-security policy. The secrets
   * themselves are only ever stored hashed; `security.*` rows in system_config override the
   * login-lock, idle-lock and password-age values at runtime through /api/config/security.
   * The sweep job starts switched off on purpose, exactly like the auto-debit job: turning the
   * 90-day rule into a visible database state is an ADMIN decision, not a restart one.
   */
  security: {
    otpTtlMinutes: parseInt(requireEnv('RESET_OTP_TTL_MINUTES', '10'), 10),
    otpMaxAttempts: parseInt(requireEnv('RESET_OTP_MAX_ATTEMPTS', '5'), 10),
    linkTtlMinutes: parseInt(requireEnv('RESET_LINK_TTL_MINUTES', '60'), 10),
    requestCooldownSeconds: parseInt(requireEnv('RESET_REQUEST_COOLDOWN_SECONDS', '60'), 10),
    maxFailedAttempts: parseInt(requireEnv('ACCOUNT_MAX_FAILED_ATTEMPTS', '3'), 10),
    idleLockDays: parseInt(requireEnv('ACCOUNT_IDLE_LOCK_DAYS', '90'), 10),
    idleLockJobEnabled: boolEnv('ACCOUNT_IDLE_LOCK_JOB_ENABLED', false),
    idleLockPollHours: parseInt(requireEnv('ACCOUNT_IDLE_LOCK_POLL_HOURS', '24'), 10),
    passwordMaxAgeDays: parseInt(requireEnv('PASSWORD_MAX_AGE_DAYS', '30'), 10),
    passwordExpiryWarnDays: parseInt(requireEnv('PASSWORD_EXPIRY_WARN_DAYS', '7'), 10),
    passwordHistoryCount: parseInt(requireEnv('PASSWORD_HISTORY_COUNT', '5'), 10),
    applyToAdminAccounts: boolEnv('SECURITY_APPLY_TO_ADMIN_ACCOUNTS', true),
    /**
     * Key that turns a reset secret into something a database dump cannot read back. SHA-256 alone
     * was crackable: a 6-digit OTP has a million possible values, so an attacker holding the table
     * could hash all of them and match a row in seconds. With a keyed digest the key has to be found
     * before any code can be recovered. Rotate it knowing that every outstanding code stops working.
     */
    tokenPepper: requireEnv('RESET_TOKEN_PEPPER', 'dev-reset-token-pepper-change-me'),
  },
  /**
   * Fixed-window request ceilings for the endpoints that take a password or a reset secret.
   *
   * They are env-only on purpose, unlike the policies that ADMIN edits at runtime: these numbers
   * guard the door, so the path to changing them is a deploy an operator controls rather than a
   * request through the door they protect. `0` switches one ceiling off, the same reading every other
   * numeric rule in this file gives 0.
   *
   * The per-address sign-in ceiling is deliberately far above the per-account one. Behind one office
   * address the whole branch signs in through it, and a ceiling tuned for an attacker would lock out
   * the staff it is supposed to protect; guessing one person's password is stopped by the account
   * failure lock and by `loginPerUsername` long before this number is reached.
   */
  rateLimit: {
    windowSeconds: parseInt(requireEnv('RATE_LIMIT_WINDOW_SECONDS', '60'), 10),
    loginPerIp: parseInt(requireEnv('RATE_LIMIT_LOGIN_PER_IP', '120'), 10),
    loginPerUsername: parseInt(requireEnv('RATE_LIMIT_LOGIN_PER_USERNAME', '15'), 10),
    resetPerIp: parseInt(requireEnv('RATE_LIMIT_RESET_PER_IP', '60'), 10),
    pruneIntervalMs: parseInt(requireEnv('RATE_LIMIT_PRUNE_INTERVAL_MS', '300000'), 10),
  },
  /**
   * Notification pipeline. The backend renders the email from its own templates and
   * writes it to the outbox; this block only says how the outbox is drained.
   */
  notification: {
    enabled: boolEnv('NOTIFY_ENABLED', true),
    transport: transportEnv('NOTIFY_TRANSPORT', 'log'),
    defaultLocale: requireEnv('NOTIFY_DEFAULT_LOCALE', 'lo'),
    pollIntervalMs: parseInt(requireEnv('NOTIFY_POLL_INTERVAL_MS', '5000'), 10),
    batchSize: parseInt(requireEnv('NOTIFY_BATCH_SIZE', '20'), 10),
    maxAttempts: parseInt(requireEnv('NOTIFY_MAX_ATTEMPTS', '5'), 10),
    backoffSeconds: parseInt(requireEnv('NOTIFY_BACKOFF_SECONDS', '30'), 10),
    /** Key that seals the outbox bodies; rotate it with NOTIFY_SECRET_KEY. */
    secretKey: requireEnv('NOTIFY_SECRET_KEY', 'dev-notify-sealing-key-change-me'),
  },
  kafka: {
    brokers: requireEnv('KAFKA_BROKERS', '127.0.0.1:9092')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0),
    clientId: requireEnv('KAFKA_CLIENT_ID', 'loan-ms'),
    topic: requireEnv('KAFKA_TOPIC', 'loan.notification'),
    dlqTopic: requireEnv('KAFKA_DLQ_TOPIC', 'loan.notification.dlq'),
  },
  mailer: {
    baseUrl: requireEnv('MAILER_BASE_URL', 'http://127.0.0.1:4100'),
    apiKey: requireEnv('MAILER_API_KEY', 'dev-mailer-key'),
  },
  seedOnBoot: (process.env.SEED_ON_BOOT ?? 'true') === 'true',
};

export const TEST_ENV = {
  dbName: 'loan_test',
};
