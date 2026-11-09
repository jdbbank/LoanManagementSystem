import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import authRouter from './modules/auth.router';
import usersRouter from './modules/users.router';
import configRouter from './modules/config.router';
import auditRouter from './modules/audit.router';
import customersRouter from './modules/customers.router';
import kycRouter from './modules/kyc.router';
import bankAccountsRouter from './modules/customer-bank-accounts.router';
import evidenceRouter from './modules/evidence.router';
import loanProductsRouter from './modules/loan-products.router';
import loansRouter from './modules/loans.router';
import loanPartiesRouter from './modules/loan-parties.router';
import loanCollateralsRouter from './modules/loan-collaterals.router';
import paymentRequestsRouter from './modules/payment-requests.router';
import transactionsRouter from './modules/transactions.router';
import approvalsRouter from './modules/approvals.router';
import settlementsRouter from './modules/settlements.router';
import restructuresRouter from './modules/restructures.router';
import creditsRouter from './modules/credits.router';
import reconciliationRouter from './modules/reconciliation.router';
import reportsRouter from './modules/reports.router';
import dashboardRouter from './modules/dashboard.router';
import notificationsRouter from './modules/notifications.router';

export function createApp() {
  const app = express();

  /**
   * The gateway is the only address this service ever hears from, so `req.ip` is the client behind
   * `X-Forwarded-For` rather than the container next to it. Without this every staff member shares
   * one address: the password-reset throttle would lock the whole branch out after five codes, and a
   * single attacker's bursts would be blamed on everybody else at the gateway.
   */
  app.set('trust proxy', 1);

  app.use(helmet());
  // No origin is allowed cross-origin unless it is named in CORS_ALLOWED_ORIGINS. The web app reaches
  // the API same-origin through the dev proxy or the web image, so an empty list costs nothing real,
  // while `cors()` with no options told every website on the internet that it may read this API.
  app.use(cors({ origin: env.cors.allowList }));
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);
  app.use('/api', authMiddleware);
  app.use('/api/users', usersRouter);
  app.use('/api/config', configRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/customers/:customerId/kyc', kycRouter);
  app.use('/api/customers/:customerId/bank-accounts', bankAccountsRouter);
  app.use('/api/customers/:customerId/evidence', evidenceRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/loan-products', loanProductsRouter);
  app.use('/api/loans/:loanId/parties', loanPartiesRouter);
  app.use('/api/loans/:loanId/collaterals', loanCollateralsRouter);
  app.use('/api/loans/:loanId/evidence', evidenceRouter);
  app.use('/api/loans', loansRouter);
  app.use('/api/payment-requests', paymentRequestsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/settlements', settlementsRouter);
  app.use('/api/restructures', restructuresRouter);
  app.use('/api/credits', creditsRouter);
  app.use('/api/reconciliation', reconciliationRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
