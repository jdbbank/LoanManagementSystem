import { ComponentAmounts } from '../entities/types';
import { num, round2 } from '../utils/money';

export function adjustmentMagnitude(components: ComponentAmounts): number {
  return round2(
    Math.abs(num(components.PENALTY)) +
      Math.abs(num(components.PAST_INTEREST)) +
      Math.abs(num(components.PAST_PRINCIPAL)),
  );
}
