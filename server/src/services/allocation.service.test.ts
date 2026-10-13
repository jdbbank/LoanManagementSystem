import { describe, expect, it } from 'vitest';
import { ComponentType, type ComponentAmounts } from '../entities/types';
import {
  allocateReversalSequentially,
  allocateSequentially,
  validateAllocationOverride,
} from './allocation.service';

const outstanding: ComponentAmounts = {
  PENALTY: 100,
  PAST_INTEREST: 800,
  PAST_PRINCIPAL: 1_000,
};

describe('allocateSequentially', () => {
  it('allocates penalty, then past interest, then past principal', () => {
    expect(allocateSequentially(150, outstanding)).toEqual({
      allocation: { PENALTY: 100, PAST_INTEREST: 50, PAST_PRINCIPAL: 0 },
      excess: 0,
    });
  });

  it('returns excess for customer credit when payment exceeds outstanding', () => {
    expect(allocateSequentially(2_000, outstanding)).toEqual({
      allocation: { PENALTY: 100, PAST_INTEREST: 800, PAST_PRINCIPAL: 1_000 },
      excess: 100,
    });
  });
});

describe('validateAllocationOverride', () => {
  it('rejects allocations that exceed the received amount', () => {
    expect(() =>
      validateAllocationOverride(
        { PENALTY: 50, PAST_INTEREST: 51, PAST_PRINCIPAL: 0 },
        100,
        outstanding,
      ),
    ).toThrow(/exceeds payment amount/);
  });

  it('rejects allocations that exceed component outstanding', () => {
    expect(() =>
      validateAllocationOverride(
        { PENALTY: 101, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 },
        500,
        outstanding,
      ),
    ).toThrow(/exceeds outstanding/);
  });

  it('rejects negative component values', () => {
    expect(() =>
      validateAllocationOverride(
        { PENALTY: -1, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 },
        100,
        outstanding,
      ),
    ).toThrow(/must not be negative/);
  });
});

describe('allocateReversalSequentially', () => {
  it('reverses an original allocation sequentially, accounting for earlier reversals', () => {
    const original: ComponentAmounts = {
      [ComponentType.PENALTY]: 300,
      [ComponentType.PAST_INTEREST]: 200,
      [ComponentType.PAST_PRINCIPAL]: 200,
    };
    const prior: ComponentAmounts = {
      [ComponentType.PENALTY]: 250,
      [ComponentType.PAST_INTEREST]: 0,
      [ComponentType.PAST_PRINCIPAL]: 0,
    };

    expect(allocateReversalSequentially(100, original, prior)).toEqual({
      reversal: { PENALTY: 50, PAST_INTEREST: 50, PAST_PRINCIPAL: 0 },
      leftover: 0,
    });
  });

  it('reports an amount beyond the remaining reversible allocation', () => {
    const original: ComponentAmounts = {
      PENALTY: 0,
      PAST_INTEREST: 0,
      PAST_PRINCIPAL: 100,
    };
    const prior: ComponentAmounts = { PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 90 };

    expect(allocateReversalSequentially(20, original, prior).leftover).toBe(10);
  });
});
