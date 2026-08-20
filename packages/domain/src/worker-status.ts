import type { ReceiptStatus } from "./receipt-status";

/**
 * Device-queue states (RA-23 / RA-24). Local only until confirm succeeds.
 * Do not persist these on `receipts.status`.
 */
export const DEVICE_QUEUE_STATUSES = ["pending", "sending", "failed", "sent"] as const;

export type DeviceQueueStatus = (typeof DEVICE_QUEUE_STATUSES)[number];

/**
 * Worker-facing chips (RA-26). No "Needs clarification" (RA-68).
 */
export const WORKER_FACING_STATUSES = [
  "pending",
  "sending",
  "failed",
  "sent",
  "needs_retake",
  "in_review",
  "approved",
  "declined",
] as const;

export type WorkerFacingStatus = (typeof WORKER_FACING_STATUSES)[number];

export const WORKER_FACING_LABELS = {
  pending: "Pending",
  sending: "Sending",
  failed: "Failed",
  sent: "Sent",
  needs_retake: "Needs retake",
  in_review: "In review",
  approved: "Approved",
  declined: "Declined",
} as const satisfies Record<WorkerFacingStatus, string>;

/**
 * Sign-out vs local queue (RA-24 / RA-96).
 * Keep files; bind to owner; do not upload as another user.
 */
export const QUEUE_SIGN_OUT_POLICY = {
  deleteQueuedImages: false,
  warnWhenQueueNonEmpty: true,
  resumeOnlyForSameOwner: true,
} as const;

export function isDeviceQueueStatus(value: string): value is DeviceQueueStatus {
  return (DEVICE_QUEUE_STATUSES as readonly string[]).includes(value);
}

export function isWorkerFacingStatus(value: string): value is WorkerFacingStatus {
  return (WORKER_FACING_STATUSES as readonly string[]).includes(value);
}

/** Map local queue status before the receipt is server-confirmed. */
export function workerStatusFromDeviceQueue(status: DeviceQueueStatus): WorkerFacingStatus {
  return status;
}

/**
 * Map server lifecycle to worker chips after confirm.
 * Post-confirm `failed` is Declined-adjacent office failure, not queue Failed.
 */
export function workerStatusFromReceipt(status: ReceiptStatus): WorkerFacingStatus {
  switch (status) {
    case "upload_pending":
      return "pending";
    case "submitted":
    case "processing":
      return "sent";
    case "rejected_unreadable":
      return "needs_retake";
    case "needs_review":
      return "in_review";
    case "approved":
    case "exporting":
    case "exported":
    case "partial_success":
      return "approved";
    case "rejected":
    case "duplicate":
    case "failed":
      return "declined";
  }
}
