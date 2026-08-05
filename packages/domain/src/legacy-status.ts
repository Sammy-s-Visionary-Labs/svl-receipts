import type { ReceiptStatus } from "./receipt-status";
import { isReceiptStatus } from "./receipt-status";

/**
 * Early ticket / docs sometimes used different names.
 * Map them onto the canonical ReceiptStatus vocabulary.
 */
export const LEGACY_RECEIPT_STATUS_MAP = {
  uploaded: "submitted",
  parsed: "processing",
  pending_review: "needs_review",
} as const satisfies Record<string, ReceiptStatus>;

export type LegacyReceiptStatusName = keyof typeof LEGACY_RECEIPT_STATUS_MAP;

/**
 * Accepts a canonical status or a known legacy alias.
 * Returns null when the value is neither (backward-compatible: unknown ≠ pretend v1).
 */
export function resolveReceiptStatus(value: string): ReceiptStatus | null {
  if (isReceiptStatus(value)) {
    return value;
  }

  if (value in LEGACY_RECEIPT_STATUS_MAP) {
    return LEGACY_RECEIPT_STATUS_MAP[value as LegacyReceiptStatusName];
  }

  return null;
}
