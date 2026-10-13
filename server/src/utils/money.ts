/**
 * Money helpers.
 * Amounts are stored as DECIMAL(18,2) columns; TypeORM returns them as strings,
 * so all reads go through `num()` and all arithmetic is rounded with round2().
 * LAK has no subunit in practice; 2 decimals are kept for safety.
 */
export const EPS = 0.005;

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

export const isZero = (n: number): boolean => Math.abs(num(n)) < EPS;

export const sumAmounts = (...values: unknown[]): number =>
  round2(values.reduce<number>((acc, v) => acc + num(v), 0));

export const formatAmount = (v: unknown, currency = 'LAK'): string =>
  `${num(v).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${currency}`;
