import { Consumer, Kafka, logLevel, Producer } from 'kafkajs';
import { config } from './config';
import { log } from './log';
import { sendEvent } from './sender';

export interface KafkaRuntime {
  stop(): Promise<void>;
}

/** Messages that cannot be delivered are parked on the dead-letter topic, never dropped. */
async function deadLetter(producer: Producer, raw: string, reason: string): Promise<void> {
  await producer
    .send({
      topic: config.kafka.dlqTopic,
      messages: [{ value: raw, headers: { reason: reason.slice(0, 200) } }],
    })
    .catch((error) => log.error('dead-letter write failed', error));
  log.warn(`dead-lettered to ${config.kafka.dlqTopic}`, { reason: reason.slice(0, 200) });
}

export async function startKafkaConsumer(): Promise<KafkaRuntime> {
  const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers: config.kafka.brokers,
    logLevel: logLevel.ERROR,
    retry: { retries: 5 },
  });

  const consumer: Consumer = kafka.consumer({ groupId: config.kafka.group });
  const producer = kafka.producer();

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafka.topic, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString();
      if (!raw) return;

      let event: unknown;
      try {
        event = JSON.parse(raw);
      } catch (error) {
        await deadLetter(producer, raw, 'message body is not JSON');
        return;
      }

      try {
        await sendEvent(event);
      } catch (error) {
        await deadLetter(producer, raw, error instanceof Error ? error.message : String(error));
      }
    },
  });

  log.info(`consuming ${config.kafka.topic} as group ${config.kafka.group}`, {
    brokers: config.kafka.brokers.join(','),
  });

  return {
    stop: async () => {
      await consumer.stop().catch(() => undefined);
      await producer.disconnect().catch(() => undefined);
    },
  };
}
