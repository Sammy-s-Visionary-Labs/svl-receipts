import { extendedCostCents } from "./money";
import {
  isReceiptObservationV1,
  type ParsedReceiptV1,
  type ReceiptObservationV1,
  type ReceiptWarning,
} from "./receipt-parse";
import { decimalUnits } from "./review-draft";

export type ReceiptNormalizationOptions = {
  /** A verified vendor/tenant date convention, never inferred from the model's guess. */
  dateOrder?: "MDY" | "DMY";
  lowConfidenceThreshold?: number;
  mismatchToleranceCents?: number;
};
type Normalized<T> = { value: T | null; issue?: string };
const MAX_CENTS = 2147483647;
const text = (value: string | null) => value?.trim() || null;

/** USD decimal point, optional correctly grouped commas, $ or USD. No exponent/coercion/rounding. */
export function normalizeReceiptMoney(value: string | null): Normalized<number> {
  const trimmed = text(value);
  if (!trimmed) return { value: null };
  const raw = trimmed.replace(/^(?:USD\s*|\$\s*)/i, "").replace(/\s+USD$/i, "");
  if (/^-|^\(.*\)$/.test(raw)) return { value: null, issue: "unsupported_return" };
  if (!/^(?:\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,2})?$/.test(raw))
    return { value: null, issue: "invalid_money" };
  const cents = decimalUnits(raw.replaceAll(",", ""), 2);
  return cents === null || cents > MAX_CENTS
    ? { value: null, issue: "amount_out_of_range" }
    : { value: cents };
}

export function normalizeReceiptQuantity(value: string | null): Normalized<number> {
  const raw = text(value);
  if (!raw) return { value: null };
  if (/^-|^\(.*\)$/.test(raw)) return { value: null, issue: "unsupported_return" };
  if (!/^(?:\d{1,9}|\d{1,3}(?:,\d{3}){1,2})(?:\.\d{1,3})?$/.test(raw))
    return { value: null, issue: "invalid_quantity" };
  const units = decimalUnits(raw.replaceAll(",", ""), 3);
  return units === null || units <= 0
    ? { value: null, issue: "invalid_quantity" }
    : { value: units / 1000 };
}

const unitAliases: Record<string, string> = {
  ea: "ea",
  each: "ea",
  pcs: "ea",
  pc: "ea",
  piece: "ea",
  pieces: "ea",
  unit: "ea",
  units: "ea",
  ton: "ton",
  tons: "ton",
  tn: "ton",
  st: "ton",
  yd: "yd",
  yard: "yd",
  yards: "yd",
  yd3: "yd3",
  "cu yd": "yd3",
  "cubic yards": "yd3",
  cy: "yd3",
  ft: "ft",
  feet: "ft",
  foot: "ft",
  lf: "ft",
  "linear feet": "ft",
  lb: "lb",
  lbs: "lb",
  pound: "lb",
  pounds: "lb",
  gal: "gal",
  gallon: "gal",
  gallons: "gal",
  bag: "bag",
  bags: "bag",
  box: "box",
  boxes: "box",
  can: "can",
  cans: "can",
  sf: "ft2",
  sqft: "ft2",
  "sq ft": "ft2",
  ft2: "ft2",
  hr: "hr",
  hour: "hr",
  hours: "hr",
};

export function normalizeReceiptUnit(value: string | null): Normalized<string> {
  const raw = text(value)
    ?.toLowerCase()
    .replace(/[.]/g, "")
    .replaceAll("³", "3")
    .replaceAll("²", "2")
    .replace(/\s+/g, " ");
  if (!raw) return { value: null };
  const canonical = Object.hasOwn(unitAliases, raw) ? unitAliases[raw] : undefined;
  return canonical ? { value: canonical } : { value: text(value), issue: "unknown_unit" };
}

function calendarDate(year: number, month: number, day: number): Normalized<string> {
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return year > 0 &&
    year <= 9999 &&
    Number.isFinite(Date.parse(iso)) &&
    new Date(iso).toISOString().slice(0, 10) === iso
    ? { value: iso }
    : { value: null, issue: "invalid_date" };
}

