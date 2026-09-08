/** Current extraction contract version. Bump when the public shape changes. */
export const EXTRACTION_SCHEMA_VERSION = 1 as const;

export type ExtractionSchemaVersion = typeof EXTRACTION_SCHEMA_VERSION;

export const EXTRACTION_PROVIDERS = ["gemini", "openai", "unknown"] as const;

export type ExtractionProvider = (typeof EXTRACTION_PROVIDERS)[number];

/**
 * Per-field confidence in [0, 1].
 * Keys are field paths such as "vendor" or "lines.0.unit_cost_cents".
 */
export type FieldConfidenceMap = Record<string, number>;

export type ExtractionLineV1 = {
  description: string;
  qty: number;
  uom?: string;
  unit_cost_cents: number;
  /** Optional job / PO / ref hint from the document — not a Housecall ID. */
  job_hint?: string;
};

/**
 * Provider-normalized extraction result.
 * Raw Gemini/OpenAI payloads must stay behind adapters — not in this type.
 */
export type ExtractionV1 = {
  schema_version: ExtractionSchemaVersion;
  provider: ExtractionProvider;
  vendor?: string;
  purchase_date?: string;
  invoice_number?: string;
  ticket_number?: string;
  /** Reference only — not used as the Housecall cost total. */
  receipt_total_cents?: number;
  tax_cents?: number;
  lines: ExtractionLineV1[];
  raw_text?: string;
  confidence: FieldConfidenceMap;
};

export function isExtractionV1(value: unknown): value is ExtractionV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ExtractionV1>;
  return (
    candidate.schema_version === EXTRACTION_SCHEMA_VERSION &&
    EXTRACTION_PROVIDERS.includes(candidate.provider as ExtractionProvider) &&
    [candidate.vendor, candidate.invoice_number, candidate.ticket_number, candidate.raw_text].every(
      (field) => field === undefined || typeof field === "string",
    ) &&
    (candidate.purchase_date === undefined || validExtractionDate(candidate.purchase_date)) &&
    [candidate.receipt_total_cents, candidate.tax_cents].every(
      (field) => field === undefined || validExtractionCents(field),
    ) &&
    Array.isArray(candidate.lines) &&
    candidate.lines.length <= 100 &&
    candidate.lines.every(
      (line) =>
        !!line &&
        typeof line === "object" &&
        typeof line.description === "string" &&
        typeof line.qty === "number" &&
        Number.isFinite(line.qty) &&
        line.qty > 0 &&
        /^\d{1,9}(?:\.\d{1,3})?$/.test(String(line.qty)) &&
        validExtractionCents(line.unit_cost_cents) &&
        (line.uom === undefined || typeof line.uom === "string") &&
        (line.job_hint === undefined || typeof line.job_hint === "string"),
    ) &&
    typeof candidate.confidence === "object" &&
    candidate.confidence !== null &&
    !Array.isArray(candidate.confidence) &&
    Object.values(candidate.confidence).every(
      (confidence) =>
        typeof confidence === "number" &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1,
    )
  );
}

function validExtractionCents(value: unknown): boolean {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2147483647
  );
}

function validExtractionDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !value.startsWith("0000") &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value
  );
}

/**
 * Parse unknown JSON into ExtractionV1 when schema_version matches.
 * Unknown or future versions return null (do not pretend they are v1).
 */
export function parseExtractionV1(value: unknown): ExtractionV1 | null {
  return isExtractionV1(value) ? value : null;
}
