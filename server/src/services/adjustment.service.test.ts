import { describe, expect, it } from 'vitest';
import { adjustmentMagnitude } from './adjustment.service';

describe('adjustmentMagnitude', () => {
  it('counts component changes even when positive and negative amounts net to zero', () => {
    expect(adjustmentMagnitude({ PENALTY: 100, PAST_INTEREST: -100, PAST_PRINCIPAL: 0 })).toBe(200);
  });

  it('returns zero when every component is unchanged', () => {
    expect(adjustmentMagnitude({ PENALTY: 0, PAST_INTEREST: 0, PAST_PRINCIPAL: 0 })).toBe(0);
  });
});
