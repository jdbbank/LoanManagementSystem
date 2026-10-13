import { ComponentAmounts, ComponentType } from '../entities/types';
import { unprocessable } from '../utils/errors';
import { EPS, num, round2 } from '../utils/money';

/** Global default allocation order — LOCKED (section 5): Penalty -> Past Interest -> Past Principal. */
export const ALLOCATION_ORDER: ComponentType[] = [
  ComponentType.PENALTY,
  ComponentType.PAST_INTEREST,
  ComponentType.PAST_PRINCIPAL,
];

export const zeroComponents = (): ComponentAmounts => ({
  PENALTY: 0,
  PAST_INTEREST: 0,
  PAST_PRINCIPAL: 0,
});

const sumComponents = (c: ComponentAmounts): number =>
  round2(num(c.PENALTY) + num(c.PAST_INTEREST) + num(c.PAST_PRINCIPAL));

/**
 * Sequential allocation of a payment over outstanding components (LOCKED section 5).
 * The system does not move to the next component until the current one is fully satisfied.
 * Any remainder is returned as excess (overpayment -> customer credit, LOCKED section 6).
 */
export function allocateSequentially(
  total: number,
  outstanding: ComponentAmounts,
): { allocation: ComponentAmounts; excess: number } {
  const allocation = zeroComponents();
  let remaining = round2(num(total));
  for (const component of ALLOCATION_ORDER) {
    const available = num(outstanding[component]);
    const applied = Math.min(remaining, available);
    if (applied > EPS) {
      allocation[component] = round2(applied);
      remaining = round2(remaining - applied);
    }
  }
  return { allocation, excess: remaining };
}

/**
 * Staff allocation override — HARD validation (LOCKED section 7).
 * Throws 422 immediately when allocation exceeds payment amount or outstanding.
 * No warning-only mode, no bypass.
 */
export function validateAllocationOverride(
  override: ComponentAmounts,
  paymentTotal: number,
  outstanding: ComponentAmounts,
): void {
  for (const component of ALLOCATION_ORDER) {
    const value = num(override[component]);
    if (value < -EPS) {
      throw unprocessable(`Allocation for ${component} must not be negative`);
    }
    if (value - num(outstanding[component]) > EPS) {
      throw unprocessable(
        `Allocation for ${component} (${round2(value)}) exceeds outstanding (${num(outstanding[component])})`,
      );
    }
  }
  const total = sumComponents(override);
  if (total - round2(num(paymentTotal)) > EPS) {
    throw unprocessable(
      `Total allocation (${total}) exceeds payment amount (${round2(num(paymentTotal))})`,
    );
  }
}

/**
 * Partial reversal follows the ORIGINAL allocation sequentially — LOCKED (section 10).
 * No pro-rata, no manual component selection. Reversal consumes the remaining
 * (not yet reversed) portion of the original allocation, component by component in order.
 */
export function allocateReversalSequentially(
  amount: number,
  originalAllocation: ComponentAmounts,
  alreadyReversed: ComponentAmounts,
): { reversal: ComponentAmounts; leftover: number } {
  const reversal = zeroComponents();
  let remaining = round2(num(amount));
  for (const component of ALLOCATION_ORDER) {
    const reversible = round2(num(originalAllocation[component]) - num(alreadyReversed[component]));
    const applied = Math.max(0, Math.min(remaining, reversible));
    if (applied > EPS) {
      reversal[component] = round2(applied);
      remaining = round2(remaining - applied);
    }
  }
  return { reversal, leftover: remaining };
}
