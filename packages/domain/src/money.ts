/**
 * Money helpers. Extended cost is always computed in application code —
 * never trust a model to "fix" arithmetic silently.
 */

/** Round a possibly fractional quantity × unit-cost into integer cents. */
export function extendedCostCents(qty: number, unitCostCents: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(unitCostCents)) {
    throw new Error("qty and unitCostCents must be finite numbers");
  }
  if (unitCostCents !== Math.trunc(unitCostCents)) {
    throw new Error("unitCostCents must be an integer");
  }

  return Math.round(qty * unitCostCents);
}
