import { Kafka, logLevel, Producer } from 'kafkajs';
import { env } from '../config/env';
import { getDataSource } from '../datasource';
import { NotificationEvent } from '../entities/types';
import { logger } from '../utils/logger';
import { claimableRows, markFailed, markSent, SECRET_EVENT_TYPES, toNotificationEvent } from './notification.service';

/**
 * Drains the notification outbox. The backend never sends SMTP itself: it hands the
 * finished message to Kafka (or straight to the mailer service over HTTP), and the
 * mailer service is the only component that talks to a mail provider.
 */

let kafkaClient: Kafka | null = null;
let kafkaProducer: Producer | null = null;

async function getKafkaProducer(): Promise<Producer> {
  if (!kafkaProducer) {
    kafkaClient ??= new Kafka({
      clientId: env.kafka.clientId,
      brokers: env.kafka.brokers,
      logLevel: logLevel.ERROR,
      retry: { retries: 3 },
    });
    kafkaProducer = kafkaClient.producer();
    await kafkaProducer.connect();
  }
  return kafkaProducer;
}

async function sendViaKafka(event: NotificationEvent): Promise<void> {
  const producer = await getKafkaProducer();
  await producer.send({
    topic: env.kafka.topic,
    messages: [
      {
        key: event.eventId,
        value: JSON.stringify(event),
        headers: { eventType: event.type, locale: event.locale },
      },
    ],
  });
}

async function sendViaHttp(event: NotificationEvent): Promise<void> {
  const response = await fetch(`${env.mailer.baseUrl}/api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.mailer.apiKey },
    body: JSON.stringify(event),
  });
  if (!response.ok) {
    throw new Error(`mailer responded ${response.status}: ${await response.text()}`);
  }
}

/** Dev transport: the pipeline runs end to end but nothing leaves the machine. */
async function sendViaLog(event: NotificationEvent): Promise<void> {
  // SECRET_EVENT_TYPES put the live secret in the subject, so the log only records its size.
  const content = SECRET_EVENT_TYPES.has(event.type)
    ? `<redacted ${event.subject.length} + ${event.text.length} chars>`
    : `${event.subject} | ${event.text.length} chars`;
  logger.info(`[notify:log] ${event.type} -> ${event.to.email} | ${content}`);
}

async function deliver(event: NotificationEvent): Promise<void> {
  if (env.notification.transport === 'kafka') return sendViaKafka(event);
  if (env.notification.transport === 'http') return sendViaHttp(event);
  return sendViaLog(event);
}

/** Publishes everything the outbox owes right now. Returns the number delivered. */
export async function dispatchNotifications(): Promise<number> {
  if (!env.notification.enabled) return 0;

  const em = getDataSource().manager;
  const rows = await claimableRows(em);
  let delivered = 0;

  for (const row of rows) {
    try {
      await deliver(toNotificationEvent(row));
      await markSent(em, row);
      delivered += 1;
    } catch (error) {
      await markFailed(em, row, error);
      logger.warn(
        `[notify] delivery failed (${row.type} -> ${row.recipientEmail}, attempt ${row.attempts}): ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return delivered;
}

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await dispatchNotifications();
  } catch (error) {
    // The outbox itself is the retry store, so a tick failure is only worth a log line.
    logger.error('[notify] dispatcher tick failed', error);
  } finally {
    inFlight = false;
  }
}

export function startNotificationDispatcher(): void {
  if (!env.notification.enabled || timer) return;
  timer = setInterval(() => void tick(), env.notification.pollIntervalMs);
  // Keep the poller from holding the process (or a test run) open.
  timer.unref();
  logger.info(
    `[notify] dispatcher started: transport=${env.notification.transport}, ` +
      `every ${env.notification.pollIntervalMs}ms`,
  );
}

export async function stopNotificationDispatcher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (kafkaProducer) {
    await kafkaProducer.disconnect().catch(() => undefined);
    kafkaProducer = null;
  }
}