export function normalizeReceiptDate(
  value: string | null,
  order?: "MDY" | "DMY",
): Normalized<string> {
  const raw = text(value);
  if (!raw) return { value: null };
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) return calendarDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first < 1 || second < 1 || first > 31 || second > 31 || (first > 12 && second > 12))
      return { value: null, issue: "invalid_date" };
    if (!order && first <= 12 && second <= 12 && first !== second)
      return { value: null, issue: "ambiguous_date" };
    const dayFirst = order === "DMY" || (!order && first > 12);
    return calendarDate(Number(match[3]), dayFirst ? second : first, dayFirst ? first : second);
  }
  const months = [
    ["jan", "january"],
    ["feb", "february"],
    ["mar", "march"],
    ["apr", "april"],
    ["may"],
    ["jun", "june"],
    ["jul", "july"],
    ["aug", "august"],
    ["sep", "sept", "september"],
    ["oct", "october"],
    ["nov", "november"],
    ["dec", "december"],
  ];
  match = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(raw);
  if (match) {
    const month = months.findIndex((names) => names.includes((match?.[1] ?? "").toLowerCase()));
    if (month >= 0) return calendarDate(Number(match[3]), month + 1, Number(match[2]));
  }
  // Two-digit years have no safe century convention in the extraction contract.
  return {
    value: null,
    issue: /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(raw) ? "ambiguous_date" : "invalid_date",
  };
}

const messages: Record<string, string> = {
  missing_field: "This field was not found; check the document before approval.",
  invalid_money: "The amount does not match USD formatting with at most two decimal places.",
  invalid_quantity: "Use a positive quantity with at most three decimal places.",
  amount_out_of_range: "The amount is outside the supported cost range.",
  unsupported_return:
    "Return and credit amounts need separate review; automatic import is deferred.",
  ambiguous_date: "The date has an ambiguous order or two-digit year; verify the purchase date.",
  invalid_date: "This is not a supported calendar date.",
  unknown_unit: "The unit is unrecognized; verify it without converting the quantity.",
};

