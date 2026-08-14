import type { HousecallIntentV1 } from "./housecall";
import { HOUSECALL_PAYLOAD_VERSION } from "./housecall";
import type { ReceiptStatus } from "./receipt-status";
import type { ApproveLineAssignment } from "./review";

export const HOUSECALL_OUTBOX_STATUSES = ["pending", "dispatched", "cancelled"] as const;

export type HousecallOutboxStatus = (typeof HOUSECALL_OUTBOX_STATUSES)[number];

/** Statuses that may have a Housecall outbox row. Unapproved receipts cannot. */
export const HOUSECALL_OUTBOX_RECEIPT_STATUSES = [
  "approved",
  "exporting",
  "exported",
  "partial_success",
] as const satisfies readonly ReceiptStatus[];

export function canEnqueueHousecallOutbox(status: ReceiptStatus): boolean {
  return (HOUSECALL_OUTBOX_RECEIPT_STATUSES as readonly string[]).includes(status);
}

export function buildHousecallIntentFromApprove(input: {
  receiptId: string;
  lines: ApproveLineAssignment[];
}): HousecallIntentV1 {
  const attachment_job_ids = [...new Set(input.lines.map((line) => line.job_id))];
  return {
    payload_version: HOUSECALL_PAYLOAD_VERSION,
    receipt_id: input.receiptId,
    attachment_job_ids,
    job_cost_lines: input.lines.map((line) => ({
      job_id: line.job_id,
      description: line.description,
      qty: line.qty,
      unit_cost_cents: line.unit_cost_cents,
    })),
  };
}
