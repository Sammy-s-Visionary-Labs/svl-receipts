import {
  isReadabilityReason,
  isReceiptStatus,
  READABILITY_RETAKE_COPY,
  type ReadabilityReason,
  workerStatusFromReceipt,
} from "@svl/domain";

export const RECENT_RECEIPT_LIMIT = 25;

const CURSOR_VERSION = 1;
const RECEIPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RecentReceiptCursor = {
  submittedAt: string;
  id: string;
};

export type ReadabilityRow = {
  receipt_id: string;
  readable: boolean;
  failed_page_indexes: number[];
  reasons: string[];
  created_at: string;
};

export function encodeRecentReceiptCursor(cursor: RecentReceiptCursor): string {
  return Buffer.from(
    JSON.stringify({
      version: CURSOR_VERSION,
      submittedAt: new Date(cursor.submittedAt).toISOString(),
      id: cursor.id.toLowerCase(),
    }),
  ).toString("base64url");
}

export function decodeRecentReceiptCursor(value: string): RecentReceiptCursor | null {
  if (value.length === 0 || value.length > 512) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      parsed.version !== CURSOR_VERSION ||
      typeof parsed.submittedAt !== "string" ||
      Number.isNaN(Date.parse(parsed.submittedAt)) ||
      typeof parsed.id !== "string" ||
      !RECEIPT_ID_PATTERN.test(parsed.id)
    ) {
      return null;
    }
    return {
      submittedAt: new Date(parsed.submittedAt).toISOString(),
      id: parsed.id.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export function recentReceiptCursorFilter(cursor: RecentReceiptCursor): string {
  return `submitted_at.lt.${cursor.submittedAt},and(submitted_at.eq.${cursor.submittedAt},id.lt.${cursor.id})`;
}

export function workerStatusForStoredReceipt(status: string) {
  if (!isReceiptStatus(status)) {
    throw new Error("receipt_status_invalid");
  }
  return workerStatusFromReceipt(status);
}

export function normalizeReadability(check: ReadabilityRow | undefined | null) {
  if (!check) {
    return null;
  }
  const reasons = check.reasons.filter(isReadabilityReason);
  return {
    readable: check.readable,
    failedPageIndexes: check.failed_page_indexes.filter(
      (index) => Number.isInteger(index) && index >= 0,
    ),
    reasons: reasons.map((code: ReadabilityReason) => ({
      code,
      guidance: READABILITY_RETAKE_COPY[code],
    })),
    checkedAt: check.created_at,
  };
}
