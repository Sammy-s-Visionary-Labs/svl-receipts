/**
 * Cloud readability gate result (RA-25).
 * Provider JSON (Gemini/OpenAI/etc.) stays in adapters — RA-35/RA-36 complete parseReceipt later.
 */

export const READABILITY_SCHEMA_VERSION = 1 as const;

export type ReadabilitySchemaVersion = typeof READABILITY_SCHEMA_VERSION;

export const READABILITY_REASONS = [
  "blurry",
  "too_dark",
  "glare",
  "cropped",
  "rotated",
  "low_resolution",
  "not_a_receipt",
  "unreadable",
] as const;

export type ReadabilityReason = (typeof READABILITY_REASONS)[number];

export type ReadableCheckV1 = {
  schema_version: ReadabilitySchemaVersion;
  readable: true;
};

export type UnreadableCheckV1 = {
  schema_version: ReadabilitySchemaVersion;
  readable: false;
  /** At least one page failed. Indexes are 0-based in capture order. */
  failed_page_indexes: number[];
  reasons: ReadabilityReason[];
};

export type ReadabilityCheckV1 = ReadableCheckV1 | UnreadableCheckV1;

export const READABILITY_ERROR_KINDS = ["retryable", "permanent"] as const;

export type ReadabilityErrorKind = (typeof READABILITY_ERROR_KINDS)[number];

/** Normalized adapter failure — never a vendor error body. */
export type ReadabilityAdapterError = {
  kind: ReadabilityErrorKind;
  code: string;
};

export function isReadabilityReason(value: string): value is ReadabilityReason {
  return (READABILITY_REASONS as readonly string[]).includes(value);
}

export function isReadabilityCheckV1(value: unknown): value is ReadabilityCheckV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ReadabilityCheckV1> & {
    failed_page_indexes?: unknown;
    reasons?: unknown;
  };

  if (candidate.schema_version !== READABILITY_SCHEMA_VERSION) {
    return false;
  }

  if (candidate.readable === true) {
    return true;
  }

  if (candidate.readable !== false) {
    return false;
  }

  return (
    Array.isArray(candidate.failed_page_indexes) &&
    candidate.failed_page_indexes.every((index) => Number.isInteger(index) && index >= 0) &&
    Array.isArray(candidate.reasons) &&
    candidate.reasons.length > 0 &&
    candidate.reasons.every((reason) => typeof reason === "string" && isReadabilityReason(reason))
  );
}
