import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { authMiddleware } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import authRouter from './modules/auth.router';
import usersRouter from './modules/users.router';
import configRouter from './modules/config.router';
import auditRouter from './modules/audit.router';
import customersRouter from './modules/customers.router';
import kycRouter from './modules/kyc.router';
import loanProductsRouter from './modules/loan-products.router';
import loansRouter from './modules/loans.router';
import paymentRequestsRouter from './modules/payment-requests.router';
import transactionsRouter from './modules/transactions.router';
import approvalsRouter from './modules/approvals.router';
import settlementsRouter from './modules/settlements.router';
import creditsRouter from './modules/credits.router';
import reconciliationRouter from './modules/reconciliation.router';
import reportsRouter from './modules/reports.router';
import dashboardRouter from './modules/dashboard.router';
import notificationsRouter from './modules/notifications.router';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);
  app.use('/api', authMiddleware);
  app.use('/api/users', usersRouter);
  app.use('/api/config', configRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/customers/:customerId/kyc', kycRouter);
  app.use('/api/customers', customersRouter);
  app.use('/api/loan-products', loanProductsRouter);
  app.use('/api/loans', loansRouter);
  app.use('/api/payment-requests', paymentRequestsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/approvals', approvalsRouter);
  app.use('/api/settlements', settlementsRouter);
  app.use('/api/credits', creditsRouter);
  app.use('/api/reconciliation', reconciliationRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
