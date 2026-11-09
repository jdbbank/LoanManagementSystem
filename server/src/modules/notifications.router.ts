import { Router } from 'express';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { EmailTemplate } from '../entities/email-template.entity';
import { NotificationOutbox } from '../entities/notification-outbox.entity';
import { NotificationStatus, UserRole } from '../entities/types';
import { writeAudit } from '../services/audit.service';
import {
  assertTemplateMarkupSafe,
  declaredVariablesOf,
  DEFAULT_TEMPLATES,
} from '../services/email-template.service';
import { requeueNotification, SECRET_EVENT_TYPES } from '../services/notification.service';
import { authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';

const router = Router();
router.use(authMiddleware);

const templateSchema = z.object({
  subject: z.string().min(1).max(255).optional(),
  bodyHtml: z.string().min(1).optional(),
  bodyText: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
});

/** Templates are the backend's property: only ADMIN reads and edits them. */
router.get(
  '/templates',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (_req, res) => {
    const templates = await getDataSource()
      .getRepository(EmailTemplate)
      .find({ order: { code: 'ASC', locale: 'ASC' } });
    res.json({
      data: {
        templates,
        defaults: DEFAULT_TEMPLATES.map(({ code, variables }) => ({ code, variables })),
      },
    });
  }),
);

router.patch(
  '/templates/:id',
  requireRole(UserRole.ADMIN),
  validateBody(templateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof templateSchema>;
    if (body.bodyHtml !== undefined) assertTemplateMarkupSafe(body.bodyHtml);

    const ds = getDataSource();
    const template = await ds.getRepository(EmailTemplate).findOne({ where: { id: req.params.id } });
    if (!template) throw notFound('Email template not found');

    const previous = { subject: template.subject, isActive: template.isActive };
    if (body.subject !== undefined) template.subject = body.subject;
    if (body.bodyHtml !== undefined) template.bodyHtml = body.bodyHtml;
    if (body.bodyText !== undefined) template.bodyText = body.bodyText;
    if (body.isActive !== undefined) template.isActive = body.isActive;
    template.variables = declaredVariablesOf(template);
    template.updatedBy = req.user!.id;

    const saved = await ds.transaction(async (em) => {
      const row = await em.save(EmailTemplate, template);
      await writeAudit(em, {
        action: 'EMAIL_TEMPLATE_UPDATED',
        userId: req.user!.id,
        previousStatus: previous.isActive ? 'ACTIVE' : 'INACTIVE',
        newStatus: row.isActive ? 'ACTIVE' : 'INACTIVE',
        reason: `Template ${row.code}/${row.locale}: "${previous.subject}" -> "${row.subject}"`,
        ip: req.ip ?? null,
      });
      return row;
    });

    res.json({ data: { template: saved } });
  }),
);

const listOutboxSchema = z.object({
  status: z.nativeEnum(NotificationStatus).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Delivery log: who was notified, how many attempts, and why a row went DEAD. */
router.get(
  '/',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (req, res) => {
    const query = listOutboxSchema.parse(req.query) as z.infer<typeof listOutboxSchema>;
    const qb = getDataSource()
      .getRepository(NotificationOutbox)
      .createQueryBuilder('n')
      .orderBy('n.createdAt', 'DESC')
      .take(query.limit ?? 50)
      .skip(query.offset ?? 0);
    if (query.status) qb.where('n.status = :status', { status: query.status });

    const [rows, total] = await qb.getManyAndCount();
    // The stored bodies can be large HTML; the list only needs the delivery facts.
    res.json({
      total,
      data: {
        notifications: rows.map((row) => ({
          id: row.id,
          type: row.type,
          recipientEmail: row.recipientEmail,
          recipientName: row.recipientName,
          // The delivery log is not a credential store: a reset email's subject is the OTP itself.
          subject: SECRET_EVENT_TYPES.has(row.type) ? '<sealed>' : row.subject,
          locale: row.locale,
          status: row.status,
          attempts: row.attempts,
          lastError: row.lastError,
          sentAt: row.sentAt,
          createdAt: row.createdAt,
          loanId: row.loanId,
          customerId: row.customerId,
          userId: row.userId,
        })),
      },
    });
  }),
);

router.post(
  '/:id/requeue',
  requireRole(UserRole.ADMIN),
  asyncHandler(async (req, res) => {
    const ds = getDataSource();
    const row = await ds.transaction(async (em) => {
      const requeued = await requeueNotification(em, req.params.id);
      if (!requeued) throw notFound('Notification not found or already sent');
      await writeAudit(em, {
        action: 'NOTIFICATION_REQUEUED',
        userId: req.user!.id,
        newStatus: NotificationStatus.PENDING,
        reason: `Re-queued ${requeued.type} to ${requeued.recipientEmail}`,
        ip: req.ip ?? null,
      });
      return requeued;
    });
    res.json({ data: { id: row.id, status: row.status } });
  }),
);

/** Health probe for the pipeline, readable by any signed-in operator. */
router.get(
  '/summary',
  requireAuth,
  asyncHandler(async (_req, res) => {
    const repo = getDataSource().getRepository(NotificationOutbox);
    const [pending, sent, failed, dead] = await Promise.all([
      repo.count({ where: { status: NotificationStatus.PENDING } }),
      repo.count({ where: { status: NotificationStatus.SENT } }),
      repo.count({ where: { status: NotificationStatus.FAILED } }),
      repo.count({ where: { status: NotificationStatus.DEAD } }),
    ]);
    res.json({ data: { counts: { pending, sent, failed, dead } } });
  }),
);

export default router;
