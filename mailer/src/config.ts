import 'dotenv/config';

function req(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function int(key: string, fallback: number): number {
  const value = parseInt(process.env[key] ?? `${fallback}`, 10);
  return Number.isFinite(value) ? value : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function csv(key: string, fallback: string): string[] {
  return req(key, fallback)
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export const config = {
  port: int('MAILER_PORT', 4100),
  /** Shared secret the backend must present on POST /api/send. */
  apiKey: req('MAILER_API_KEY', 'dev-mailer-key'),
  kafka: {
    enabled: bool('KAFKA_CONSUMER_ENABLED', false),
    brokers: csv('KAFKA_BROKERS', '127.0.0.1:9092'),
    clientId: req('KAFKA_CLIENT_ID', 'loan-mailer'),
    group: req('KAFKA_CONSUMER_GROUP', 'mailer-send'),
    topic: req('KAFKA_TOPIC', 'loan.notification'),
    dlqTopic: req('KAFKA_DLQ_TOPIC', 'loan.notification.dlq'),
  },
// SMTP_HOST=null
// SMTP_PORT=587
// SMTP_USER=card.jdb.register@gmail.com
// SMTP_PASS=vusc puxu quub wpux
// MAIL_FROM="POS Support <noreply@example.com>"
// SERVICE=gmail
  smtp: {
    /** Empty host = no mail provider configured, so messages are printed instead of sent. */
    host: req('SMTP_HOST', ''),
    port: int('SMTP_PORT', 587),
    secure: bool('SMTP_SECURE', false),
    user: req('SMTP_USER', 'card.jdb.register@gmail.com'),
    password: req('SMTP_PASSWORD', 'vusc puxu quub wpux'),
    from: req('MAIL_FROM', 'Loan Management System <no-reply@loanms.local>'),
  },
  sendAttempts: int('MAILER_SEND_ATTEMPTS', 3),
};
