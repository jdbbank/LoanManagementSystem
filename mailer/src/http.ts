import { timingSafeEqual } from 'crypto';
import express from 'express';
import { config } from './config';
import { log } from './log';
import { sendEvent } from './sender';

/** The backend is the only caller; it authenticates with the shared mailer key. */
function authorized(provided: string | undefined): boolean {
  const expected = Buffer.from(config.apiKey);
  const actual = Buffer.from(provided ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createMailerApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      smtpConfigured: Boolean(config.smtp.host),
      kafkaConsumerEnabled: config.kafka.enabled,
    });
  });

  app.post('/api/send', (req, res) => {
    if (!authorized(req.header('x-api-key'))) {
      res.status(401).json({ error: { message: 'Invalid mailer key' } });
      return;
    }

    void sendEvent(req.body)
      .then(() => {
        res.status(202).json({ accepted: true });
      })
      .catch((error) => {
        log.error('send rejected', error);
        res.status(502).json({
          error: { message: error instanceof Error ? error.message : 'Delivery failed' },
        });
      });
  });

  return app;
}
