/** RA-4 review snapshots. Empty fields are allowed in drafts; approval is strict. */
export type ReviewLine = {
  id?: string;
  sourceIndex?: number;
  description: string;
  qty: string;
  uom: string;
  unitCost: string;
  jobId: string;
  suggestionId?: string;
};
export type ReviewDraft = {
  vendor: string;
  purchaseDate: string;
  invoiceNumber: string;
  ticketNumber: string;
  category: string;
  referenceTotal: string;
  managerNotes: string;
  lines: ReviewLine[];
};
export type ReviewErrors = Record<string, string>;
export const EMPTY_REVIEW: ReviewDraft = {
  vendor: "",
  purchaseDate: "",
  invoiceNumber: "",
  ticketNumber: "",
  category: "",
  referenceTotal: "",
  managerNotes: "",
  lines: [],
};
export function decimalUnits(value: string, precision: number): number | null {
  if (!new RegExp(`^\\d{1,9}(?:\\.\\d{1,${precision}})?$`).test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const result = Number(whole) * 10 ** precision + Number(fraction.padEnd(precision, "0"));
  return Number.isSafeInteger(result) ? result : null;
}
export function lineCostCents(line: ReviewLine): number | null {
  const qty = decimalUnits(line.qty, 3);
  const unit = decimalUnits(line.unitCost, 2);
  if (qty === null || qty <= 0 || unit === null || unit > 2147483647) return null;
  const cents = (BigInt(qty) * BigInt(unit) + BigInt(500)) / BigInt(1000);
  return cents <= BigInt(2147483647) ? Number(cents) : null;
}
export function validateReview(draft: ReviewDraft, approval = false): ReviewErrors {
  const errors: ReviewErrors = {};
  for (const key of ["vendor", "purchaseDate", "category"] as const)
    if (approval && !draft[key].trim()) errors[key] = "Required before approval.";
  if (
    draft.purchaseDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(draft.purchaseDate) ||
      draft.purchaseDate.startsWith("0000") ||
      !Number.isFinite(Date.parse(draft.purchaseDate)) ||
      new Date(draft.purchaseDate).toISOString().slice(0, 10) !== draft.purchaseDate)
  )
    errors.purchaseDate = "Enter a valid calendar date.";
  if (
    draft.referenceTotal &&
    (decimalUnits(draft.referenceTotal, 2) === null ||
      (decimalUnits(draft.referenceTotal, 2) ?? 0) > 2147483647)
  )
    errors.referenceTotal = "Use a nonnegative amount with up to two decimal places.";
  if (approval && !draft.lines.length) errors.lines = "Add at least one material line.";
  let total = 0;
  draft.lines.forEach((line, index) => {
    const key = `lines.${index}`;
    if (approval && !line.description.trim()) errors[`${key}.description`] = "Enter a description.";
    if (
      (approval || line.qty) &&
      (decimalUnits(line.qty, 3) === null || (decimalUnits(line.qty, 3) ?? 0) <= 0)
    )
      errors[`${key}.qty`] = "Use a positive quantity with up to three decimal places.";
    if (
      (approval || line.unitCost) &&
      (decimalUnits(line.unitCost, 2) === null ||
        (decimalUnits(line.unitCost, 2) ?? 0) > 2147483647)
    )
      errors[`${key}.unitCost`] = "Use a nonnegative cost with up to two decimal places.";
    if (
      line.qty &&
      line.unitCost &&
      lineCostCents(line) === null &&
      !errors[`${key}.qty`] &&
      !errors[`${key}.unitCost`]
    )
      errors[`${key}.unitCost`] = "Extended cost is too large.";
    if (approval && !line.jobId.trim())
      errors[`${key}.jobId`] = "Choose a Housecall job. Overhead is not enabled.";
    total += lineCostCents(line) ?? 0;
  });
  if (total > 2147483647) errors.lines = "The material total is too large.";
  return errors;
}
export function reviewSummary(draft: ReviewDraft) {
  const jobs = new Map<string, { lines: number; totalCents: number }>();
  for (const line of draft.lines) {
    const entry = jobs.get(line.jobId) ?? { lines: 0, totalCents: 0 };
    entry.lines++;
    entry.totalCents += lineCostCents(line) ?? 0;
    jobs.set(line.jobId, entry);
  }
  return {
    lineCount: draft.lines.length,
    jobCount: [...jobs.keys()].filter(Boolean).length,
    totalCents: [...jobs.values()].reduce((sum, job) => sum + job.totalCents, 0),
    jobs: [...jobs].map(([id, value]) => ({ id, ...value })),
  };
}
