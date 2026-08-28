import { MAX_RECEIPT_PAGES } from "./upload";

export const RECEIPT_UPLOAD_EVENTS = [
  "session_created",
  "page_upload_completed",
  "confirmation_completed",
  "submission_failed",
] as const;

/** Server request phases use disjoint names so client lifecycle events are not double-counted. */
export const RECEIPT_UPLOAD_SERVER_EVENTS = [
  "session_api_completed",
  "session_api_failed",
  "confirmation_api_completed",
  "confirmation_api_failed",
] as const;

export const RECEIPT_UPLOAD_RESULTS = ["success", "failure", "cancelled"] as const;

export const RECEIPT_UPLOAD_FAILURE_CATEGORIES = [
  "network",
  "session_expired",
  "storage_rejected",
  "confirmation_rejected",
  "unauthorized",
  "cancelled",
  "invalid_response",
  "unknown",
] as const;

export type ReceiptUploadEventName = (typeof RECEIPT_UPLOAD_EVENTS)[number];
export type ReceiptUploadServerEventName = (typeof RECEIPT_UPLOAD_SERVER_EVENTS)[number];
export type ReceiptUploadResult = (typeof RECEIPT_UPLOAD_RESULTS)[number];
export type ReceiptUploadFailureCategory = (typeof RECEIPT_UPLOAD_FAILURE_CATEGORIES)[number];

export type ReceiptUploadTelemetryEvent = {
  event: ReceiptUploadEventName;
  receiptId: string;
  pageCount: number;
  occurredAt: string;
  durationMs?: number;
  pageIndex?: number;
  result?: ReceiptUploadResult;
  failureCategory?: ReceiptUploadFailureCategory;
};

export type ReceiptUploadClientMetric = ReceiptUploadTelemetryEvent & {
  source: "mobile";
};

export type ReceiptUploadServerMetric = {
  source: "server";
  event: ReceiptUploadServerEventName;
  receiptId: string;
  pageCount: number;
  durationMs: number;
  result: "success" | "failure";
};

export function createReceiptUploadServerMetric(
  metric: Omit<ReceiptUploadServerMetric, "source">,
): ReceiptUploadServerMetric | null {
  const receiptId = canonicalReceiptUploadId(metric.receiptId);
  return receiptId ? { source: "server", ...metric, receiptId } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Canonical correlation id accepted by receipt-upload APIs and metrics. */
export function canonicalReceiptUploadId(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

function canonicalReceiptUploadTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value.length !== 24 || !CANONICAL_UTC_TIMESTAMP.test(value)) {
    return null;
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return null;
  }
  const canonical = instant.toISOString();
  return canonical === value ? canonical : null;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum
    ? Number(value)
    : undefined;
}

/**
 * Allowlist-only telemetry parser. Unknown fields (image data, OCR, GPS, URLs,
 * tokens, or free-form errors) are intentionally discarded.
 */
export function parseReceiptUploadTelemetryEvent(value: unknown): ReceiptUploadClientMetric | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const receiptId = canonicalReceiptUploadId(candidate.receiptId);
  const occurredAt = canonicalReceiptUploadTimestamp(candidate.occurredAt);
  if (
    !isOneOf(RECEIPT_UPLOAD_EVENTS, candidate.event) ||
    receiptId === null ||
    occurredAt === null
  ) {
    return null;
  }

  const pageCount = boundedInteger(candidate.pageCount, 1, MAX_RECEIPT_PAGES);
  if (pageCount === undefined) {
    return null;
  }

  const event: ReceiptUploadClientMetric = {
    source: "mobile",
    event: candidate.event,
    receiptId,
    pageCount,
    occurredAt,
  };
  const durationMs = boundedInteger(candidate.durationMs, 0, 24 * 60 * 60 * 1000);
  const pageIndex = boundedInteger(candidate.pageIndex, 0, pageCount - 1);
  if (durationMs !== undefined) {
    event.durationMs = durationMs;
  }
  if (pageIndex !== undefined) {
    event.pageIndex = pageIndex;
  }
  if (isOneOf(RECEIPT_UPLOAD_RESULTS, candidate.result)) {
    event.result = candidate.result;
  }
  if (isOneOf(RECEIPT_UPLOAD_FAILURE_CATEGORIES, candidate.failureCategory)) {
    event.failureCategory = candidate.failureCategory;
  }
  return event;
}
