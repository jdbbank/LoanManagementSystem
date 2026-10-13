import 'reflect-metadata';
import { env } from './config/env';
import { getDataSource, initDataSource } from './datasource';
import { createApp } from './app';
import { runSeed } from './seed';
import { seedEmailTemplates } from './services/email-template.service';
import {
  startNotificationDispatcher,
  stopNotificationDispatcher,
} from './services/notification-dispatcher.service';
import { logger } from './utils/logger';

async function main(): Promise<void> {
  const dataSource = await initDataSource();
  logger.info(`[db] connected to ${env.db.host}:${env.db.port}/${env.db.name}`);

  if (env.seedOnBoot) {
    await dataSource.transaction((em) => runSeed(em));
  }

  // Templates are configuration, not demo data: fill in any code that is missing on every boot.
  const seededTemplates = await dataSource.transaction((em) => seedEmailTemplates(em));
  if (seededTemplates > 0) {
    logger.info(`[mail] seeded ${seededTemplates} email template(s)`);
  }

  const app = createApp();
  app.listen(env.port, () => {
    logger.info(`[server] listening on http://localhost:${env.port}`);
    startNotificationDispatcher();
  });
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void stopNotificationDispatcher().finally(() => process.exit(0));
  });
}

main().catch((error) => {
  logger.error('[server] fatal startup error', error);
  process.exit(1);
});

export { getDataSource };
