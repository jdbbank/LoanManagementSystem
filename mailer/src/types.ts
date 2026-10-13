/**
 * Wire contract, mirrored from server/src/entities/types.ts.
 * The backend renders the message; this service only ever reads these fields.
 */
export interface NotificationEvent {
  eventId: string;
  type: string;
  templateCode: string;
  occurredAt: string;
  locale: string;
  to: { email: string; fullName: string };
  subject: string;
  html: string;
  text: string;
  payload: Record<string, string | number | null>;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Rejects anything that is not a complete, sendable event before it reaches SMTP. */
export function isNotificationEvent(value: unknown): value is NotificationEvent {
  const event = value as Partial<NotificationEvent> | null;
  return Boolean(
    event &&
      typeof event.eventId === 'string' &&
      typeof event.subject === 'string' &&
      typeof event.html === 'string' &&
      typeof event.text === 'string' &&
      event.to &&
      typeof event.to.email === 'string' &&
      EMAIL_SHAPE.test(event.to.email),
  );
}
