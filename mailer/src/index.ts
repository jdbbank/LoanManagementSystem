import { createMailerApp } from './http';
import { config } from './config';
import { log } from './log';
import { startKafkaConsumer, KafkaRuntime } from './kafka';
import { verifyTransport } from './sender';

async function main(): Promise<void> {
  const smtpOk = await verifyTransport();
  log.info(`smtp ${smtpOk ? 'ready' : 'unavailable'} (from ${config.smtp.from})`, {
    mode: config.smtp.host ? 'smtp' : 'json-transport',
  });

  let kafka: KafkaRuntime | null = null;
  if (config.kafka.enabled) {
    kafka = await startKafkaConsumer();
  } else {
    log.info('kafka consumer disabled — HTTP /api/send only');
  }

  const server = createMailerApp().listen(config.port, () => {
    log.info(`mailer listening on http://localhost:${config.port}`);
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      log.info(`received ${signal}`);
      server.close(() => undefined);
      void (kafka?.stop() ?? Promise.resolve()).finally(() => process.exit(0));
    });
  }
}

void main().catch((error) => {
  log.error('mailer failed to start', error);
  process.exit(1);
});
