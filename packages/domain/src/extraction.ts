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
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ExtractionV1>;
  return (
    candidate.schema_version === EXTRACTION_SCHEMA_VERSION &&
    Array.isArray(candidate.lines) &&
    typeof candidate.confidence === "object" &&
    candidate.confidence !== null
  );
}

/**
 * Parse unknown JSON into ExtractionV1 when schema_version matches.
 * Unknown or future versions return null (do not pretend they are v1).
 */
export function parseExtractionV1(value: unknown): ExtractionV1 | null {
  return isExtractionV1(value) ? value : null;
}
