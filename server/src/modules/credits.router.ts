import { Router, Request, Response } from 'express';
import { In } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { CreditLedger } from '../entities/credit-ledger.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/async-handler';
import { num } from '../utils/money';
import { getDataSource } from '../datasource';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const em = getDataSource().manager;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const [credits, total] = await em.getRepository(CustomerCredit).findAndCount({
      order: { balance: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    if (credits.length === 0) {
      return res.json({ data: [], pagination: { page, limit, total } });
    }

    const customers = await em.find(Customer, {
      where: { id: In(credits.map((c) => c.customerId)) },
    });
    const customerMap = new Map(customers.map((c) => [c.id, c]));

    res.json({
      data: credits.map((credit) => ({
        ...credit,
        customer: customerMap.get(credit.customerId) ?? null,
      })),
      pagination: { page, limit, total },
    });
  })
);

router.get(
  '/ledger',
  asyncHandler(async (req: Request, res: Response) => {
    const customerId = typeof req.query.customerId === 'string' ? req.query.customerId : undefined;
    if (!customerId) {
      return res
        .status(400)
        .json({ error: { code: 'BAD_REQUEST', message: 'customerId query parameter is required' } });
    }
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const [ledger, total] = await getDataSource().manager.getRepository(CreditLedger).findAndCount({
      where: { customerId },
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    const credit = await getDataSource().manager.findOne(CustomerCredit, { where: { customerId } });
    res.json({
      data: { ledger, currentBalance: credit ? num(credit.balance) : 0 },
      pagination: { page, limit, total },
    });
  })
);

export default router;
