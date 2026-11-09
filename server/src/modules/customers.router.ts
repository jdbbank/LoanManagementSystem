import { Router } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';
import { getDataSource } from '../datasource';
import { Customer } from '../entities/customer.entity';
import { CustomerCredit } from '../entities/customer-credit.entity';
import { Loan } from '../entities/loan.entity';
import { LoanProduct } from '../entities/loan-product.entity';
import { KycDocument } from '../entities/kyc-document.entity';
import { LoanStatus, UserRole } from '../entities/types';
import { writeAudit } from '../services/audit.service';
import { notifyCustomerRegistered } from '../services/notification-events.service';
import { authMiddleware, requireAuth, requireRole } from '../middleware/auth';
import { validateBody } from '../middleware/error';
import { asyncHandler } from '../utils/async-handler';
import { notFound } from '../utils/errors';
import { num, round2 } from '../utils/money';
import { pad } from '../utils/pad';

const router = Router();
router.use(authMiddleware);

/** One row per product this customer has borrowed under: what is open now and what the history shows. */
interface BorrowingRow {
  productId: string;
  productCode: string;
  productName: string;
  loanCount: number;
  activeCount: number;
  outstanding: number;
  lastDisbursedAt: Date | null;
}

/** Products sort first while the customer still owes on them, then by the most recent disbursement. */
function collectBorrowings(loans: Loan[], productById: Map<string, LoanProduct>): BorrowingRow[] {
  const byProduct = new Map<string, BorrowingRow>();
  for (const loan of loans) {
    const existing = byProduct.get(loan.productId);
    const row: BorrowingRow = existing ?? {
      productId: loan.productId,
      productCode: productById.get(loan.productId)?.code ?? '',
      productName: productById.get(loan.productId)?.name ?? '',
      loanCount: 0,
      activeCount: 0,
      outstanding: 0,
      lastDisbursedAt: null,
    };
    row.loanCount += 1;
    if (loan.status === LoanStatus.ACTIVE) {
      row.activeCount += 1;
      row.outstanding = round2(row.outstanding + num(loan.currentOutstanding));
    }
    const disbursed = loan.disbursedAt ?? loan.createdAt;
    if (!row.lastDisbursedAt || disbursed > row.lastDisbursedAt) row.lastDisbursedAt = disbursed;
    byProduct.set(loan.productId, row);
  }
  return [...byProduct.values()].sort(
    (a, b) =>
      Number(b.activeCount > 0) - Number(a.activeCount > 0) ||
      (b.lastDisbursedAt?.getTime() ?? 0) - (a.lastDisbursedAt?.getTime() ?? 0) ||
      a.productName.localeCompare(b.productName),
  );
}

router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const search = (req.query.search as string | undefined)?.trim();
    const paginated = req.query.page !== undefined || req.query.limit !== undefined;
    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const qb = getDataSource().getRepository(Customer).createQueryBuilder('c');
    if (search) {
      qb.andWhere('(c.fullName LIKE :s OR c.customerNumber LIKE :s OR c.phone LIKE :s)', { s: `%${search}%` });
    }
    const customerQuery = qb.orderBy('c.createdAt', 'DESC');
    const [customers, total] = paginated
      ? await customerQuery.skip((page - 1) * limit).take(limit).getManyAndCount()
      : [await customerQuery.getMany(), 0];
    const customerIds = customers.map((customer) => customer.id);
    const [loans, credits, kycRows] = customerIds.length
      ? await Promise.all([
          getDataSource().getRepository(Loan).find({ where: { customerId: In(customerIds) } }),
          getDataSource().getRepository(CustomerCredit).find({ where: { customerId: In(customerIds) } }),
          getDataSource()
            .createQueryBuilder(KycDocument, 'kyc')
            .select('kyc.customerId', 'customerId')
            .addSelect('COUNT(kyc.id)', 'documentCount')
            .where('kyc.customerId IN (:...customerIds)', { customerIds })
            .groupBy('kyc.customerId')
            .getRawMany<{ customerId: string; documentCount: string }>(),
        ])
      : [[], [], []];
    const productIds = [...new Set(loans.map((loan) => loan.productId))];
    const products = productIds.length
      ? await getDataSource().getRepository(LoanProduct).find({ where: { id: In(productIds) } })
      : [];
    const productById = new Map(products.map((product) => [product.id, product]));
    const loansByCustomer = new Map<string, Loan[]>();
    const activeLoansByCustomer = new Map<string, number>();
    for (const loan of loans) {
      const bucket = loansByCustomer.get(loan.customerId) ?? [];
      bucket.push(loan);
      loansByCustomer.set(loan.customerId, bucket);
      if (loan.status === LoanStatus.ACTIVE) {
        activeLoansByCustomer.set(loan.customerId, (activeLoansByCustomer.get(loan.customerId) ?? 0) + 1);
      }
    }
    const creditByCustomer = new Map(credits.map((c) => [c.customerId, c]));
    const kycByCustomer = new Map(kycRows.map((r) => [r.customerId, Number(r.documentCount)]));

    res.json({
      customers: customers.map((c) => {
        const customerLoans = loansByCustomer.get(c.id) ?? [];
        return {
          ...c,
          loanCount: customerLoans.length,
          activeLoanCount: activeLoansByCustomer.get(c.id) ?? 0,
          borrowings: collectBorrowings(customerLoans, productById),
          creditBalance: creditByCustomer.get(c.id)?.balance ?? 0,
          kycDocumentCount: kycByCustomer.get(c.id) ?? 0,
        };
      }),
      ...(paginated ? { pagination: { page, limit, total } } : {}),
    });
  }),
);

const createCustomerSchema = z.object({
  fullName: z.string().min(1).max(191),
  phone: z.string().max(32).optional(),
  email: z.string().email().optional().or(z.literal('')),
  nationalId: z.string().max(64).optional(),
  address: z.string().max(255).optional(),
});

router.post(
  '/',
  requireRole(UserRole.MAKER, UserRole.CHECKER, UserRole.HEAD_APPROVER, UserRole.ADMIN),
  validateBody(createCustomerSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createCustomerSchema>;
    const ds = getDataSource();
    const count = await ds.getRepository(Customer).count();
    const customer = ds.getRepository(Customer).create({
      customerNumber: `CUST-${pad(count + 1, 6)}`,
      fullName: body.fullName,
      phone: body.phone ?? null,
      email: body.email || null,
      nationalId: body.nationalId ?? null,
      address: body.address ?? null,
    });
    await ds.getRepository(Customer).save(customer);
    await writeAudit(ds.manager, {
      action: 'CUSTOMER_CREATED',
      userId: req.user!.id,
      customerId: customer.id,
      reason: customer.fullName,
      newStatus: customer.customerNumber,
      ip: req.ip ?? null,
    });
    await notifyCustomerRegistered(ds.manager, {
      customerId: customer.id,
      createdByName: req.user!.fullName,
      actorUserId: req.user!.id,
    });
    res.status(201).json({ customer });
  }),
);

router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const ds = getDataSource();
    const customer = await ds.getRepository(Customer).findOne({ where: { id: req.params.id } });
    if (!customer) throw notFound('Customer not found');
    const loans = await ds.getRepository(Loan).find({
      where: { customerId: customer.id },
      order: { createdAt: 'DESC' },
    });
    const credit = await ds.getRepository(CustomerCredit).findOne({ where: { customerId: customer.id } });
    res.json({ customer, loans, credit: credit?.balance ?? 0 });
  }),
);

export default router;
