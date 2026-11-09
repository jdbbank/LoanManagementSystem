import bcrypt from 'bcryptjs';
import { EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
import { SystemConfig } from './entities/system-config.entity';
import { Customer } from './entities/customer.entity';
import { LoanProduct } from './entities/loan-product.entity';
import { DEFAULT_PENALTY_POLICY, KycStatus, PenaltyMode, PeriodUnit, UserRole } from './entities/types';
import { termMonthsOf } from './utils/period';
import { pad } from './utils/pad';
import {
  CONFIG_CHECKER_THRESHOLD,
  CONFIG_HEAD_THRESHOLD,
  DEFAULT_CHECKER_THRESHOLD,
  DEFAULT_HEAD_THRESHOLD,
} from './services/approval.service';
import { getKycPolicy } from './services/kyc-policy.service';
import { resolveTenant } from './services/tenant.service';
import { createLoanWithDisbursement } from './modules/loans.router';
import { logger } from './utils/logger';

const SEED_USERS: Array<{
  username: string;
  fullName: string;
  role: UserRole;
  password: string;
  email: string;
}> = [
  { username: 'admin', fullName: 'System Administrator', role: UserRole.ADMIN, password: 'Admin@123', email: 'admin@loanms.local' },
  { username: 'head', fullName: 'Head Approver', role: UserRole.HEAD_APPROVER, password: 'Head@123', email: 'head@loanms.local' },
  { username: 'checker', fullName: 'Checker One', role: UserRole.CHECKER, password: 'Checker@123', email: 'checker@loanms.local' },
  { username: 'maker', fullName: 'Maker One', role: UserRole.MAKER, password: 'Maker@123', email: 'maker@loanms.local' },
  { username: 'viewer', fullName: 'Read Only Viewer', role: UserRole.VIEWER, password: 'Viewer@123', email: 'viewer@loanms.local' },
];

const SEED_PRODUCTS = [
  {
    code: 'PERSONAL-12',
    name: 'Personal Loan 1%/mo',
    interestRate: 1,
    interestRatePeriod: PeriodUnit.MONTH,
    termValue: 12,
    termUnit: PeriodUnit.MONTH,
    penaltyPolicy: DEFAULT_PENALTY_POLICY,
    description: 'Flat-rate personal loan, 1% per month, no penalty',
  },
  {
    code: 'BUSINESS-18',
    name: 'Business Loan 18%',
    interestRate: 18,
    interestRatePeriod: PeriodUnit.YEAR,
    termValue: 24,
    termUnit: PeriodUnit.MONTH,
    penaltyPolicy: {
      mode: PenaltyMode.PERCENT_OF_OVERDUE,
      ratePercent: 1.5,
      amount: 0,
      period: PeriodUnit.MONTH,
      graceDays: 5,
      maxPercentOfPrincipal: 20,
    },
    description: 'Flat-rate business loan, 18% per year, 1.5% per month penalty after 5 grace days',
  },
];

const SEED_CUSTOMERS = [
  { fullName: 'Somchai Vongsa', phone: '+856 20 5555 0001', nationalId: 'LA-1001', address: 'Vientiane', email: 'somchai@loanms.local' },
  { fullName: 'Noy Sengdao', phone: '+856 20 5555 0002', nationalId: 'LA-1002', address: 'Luang Prabang', email: 'noy@loanms.local' },
  { fullName: 'Khamla Phomvihane', phone: '+856 20 5555 0003', nationalId: 'LA-1003', address: 'Savannakhet', email: 'khamla@loanms.local' },
];

export async function runSeed(em: EntityManager): Promise<void> {
  const existingUsers = await em.count(User);
  if (existingUsers > 0) return;

  logger.info('[seed] seeding users, products, customers, loans...');

  // Every seeded account belongs to the organisation this deployment answers for; the row is created
  // by the migration that adds the column, not here, so a scratch database without it fails loudly.
  const tenant = await resolveTenant(em);

  const users = new Map<string, User>();
  for (const seedUser of SEED_USERS) {
    const user = em.create(User, {
      tenantId: tenant.id,
      username: seedUser.username,
      passwordHash: await bcrypt.hash(seedUser.password, 10),
      fullName: seedUser.fullName,
      email: seedUser.email,
      isEmailVerified: true,
      role: seedUser.role,
      isActive: true,
      passwordChangedAt: new Date(),
    });
    await em.save(User, user);
    users.set(seedUser.username, user);
  }
  const admin = users.get('admin')!;
  const maker = users.get('maker')!;
  const checker = users.get('checker')!;

  await em.insert(SystemConfig, [
    { key: CONFIG_CHECKER_THRESHOLD, value: DEFAULT_CHECKER_THRESHOLD, description: 'Maker->Checker up to this amount (LAK)' },
    { key: CONFIG_HEAD_THRESHOLD, value: DEFAULT_HEAD_THRESHOLD, description: 'Checker->Head up to this amount (LAK); above requires Admin final approval' },
  ]);

  const products: LoanProduct[] = [];
  for (const p of SEED_PRODUCTS) {
    const product = em.create(LoanProduct, {
      code: p.code,
      name: p.name,
      interestRate: p.interestRate,
      interestRatePeriod: p.interestRatePeriod,
      termValue: p.termValue,
      termUnit: p.termUnit,
      termMonths: termMonthsOf(p.termValue, p.termUnit),
      penaltyPolicy: p.penaltyPolicy,
      currency: 'LAK',
      description: p.description,
      isActive: true,
    });
    await em.save(LoanProduct, product);
    products.push(product);
  }

  const customers: Customer[] = [];
  // Demo customers start already KYC-VERIFIED so the seeded loans can be disbursed
  // under the default disbursement gate. Real customers must go through the KYC flow.
  const kycPolicy = await getKycPolicy(em);
  let customerCount = 0;
  for (const c of SEED_CUSTOMERS) {
    customerCount += 1;
    const customer = em.create(Customer, {
      customerNumber: `CUST-${pad(customerCount, 6)}`,
      fullName: c.fullName,
      phone: c.phone,
      email: c.email,
      nationalId: c.nationalId,
      address: c.address,
      kycStatus: KycStatus.VERIFIED,
      kycSubmittedBy: maker.id,
      kycSubmittedAt: new Date(),
      kycReviewedBy: checker.id,
      kycReviewedAt: new Date(),
      kycAppliedPolicy: kycPolicy,
    });
    await em.save(Customer, customer);
    customers.push(customer);
  }

  await createLoanWithDisbursement(em, {
    customerId: customers[0].id,
    productId: products[0].id,
    principalAmount: 5_000_000,
    userId: admin.id,
  });
  await createLoanWithDisbursement(em, {
    customerId: customers[1].id,
    productId: products[0].id,
    principalAmount: 2_000_000,
    userId: maker.id,
  });
  await createLoanWithDisbursement(em, {
    customerId: customers[2].id,
    productId: products[1].id,
    principalAmount: 500_000,
    userId: admin.id,
  });

  logger.info('[seed] done');
}
