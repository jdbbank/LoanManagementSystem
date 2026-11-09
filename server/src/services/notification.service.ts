import { randomUUID } from 'crypto';
import { EntityManager, IsNull, LessThanOrEqual } from 'typeorm';
import { env } from '../config/env';
import { EmailTemplate } from '../entities/email-template.entity';
import { NotificationOutbox } from '../entities/notification-outbox.entity';
import {
  NotificationEventType,
  NotificationRecipient,
  NotificationEvent,
  NotificationStatus,
} from '../entities/types';
import { logger } from '../utils/logger';
import { seal, sealJson, unseal, unsealJson } from '../utils/seal';
import { findActiveTemplate, renderEmail } from './email-template.service';

export interface NotificationInput {
  type: NotificationEventType;
  /** Null when the person on file has no email address — the event is then skipped. */
  to: NotificationRecipient | null;
  locale?: string;
  payload: Record<string, string | number | null>;
  customerId?: string | null;
  loanId?: string | null;
  userId?: string | null;
}

/**
 * Events whose rendered message IS the secret: the OTP is the subject of the code email and the
 * reset URL is carried in the body. Their content is sealed at rest and opened only at send time.
 */
export const SECRET_EVENT_TYPES: ReadonlySet<NotificationEventType> = new Set([
  NotificationEventType.PASSWORD_RESET_OTP,
  NotificationEventType.PASSWORD_RESET_LINK,
]);

const carriesSecret = (type: NotificationEventType): boolean => SECRET_EVENT_TYPES.has(type);

/**
 * Renders the email with the backend's own template and parks it in the outbox.
 * Call this with the caller's transaction-scoped EntityManager so a notification is
 * committed exactly when the business change is committed — and never when it isn't.
 * A missing address or template is logged and skipped: notifications must not break a flow.
 */
export async function enqueueNotification(
  em: EntityManager,
  input: NotificationInput,
): Promise<NotificationOutbox | null> {
  if (!env.notification.enabled) return null;

  const email = input.to?.email?.trim();
  if (!email) {
    logger.warn(`[notify] skipped ${input.type}: recipient has no email address`);
    return null;
  }

  const locale = input.locale ?? env.notification.defaultLocale;
  const template: EmailTemplate | null = await findActiveTemplate(em, input.type, locale);
  if (!template) {
    logger.warn(`[notify] skipped ${input.type}: no active email template`);
    return null;
  }

  const rendered = renderEmail(template, {
    ...input.payload,
    recipientName: input.to?.fullName ?? '',
  });
  const subject = rendered.subject.slice(0, 255);
  const secret = carriesSecret(input.type);

  const row = em.create(NotificationOutbox, {
    id: randomUUID(),
    type: input.type,
    recipientEmail: email.slice(0, 191),
    recipientName: (input.to?.fullName ?? '').slice(0, 191),
    locale: template.locale,
    // A reset email puts the OTP in the subject line, so the subject is sealed for those types too.
    subject: secret ? seal(subject) : subject,
    // The rendered message can hold an OTP or a reset link, so it never reaches the table in plain text.
    bodyHtml: seal(rendered.html),
    bodyText: seal(rendered.text),
    payload: sealJson(input.payload),
    status: NotificationStatus.PENDING,
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    sentAt: null,
    customerId: input.customerId ?? null,
    loanId: input.loanId ?? null,
    userId: input.userId ?? null,
  });
  return em.save(NotificationOutbox, row);
}

/** The fixed wire contract the mailer service consumes. The outbox keeps this sealed; it opens here. */
export function toNotificationEvent(row: NotificationOutbox): NotificationEvent {
  return {
    eventId: row.id,
    type: row.type,
    templateCode: row.type,
    occurredAt: row.createdAt.toISOString(),
    locale: row.locale,
    to: { email: row.recipientEmail, fullName: row.recipientName },
    subject: carriesSecret(row.type) ? unseal(row.subject) : row.subject,
    html: unseal(row.bodyHtml),
    text: unseal(row.bodyText),
    payload: unsealJson<NotificationEvent['payload']>(row.payload),
  };
}

/** Rows due now: never tried, or failed and whose backoff has elapsed. */
export function claimableRows(em: EntityManager): Promise<NotificationOutbox[]> {
  const now = new Date();
  return em.find(NotificationOutbox, {
    where: [
      { status: NotificationStatus.PENDING },
      { status: NotificationStatus.FAILED, nextRetryAt: LessThanOrEqual(now) },
      { status: NotificationStatus.FAILED, nextRetryAt: IsNull() },
    ],
    order: { createdAt: 'ASC' },
    take: env.notification.batchSize,
  });
}

export function markSent(em: EntityManager, row: NotificationOutbox): Promise<NotificationOutbox> {
  row.status = NotificationStatus.SENT;
  row.sentAt = new Date();
  row.lastError = null;
  return em.save(NotificationOutbox, row);
}

/** Retries with backoff until maxAttempts, then parks the row as DEAD for an operator. */
export function markFailed(
  em: EntityManager,
  row: NotificationOutbox,
  error: unknown,
): Promise<NotificationOutbox> {
  row.attempts += 1;
  row.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  if (row.attempts >= env.notification.maxAttempts) {
    row.status = NotificationStatus.DEAD;
  } else {
    row.status = NotificationStatus.FAILED;
    row.nextRetryAt = new Date(
      Date.now() + env.notification.backoffSeconds * 1000 * row.attempts,
    );
  }
  return em.save(NotificationOutbox, row);
}

/** Lets an operator re-queue a dead or failed row from the admin UI. */
export async function requeueNotification(em: EntityManager, id: string): Promise<NotificationOutbox | null> {
  const row = await em.findOne(NotificationOutbox, { where: { id } });
  if (!row || row.status === NotificationStatus.SENT) return null;
  row.status = NotificationStatus.PENDING;
  row.attempts = 0;
  row.nextRetryAt = null;
  row.lastError = null;
  return em.save(NotificationOutbox, row);
}
