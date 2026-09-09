import { decimalUnits } from "./review-draft";
/** Deterministic cents, matching the review and database approval contract. */
export function extendedCostCents(qty: number, unitCostCents: number): number {
  if (!Number.isFinite(qty) || !Number.isFinite(unitCostCents))
    throw new Error("qty and unitCostCents must be finite numbers");
  if (!Number.isSafeInteger(unitCostCents)) throw new Error("unitCostCents must be an integer");
  const units = decimalUnits(String(qty), 3);
  if (units === null || units <= 0 || unitCostCents < 0 || unitCostCents > 2147483647)
    throw new Error("Invalid quantity or unit cost");
  const cents = (BigInt(units) * BigInt(unitCostCents) + BigInt(500)) / BigInt(1000);
  if (cents > BigInt(2147483647)) throw new Error("Extended cost is too large");
  return Number(cents);
}
