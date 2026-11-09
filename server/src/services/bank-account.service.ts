import { EntityManager } from 'typeorm';
import { Customer } from '../entities/customer.entity';
import { CustomerBankAccount } from '../entities/customer-bank-account.entity';
import { BankAccountStatus } from '../entities/types';
import { conflict, notFound, unprocessable } from '../utils/errors';
import { writeAudit } from './audit.service';

/**
 * The account a customer receives or pays money through. Registering one is a bookkeeping act, not a
 * money movement: nothing here touches a balance, so it needs no approval workflow. What it does need is
 * a number that can be trusted later, which is why the proof image is required as evidence and the
 * displayed value is always masked — an account number in a screenshot is a number in a leaked log.
 */

/** Whitespace-insensitive so `1 2 3 4` and `1234` cannot be filed as two accounts. */
export function normalizeAccountNumber(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Everything except the last four characters is hidden. Four digits are enough for staff to recognise
 * their own customer's account and not enough to send money with.
 */
export function maskAccountNumber(raw: string): string {
  const compact = raw.replace(/\s+/g, '');
  if (compact.length <= 4) return compact;
  return `${'*'.repeat(Math.min(compact.length - 4, 12))}${compact.slice(-4)}`;
}

export interface RegisterBankAccountInput {
  customerId: string;
  bankName: string;
  accountNumber: string;
  accountHolderName: string;
  branch?: string | null;
  isPrimary?: boolean;
  note?: string | null;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Files one account. A closed row carrying the same number is revived rather than duplicated, because the
 * unique index is on (customerId, accountNumber) and a customer who reopens an old account is a normal
 * enough event that staff must not be told to delete history first.
 */
export async function registerBankAccount(
  em: EntityManager,
  input: RegisterBankAccountInput,
): Promise<CustomerBankAccount> {
  const customer = await em.findOne(Customer, { where: { id: input.customerId } });
  if (!customer) throw notFound('Customer');

  const accountNumber = normalizeAccountNumber(input.accountNumber);
  const existing = await em.findOne(CustomerBankAccount, {
    where: { customerId: customer.id, accountNumber },
    lock: { mode: 'pessimistic_write' },
  });
  if (existing && existing.status === BankAccountStatus.ACTIVE) {
    throw conflict(`This account is already registered for ${customer.fullName}`);
  }

  const activeAccounts = await em.find(CustomerBankAccount, {
    where: { customerId: customer.id, status: BankAccountStatus.ACTIVE },
  });
  const hasPrimary = activeAccounts.some((account) => account.isPrimary);
  // The first account is the primary one, and so is the first one after the primary was closed — a
  // customer with a single account should never have to click "make primary" to be payable.
  const isPrimary =
    input.isPrimary === true || activeAccounts.length === 0 || (input.isPrimary !== false && !hasPrimary);

  if (isPrimary) {
    await em.update(CustomerBankAccount, { customerId: customer.id, isPrimary: true }, { isPrimary: false });
  }

  const account =
    existing ??
    em.create(CustomerBankAccount, {
      customerId: customer.id,
      accountNumber,
      createdBy: input.userId,
    });

  account.bankName = input.bankName.trim();
  account.accountNumber = accountNumber;
  account.accountHolderName = input.accountHolderName.trim();
  account.branch = input.branch?.trim() || null;
  account.isPrimary = isPrimary;
  account.status = BankAccountStatus.ACTIVE;
  account.note = input.note ?? null;
  account.closedAt = null;
  account.closeReason = null;
  await em.save(CustomerBankAccount, account);

  await writeAudit(em, {
    action: existing ? 'BANK_ACCOUNT_REOPENED' : 'BANK_ACCOUNT_REGISTERED',
    customerId: customer.id,
    userId: input.userId,
    previousStatus: existing ? BankAccountStatus.CLOSED : null,
    newStatus: BankAccountStatus.ACTIVE,
    makerUserId: input.userId,
    reason:
      `${customer.fullName} (${customer.customerNumber}) — ${account.bankName} ${maskAccountNumber(account.accountNumber)}` +
      `${isPrimary ? ' [primary]' : ''}, holder ${account.accountHolderName}` +
      `${input.note ? ` — ${input.note}` : ''}`,
    sourceRequestId: account.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return account;
}

export interface CloseBankAccountInput {
  accountId: string;
  reason: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Stops an account being used for future money. Loans that were already paid into it keep their recorded
 * account id, because that row says where the money went at the time — rewriting it would destroy the
 * only evidence a transfer ever happened.
 */
export async function closeBankAccount(
  em: EntityManager,
  input: CloseBankAccountInput,
): Promise<CustomerBankAccount> {
  const account = await em.findOne(CustomerBankAccount, {
    where: { id: input.accountId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!account) throw notFound('Bank account');
  if (account.status !== BankAccountStatus.ACTIVE) {
    throw unprocessable(`Bank account is ${account.status} — only an ACTIVE one can be closed`);
  }

  const customer = await em.findOne(Customer, { where: { id: account.customerId } });
  if (!customer) throw notFound('Customer');

  account.status = BankAccountStatus.CLOSED;
  account.isPrimary = false;
  account.closedAt = new Date();
  account.closeReason = input.reason;
  await em.save(CustomerBankAccount, account);

  await writeAudit(em, {
    action: 'BANK_ACCOUNT_CLOSED',
    customerId: account.customerId,
    userId: input.userId,
    previousStatus: BankAccountStatus.ACTIVE,
    newStatus: BankAccountStatus.CLOSED,
    makerUserId: input.userId,
    reason: `${customer.fullName} — ${account.bankName} ${maskAccountNumber(account.accountNumber)} closed: ${input.reason}`,
    sourceRequestId: account.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return account;
}

export interface SetPrimaryInput {
  accountId: string;
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}

/** One call moves the flag, so the panel never has to un-set the old primary first. */
export async function setPrimaryBankAccount(
  em: EntityManager,
  input: SetPrimaryInput,
): Promise<CustomerBankAccount> {
  const account = await em.findOne(CustomerBankAccount, {
    where: { id: input.accountId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!account) throw notFound('Bank account');
  if (account.status !== BankAccountStatus.ACTIVE) {
    throw unprocessable(`Bank account is ${account.status} — a closed one cannot be the primary`);
  }

  await em.update(
    CustomerBankAccount,
    { customerId: account.customerId, isPrimary: true },
    { isPrimary: false },
  );
  account.isPrimary = true;
  await em.save(CustomerBankAccount, account);

  await writeAudit(em, {
    action: 'BANK_ACCOUNT_PRIMARY_SET',
    customerId: account.customerId,
    userId: input.userId,
    newStatus: BankAccountStatus.ACTIVE,
    reason: `${account.bankName} ${maskAccountNumber(account.accountNumber)} is now the primary account of this customer`,
    sourceRequestId: account.id,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  });

  return account;
}

export function findBankAccounts(
  em: EntityManager,
  customerId: string,
  status?: BankAccountStatus,
): Promise<CustomerBankAccount[]> {
  return em.find(CustomerBankAccount, {
    where: status ? { customerId, status } : { customerId },
    order: { isPrimary: 'DESC', createdAt: 'ASC' },
  });
}

/**
 * The account a loan may be paid into: it must exist, belong to this customer and still be open. A closed
 * account is refused here but never rewritten, so history keeps pointing at the number actually used.
 */
export async function assertReceivableAccount(
  em: EntityManager,
  customerId: string,
  accountId: string,
): Promise<CustomerBankAccount> {
  const account = await em.findOne(CustomerBankAccount, { where: { id: accountId } });
  if (!account || account.customerId !== customerId) {
    throw notFound('Bank account of this customer');
  }
  if (account.status !== BankAccountStatus.ACTIVE) {
    throw unprocessable(`Bank account is ${account.status} — money cannot be sent to a closed account`);
  }
  return account;
}
