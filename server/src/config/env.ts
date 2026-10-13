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

export const env = {
  port: parseInt(requireEnv('PORT', '4000'), 10),
  nodeEnv: requireEnv('NODE_ENV', 'development'),
  isProduction: process.env.NODE_ENV === 'production',
  /** Public address of the web app, used whenever an email carries a link back to the UI. */
  webBaseUrl: requireEnv('WEB_PUBLIC_URL', 'http://localhost:5173'),

  db: {
    host: requireEnv('DB_HOST', '127.0.0.1'),
    port: parseInt(requireEnv('DB_PORT', '3307'), 10),
    user: requireEnv('DB_USER', 'root'),
    password: requireEnv('DB_PASSWORD', 'loanpass'),
    name: requireEnv('DB_NAME', 'loan_management'),
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
  },
  jwt: {
    secret: requireEnv('JWT_SECRET', 'dev-secret'),
    expiresIn: requireEnv('JWT_EXPIRES_IN', '12h'),
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
  /** Forgot-password timings. The OTP/link secrets themselves are only ever stored hashed. */
  security: {
    otpTtlMinutes: parseInt(requireEnv('RESET_OTP_TTL_MINUTES', '10'), 10),
    otpMaxAttempts: parseInt(requireEnv('RESET_OTP_MAX_ATTEMPTS', '5'), 10),
    linkTtlMinutes: parseInt(requireEnv('RESET_LINK_TTL_MINUTES', '60'), 10),
    requestCooldownSeconds: parseInt(requireEnv('RESET_REQUEST_COOLDOWN_SECONDS', '60'), 10),
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
