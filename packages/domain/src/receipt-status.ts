/**
 * Receipt lifecycle statuses (server).
 * A single "approved" flag is not enough — capture, AI, review, and export need distinct states.
 *
 * `rejected_unreadable` is a top-level status, not a synonym of `rejected`.
 * Photo-quality failures use it plus reason codes in `readability.ts`.
 * A person declining a receipt uses `rejected`. Worker UI: see `worker-status.ts`.
 */
export const RECEIPT_STATUSES = [
  "upload_pending",
  "submitted",
  "processing",
  "needs_review",
  "approved",
  "exporting",
  "exported",
  "partial_success",
  "rejected_unreadable",
  "rejected",
  "duplicate",
  "failed",
] as const;

export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Statuses where the receipt is not expected to keep moving without a new human/system action. */
export const TERMINAL_RECEIPT_STATUSES = [
  "exported",
  "partial_success",
  "rejected_unreadable",
  "rejected",
  "duplicate",
  "failed",
] as const satisfies readonly ReceiptStatus[];

export type TerminalReceiptStatus = (typeof TERMINAL_RECEIPT_STATUSES)[number];

export function isReceiptStatus(value: string): value is ReceiptStatus {
  return (RECEIPT_STATUSES as readonly string[]).includes(value);
}

export function isTerminalReceiptStatus(status: ReceiptStatus): status is TerminalReceiptStatus {
  return (TERMINAL_RECEIPT_STATUSES as readonly ReceiptStatus[]).includes(status);
}
