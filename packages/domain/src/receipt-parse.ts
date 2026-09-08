/** RA-35 parseReceipt is separate from the legacy complete-line ExtractionV1 contract. */
export const PARSED_RECEIPT_SCHEMA_VERSION = 1 as const;
export const RECEIPT_DOCUMENT_KINDS = [
  "receipt",
  "invoice",
  "weight_ticket",
  "picking_list",
  "unknown",
] as const;
export type ReceiptDocumentKind = (typeof RECEIPT_DOCUMENT_KINDS)[number];
export type ReceiptEvidence = {
  field: string;
  text: string;
  page_index: number;
  confidence: number;
};
export type ReceiptJobHint = { text: string; page_index: number };
export type ReceiptWarning = { code: string; field: string; message: string };
export type ReceiptAdapterError = { kind: "retryable" | "permanent"; code: string };

/** Strings are verbatim observations, never the provider's guessed normalized numbers. */
export type ReceiptObservationV1 = {
  schema_version: 1;
  document_kind: ReceiptDocumentKind;
  vendor: string | null;
  purchase_date: string | null;
  invoice_number: string | null;
  ticket_number: string | null;
  receipt_total: string | null;
  tax: string | null;
  subtotal: string | null;
  currency: string | null;
  lines: Array<{
    page_index: number;
    description: string | null;
    qty: string | null;
    uom: string | null;
    unit_cost: string | null;
    extended_cost: string | null;
    job_hint: string | null;
  }>;
  job_hints: ReceiptJobHint[];
  raw_text: string;
  evidence: ReceiptEvidence[];
};

export type ParsedReceiptLineV1 = {
  source_index: number;
  page_index: number;
  description: string | null;
  qty: number | null;
  uom: string | null;
  unit_cost_cents: number | null;
  extended_cost_cents: number | null;
  printed_extended_cost_cents: number | null;
  job_hint: string | null;
};

export type ParsedReceiptV1 = {
  schema_version: typeof PARSED_RECEIPT_SCHEMA_VERSION;
  provider: "gemini";
  document_kind: ReceiptDocumentKind;
  vendor: string | null;
  purchase_date: string | null;
  invoice_number: string | null;
  ticket_number: string | null;
  /** Unsupported currencies stay null and cannot become USD costs. */
  currency: "USD" | null;
  receipt_total_cents: number | null;
  tax_cents: number | null;
  subtotal_cents: number | null;
  material_total_cents: number | null;
  lines: ParsedReceiptLineV1[];
  job_hints: ReceiptJobHint[];
  /** Restricted evidence: never include raw_text or evidence text in operational logs. */
  raw_text: string;
  evidence: ReceiptEvidence[];
  confidence: Record<string, number>;
  warnings: ReceiptWarning[];
  /** Original field strings survive validation and arithmetic unchanged, including missing evidence. */
  original_observation: ReceiptObservationV1;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const nullableText = (value: unknown) =>
  value === null || (typeof value === "string" && value.length <= 2000);
const pageIndex = (value: unknown, pageCount: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value < pageCount;
const keysAre = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const rootTextKeys = [
  "vendor",
  "purchase_date",
  "invoice_number",
  "ticket_number",
  "receipt_total",
  "tax",
  "subtotal",
  "currency",
];
const lineTextKeys = ["description", "qty", "uom", "unit_cost", "extended_cost", "job_hint"];

/** Runtime boundary: no string-to-number coercion, invalid confidence or invented page references. */
export function isReceiptObservationV1(
  value: unknown,
  pageCount = 20,
): value is ReceiptObservationV1 {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20 || !isRecord(value))
    return false;
  return (
    keysAre(value, [
      "schema_version",
      "document_kind",
      ...rootTextKeys,
      "lines",
      "job_hints",
      "raw_text",
      "evidence",
    ]) &&
    value.schema_version === 1 &&
    RECEIPT_DOCUMENT_KINDS.includes(value.document_kind as ReceiptDocumentKind) &&
    rootTextKeys.every((key) => nullableText(value[key])) &&
    typeof value.raw_text === "string" &&
    value.raw_text.length <= 100000 &&
    Array.isArray(value.lines) &&
    value.lines.length <= 100 &&
    value.lines.every(
      (line) =>
        isRecord(line) &&
        keysAre(line, ["page_index", ...lineTextKeys]) &&
        pageIndex(line.page_index, pageCount) &&
        lineTextKeys.every((key) => nullableText(line[key])),
    ) &&
    Array.isArray(value.job_hints) &&
    value.job_hints.length <= 100 &&
    value.job_hints.every(
      (hint) =>
        isRecord(hint) &&
        keysAre(hint, ["text", "page_index"]) &&
        typeof hint.text === "string" &&
        hint.text.length > 0 &&
        hint.text.length <= 2000 &&
        pageIndex(hint.page_index, pageCount),
    ) &&
    Array.isArray(value.evidence) &&
    value.evidence.length <= 1200 &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        keysAre(item, ["field", "text", "page_index", "confidence"]) &&
        typeof item.field === "string" &&
        /^(vendor|purchase_date|invoice_number|ticket_number|receipt_total|tax|subtotal|currency|job_hints\.\d+|lines\.\d+\.(description|qty|uom|unit_cost|extended_cost|job_hint))$/.test(
          item.field,
        ) &&
        validEvidencePath(item.field, value.lines as unknown[], value.job_hints as unknown[]) &&
        typeof item.text === "string" &&
        item.text.length > 0 &&
        item.text.length <= 2000 &&
        pageIndex(item.page_index, pageCount) &&
        typeof item.confidence === "number" &&
        Number.isFinite(item.confidence) &&
        item.confidence >= 0 &&
        item.confidence <= 1,
    )
  );
}

