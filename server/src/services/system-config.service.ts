import { EntityManager, In } from 'typeorm';
import { SystemConfig } from '../entities/system-config.entity';

export type ConfigRow = { value: number; valueText: string | null };

/** Reads every config row a policy needs in one query. */
export async function readConfigRows(em: EntityManager, keys: string[]): Promise<Map<string, ConfigRow>> {
  if (keys.length === 0) return new Map();
  const rows = await em.find(SystemConfig, { where: { key: In(keys) } });
  return new Map(rows.map((r) => [r.key, { value: Number(r.value), valueText: r.valueText ?? null }]));
}

/** Insert-or-update one row; numeric values and text values share the same table. */
export async function writeConfigRow(
  em: EntityManager,
  input: { key: string; value: number; valueText: string | null; description: string; updatedBy: string },
): Promise<void> {
  const existing = await em.findOne(SystemConfig, { where: { key: input.key } });
  if (existing) {
    existing.value = input.value;
    existing.valueText = input.valueText;
    existing.description = input.description;
    existing.updatedBy = input.updatedBy;
    await em.save(SystemConfig, existing);
    return;
  }
  await em.save(SystemConfig, em.create(SystemConfig, input));
}

export function parseCsv(raw: string | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}