export function normalizeReceiptObservation(
  observation: ReceiptObservationV1,
  options: ReceiptNormalizationOptions = {},
): ParsedReceiptV1 {
  if (!isReceiptObservationV1(observation)) throw new Error("invalid_receipt_observation");
  const threshold = options.lowConfidenceThreshold ?? 0.7;
  const tolerance = options.mismatchToleranceCents ?? 1;
  if (
    !Number.isFinite(threshold) ||
    threshold < 0 ||
    threshold > 1 ||
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0
  )
    throw new Error("invalid_normalization_options");
  const warnings: ReceiptWarning[] = [];
  const warn = (code: string, field: string, message = messages[code] || code) =>
    warnings.push({ code, field, message });
  const take = <T>(normalized: Normalized<T>, field: string, required = false): T | null => {
    if (normalized.issue) warn(normalized.issue, field);
    else if (required && normalized.value === null) warn("missing_field", field);
    return normalized.value;
  };
  const currency =
    !text(observation.currency) || /^(USD|\$|US\$)$/i.test((observation.currency ?? "").trim())
      ? "USD"
      : null;
  if (!currency)
    warn(
      "unsupported_currency",
      "currency",
      "This currency cannot be imported as USD; verify all amounts.",
    );
  const money = (value: string | null, field: string, required = false) =>
    currency ? take(normalizeReceiptMoney(value), field, required) : null;
  const vendor = text(observation.vendor);
  if (!vendor) warn("missing_field", "vendor");
  const purchaseDate = take(
    normalizeReceiptDate(observation.purchase_date, options.dateOrder),
    "purchase_date",
    true,
  );
  const total = money(observation.receipt_total, "receipt_total_cents");
  const tax = money(observation.tax, "tax_cents");
  const subtotal = money(observation.subtotal, "subtotal_cents");
  const lines = observation.lines
    .map((line, index) => {
      const path = `lines.${index}`;
      const qty = take(normalizeReceiptQuantity(line.qty), `${path}.qty`, true);
      const unit = money(line.unit_cost, `${path}.unit_cost_cents`, true);
      const printed = money(line.extended_cost, `${path}.printed_extended_cost_cents`);
      const uom = take(normalizeReceiptUnit(line.uom), `${path}.uom`);
      const description = text(line.description);
      if (!description) warn("missing_field", `${path}.description`);
      let extended: number | null = null;
      if (qty !== null && unit !== null) {
        try {
          extended = extendedCostCents(qty, unit);
        } catch {
          warn("amount_out_of_range", `${path}.extended_cost_cents`);
        }
      }
      if (extended !== null && printed !== null && Math.abs(extended - printed) > tolerance)
        warn(
          "line_total_mismatch",
          `${path}.printed_extended_cost_cents`,
          "Printed line amount differs from quantity × unit cost; calculated material cost is preserved.",
        );
      return {
        source_index: index,
        page_index: line.page_index,
        description,
        qty,
        uom,
        unit_cost_cents: unit,
        extended_cost_cents: extended,
        printed_extended_cost_cents: printed,
        job_hint: text(line.job_hint),
      };
    })
    .filter((line) => {
      if (
        line.description &&
        /^(?:sales tax|tax|subtotal|grand total|receipt total|total|balance due|amount due|cash|change|tender|visa|mastercard)\s*:?$/i.test(
          line.description,
        )
      ) {
        warn(
          "reference_line_excluded",
          `lines.${line.source_index}`,
          "Tax, payment and summary amounts are reference information and cannot become material costs.",
        );
        return false;
      }
      return true;
    });
  if (!lines.length) warn("missing_field", "lines");
  let materialTotal =
    lines.length && lines.every((line) => line.extended_cost_cents !== null)
      ? lines.reduce((sum, line) => sum + (line.extended_cost_cents ?? 0), 0)
      : null;
  if (materialTotal !== null && materialTotal > MAX_CENTS) {
    materialTotal = null;
    warn("amount_out_of_range", "material_total_cents");
  }
  if (materialTotal !== null && subtotal !== null && Math.abs(materialTotal - subtotal) > tolerance)
    warn(
      "subtotal_mismatch",
      "subtotal_cents",
      "Material line sum differs from the printed subtotal; verify discounts, fees or missing lines.",
    );
  if (
    materialTotal !== null &&
    total !== null &&
    tax !== null &&
    Math.abs(materialTotal + tax - total) > tolerance
  )
    warn(
      "receipt_total_mismatch",
      "receipt_total_cents",
      "Material line sum plus reference tax differs from the receipt total; tax never changes material costs.",
    );
  if (observation.document_kind === "picking_list" || observation.document_kind === "unknown")
    warn(
      "document_requires_review",
      "document_kind",
      "This document does not establish a purchase receipt; verify supporting evidence.",
    );
  const normalizedField = (field: string) => {
    if (["receipt_total", "tax", "subtotal"].includes(field)) return `${field}_cents`;
    return field
      .replace(/\.unit_cost$/, ".unit_cost_cents")
      .replace(/\.extended_cost$/, ".printed_extended_cost_cents");
  };
  const observedConfidence: Record<string, number> = {};
  for (const item of observation.evidence) {
    // Multiple pieces of evidence for a field retain the weakest reported confidence.
    observedConfidence[item.field] = Math.min(observedConfidence[item.field] ?? 1, item.confidence);
  }
  const confidence = Object.fromEntries(
    Object.entries(observedConfidence).map(([field, value]) => [normalizedField(field), value]),
  );
  for (const [field, value] of Object.entries(confidence))
    if (value < threshold)
      warn("low_confidence", field, "The extracted evidence is uncertain; verify this field.");
  const expectedEvidence = [
    "vendor",
    "purchase_date",
    "invoice_number",
    "ticket_number",
    "receipt_total",
    "tax",
    "subtotal",
    "currency",
  ].filter((key) => text(observation[key as "vendor"]));
  observation.lines.forEach((line, index) => {
    for (const key of [
      "description",
      "qty",
      "uom",
      "unit_cost",
      "extended_cost",
      "job_hint",
    ] as const)
      if (text(line[key])) expectedEvidence.push(`lines.${index}.${key}`);
  });
  observation.job_hints.forEach((_, index) => {
    expectedEvidence.push(`job_hints.${index}`);
  });
  for (const field of expectedEvidence)
    if (!Object.hasOwn(observedConfidence, field))
      warn(
        "missing_evidence",
        normalizedField(field),
        "The provider did not supply field confidence and source evidence; verify this field.",
      );
  return {
    schema_version: 1,
    provider: "gemini",
    document_kind: observation.document_kind,
    vendor,
    purchase_date: purchaseDate,
    invoice_number: text(observation.invoice_number),
    ticket_number: text(observation.ticket_number),
    currency,
    receipt_total_cents: total,
    tax_cents: tax,
    subtotal_cents: subtotal,
    material_total_cents: materialTotal,
    lines,
    job_hints: observation.job_hints.map((hint) => ({ ...hint })),
    raw_text: observation.raw_text,
    evidence: observation.evidence.map((item) => ({ ...item })),
    confidence,
    warnings,
    original_observation: structuredClone(observation),
  };
}
