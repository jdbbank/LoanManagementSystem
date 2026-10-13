import nodemailer from 'nodemailer';
import { config } from './config';
import { log } from './log';
import { isNotificationEvent, NotificationEvent } from './types';

/**
 * With no SMTP host configured the transport still "sends" — it returns the message as
 * JSON. Local runs and tests then exercise the exact same code path as production.
 */
const transporter = config.smtp.host
  ? nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
    })
  : nodemailer.createTransport({ jsonTransport: true });

/** Header injection guard: no line breaks, no stray quotes in the display name. */
const headerSafe = (value: string): string => value.replace(/[\r\n]+/g, ' ').trim();
const displayName = (value: string): string => headerSafe(value).replace(/["\\]/g, '');

async function sendOnce(event: NotificationEvent): Promise<void> {
  await transporter.sendMail({
    from: config.smtp.from,
    to: `"${displayName(event.to.fullName)}" <${headerSafe(event.to.email)}>`,
    subject: headerSafe(event.subject),
    html: event.html,
    text: event.text,
    headers: {
      'X-Loan-Event-Id': headerSafe(event.eventId),
      'X-Loan-Event-Type': headerSafe(event.type),
      'X-Loan-Locale': headerSafe(event.locale || 'lo'),
    },
  });
}

/** One delivery attempt chain; throws the last error so the caller can dead-letter. */
export async function sendEvent(event: unknown): Promise<void> {
  if (!isNotificationEvent(event)) {
    throw new Error('Payload is not a complete NotificationEvent; nothing was sent');
  }

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= config.sendAttempts; attempt += 1) {
    try {
      await sendOnce(event);
      log.info(`sent ${event.type} -> ${event.to.email}`, { eventId: event.eventId, attempt });
      return;
    } catch (error) {
      lastError = error;
      log.warn(`attempt ${attempt}/${config.sendAttempts} failed for ${event.eventId}`, {
        reason: error instanceof Error ? error.message : String(error),
      });
      if (attempt < config.sendAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('SMTP delivery failed');
}

export async function verifyTransport(): Promise<boolean> {
  try {
    await transporter.verify();
    return true;
  } catch (error) {
    log.error('smtp verify failed', error);
    return false;
  }
}
