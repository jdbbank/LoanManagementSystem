import { describe, expect, it } from 'vitest';
import { getMetadataArgsStorage } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { env } from '../config/env';
import { User } from '../entities/user.entity';
import { AppError } from '../utils/errors';
import { resolveTenant } from './tenant.service';

/** Answers the one `findOne` resolveTenant makes, from a fake `tenants` table. */
function emReturning(rows: Array<{ id: string; code: string }>): EntityManager {
  return {
    findOne: async (_entity: unknown, options: { where: { code: string } }) =>
      rows.find((r) => r.code === options.where.code) ?? null,
  } as unknown as EntityManager;
}

describe('tenant resolution', () => {
  it('returns the organisation the deployment is configured for', async () => {
    const tenant = { id: 'tenant-1', code: env.tenant.defaultCode };
    await expect(resolveTenant(emReturning([tenant]))).resolves.toBe(tenant);
  });

  it('refuses to run with no organisation instead of inventing one', async () => {
    // A missing row means the schema was never migrated or the code points at another organisation.
    // Either way the safe answer is a hard failure: filing accounts under a guessed tenant is the
    // mistake nobody would notice, because every row would still look complete.
    const error = await resolveTenant(emReturning([])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(503);
    expect((error as AppError).details).toEqual({
      code: 'TENANT_NOT_CONFIGURED',
      tenantCode: env.tenant.defaultCode,
    });
  });

  it('names the code it looked for, since that is the value the operator has to fix', async () => {
    const error = (await resolveTenant(emReturning([{ id: 'x', code: 'another' }])).catch((e: unknown) => e)) as AppError;
    expect((error.details as { tenantCode?: string }).tenantCode).toBe(env.tenant.defaultCode);
  });
});

describe('account uniqueness is per organisation', () => {
  const indices = getMetadataArgsStorage()
    .indices.filter((i) => i.target === User)
    .map((i) => {
      const columns: string[] = typeof i.columns === 'function' ? [] : i.columns ?? [];
      return { name: i.name, columns, unique: i.unique === true };
    });

  it('drops the two installation-wide uniques', () => {
    // Two organisations must be able to hire a "maker1". A lone-username (or lone-email) unique index
    // here would reintroduce the installation-wide rule the composite pair replaces.
    const global = indices.filter(
      (i) => i.unique && (i.columns.join(',') === 'username' || i.columns.join(',') === 'email'),
    );
    expect(global).toEqual([]);
  });

  it('keeps username and email unique inside one tenant', () => {
    for (const column of ['username', 'email']) {
      const scoped = indices.find((i) => i.unique && i.columns.includes('tenantId') && i.columns.includes(column));
      expect(scoped?.columns).toEqual(expect.arrayContaining(['tenantId', column]));
    }
  });

  it('requires an organisation on every account', () => {
    const column = getMetadataArgsStorage().columns.find((c) => c.target === User && c.propertyName === 'tenantId');
    // No database default on purpose: an insert that forgets the tenant must fail loudly.
    expect(column?.options?.nullable).toBeFalsy();
  });
});
