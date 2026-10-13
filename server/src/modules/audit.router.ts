import { Router } from 'express';
import { getDataSource } from '../datasource';
import { AuditLog } from '../entities/audit-log.entity';
import { User } from '../entities/user.entity';
import { authMiddleware, requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';

const router = Router();
router.use(authMiddleware, requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { loanId, transactionId, customerId, action, limit, offset } = req.query as Record<string, string | undefined>;
    const qb = getDataSource()
      .getRepository(AuditLog)
      .createQueryBuilder('a')
      .orderBy('a.createdAt', 'DESC')
      .take(Math.min(parseInt(limit ?? '100', 10) || 100, 500))
      .skip(parseInt(offset ?? '0', 10) || 0);

    if (loanId) qb.andWhere('a.loanId = :loanId', { loanId });
    if (transactionId) qb.andWhere('a.transactionId = :transactionId', { transactionId });
    if (customerId) qb.andWhere('a.customerId = :customerId', { customerId });
    if (action) qb.andWhere('a.action LIKE :action', { action: `%${action}%` });

    const [logs, total] = await qb.getManyAndCount();
    const users = await getDataSource().getRepository(User).find();
    const userMap = new Map(users.map((u) => [u.id, { username: u.username, fullName: u.fullName }]));

    res.json({
      total,
      logs: logs.map((l) => ({
        ...l,
        actor: l.userId ? userMap.get(l.userId) ?? null : null,
      })),
    });
  }),
);

export default router;