function validEvidencePath(path: string, lines: unknown[], hints: unknown[]): boolean {
  const match = /^(lines|job_hints)\.(\d+)/.exec(path);
  return !match || Number(match[2]) < (match[1] === "lines" ? lines.length : hints.length);
}

export function parseReceiptObservationV1(
  value: unknown,
  pageCount = 20,
): ReceiptObservationV1 | null {
  return isReceiptObservationV1(value, pageCount) ? value : null;
}

const cents = (value: unknown) =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647);
const isoDate = (value: unknown) =>
  value === null ||
  (typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !value.startsWith("0000") &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value);

/** Validate persisted normalized contracts independently from TypeScript; future versions fail closed. */
export function isParsedReceiptV1(value: unknown): value is ParsedReceiptV1 {
  if (!isRecord(value) || !isReceiptObservationV1(value.original_observation)) return false;
  return (
    keysAre(value, [
      "schema_version",
      "provider",
      "document_kind",
      "vendor",
      "purchase_date",
      "invoice_number",
      "ticket_number",
      "currency",
      "receipt_total_cents",
      "tax_cents",
      "subtotal_cents",
      "material_total_cents",
      "lines",
      "job_hints",
      "raw_text",
      "evidence",
      "confidence",
      "warnings",
      "original_observation",
    ]) &&
    value.schema_version === 1 &&
    value.provider === "gemini" &&
    RECEIPT_DOCUMENT_KINDS.includes(value.document_kind as ReceiptDocumentKind) &&
    ["vendor", "invoice_number", "ticket_number"].every((key) => nullableText(value[key])) &&
    isoDate(value.purchase_date) &&
    (value.currency === "USD" || value.currency === null) &&
    ["receipt_total_cents", "tax_cents", "subtotal_cents", "material_total_cents"].every((key) =>
      cents(value[key]),
    ) &&
    Array.isArray(value.lines) &&
    value.lines.length <= 100 &&
    value.lines.every(
      (line, index) =>
        isRecord(line) &&
        keysAre(line, [
          "source_index",
          "page_index",
          "description",
          "qty",
          "uom",
          "unit_cost_cents",
          "extended_cost_cents",
          "printed_extended_cost_cents",
          "job_hint",
        ]) &&
        typeof line.source_index === "number" &&
        Number.isInteger(line.source_index) &&
        line.source_index >= 0 &&
        line.source_index < (value.original_observation as ReceiptObservationV1).lines.length &&
        (index === 0 ||
          line.source_index >
            ((value.lines as ParsedReceiptLineV1[])[index - 1]?.source_index ?? -1)) &&
        pageIndex(line.page_index, 20) &&
        ["description", "uom", "job_hint"].every((key) => nullableText(line[key])) &&
        (line.qty === null ||
          (typeof line.qty === "number" &&
            line.qty > 0 &&
            /^\d{1,9}(?:\.\d{1,3})?$/.test(String(line.qty)))) &&
        ["unit_cost_cents", "extended_cost_cents", "printed_extended_cost_cents"].every((key) =>
          cents(line[key]),
        ),
    ) &&
    typeof value.raw_text === "string" &&
    value.raw_text.length <= 100000 &&
    Array.isArray(value.job_hints) &&
    value.job_hints.every(
      (hint) =>
        isRecord(hint) &&
        keysAre(hint, ["text", "page_index"]) &&
        typeof hint.text === "string" &&
        hint.text.length > 0 &&
        hint.text.length <= 2000 &&
        pageIndex(hint.page_index, 20),
    ) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(
      (item) =>
        isRecord(item) &&
        keysAre(item, ["field", "text", "page_index", "confidence"]) &&
        typeof item.field === "string" &&
        typeof item.text === "string" &&
        item.text.length > 0 &&
        item.text.length <= 2000 &&
        pageIndex(item.page_index, 20) &&
        typeof item.confidence === "number" &&
        Number.isFinite(item.confidence) &&
        item.confidence >= 0 &&
        item.confidence <= 1,
    ) &&
    isRecord(value.confidence) &&
    Object.values(value.confidence).every(
      (item) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1,
    ) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(
      (warning) =>
        isRecord(warning) &&
        keysAre(warning, ["code", "field", "message"]) &&
        ["code", "field", "message"].every(
          (key) => typeof warning[key] === "string" && (warning[key] as string).length > 0,
        ),
    )
  );
}

export function parseParsedReceiptV1(value: unknown): ParsedReceiptV1 | null {
  return isParsedReceiptV1(value) ? value : null;
}
