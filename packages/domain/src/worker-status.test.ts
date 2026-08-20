import { describe, expect, it } from "vitest";
import { RECEIPT_STATUSES } from "./receipt-status";
import {
  QUEUE_SIGN_OUT_POLICY,
  workerStatusFromDeviceQueue,
  workerStatusFromReceipt,
  WORKER_FACING_LABELS,
} from "./worker-status";

describe("worker-facing status", () => {
  it("keeps device-queue names until Sent", () => {
    expect(workerStatusFromDeviceQueue("pending")).toBe("pending");
    expect(workerStatusFromDeviceQueue("sending")).toBe("sending");
    expect(workerStatusFromDeviceQueue("failed")).toBe("failed");
    expect(workerStatusFromDeviceQueue("sent")).toBe("sent");
  });

  it("maps every server status to a worker chip without Needs clarification", () => {
    const mapped = RECEIPT_STATUSES.map(workerStatusFromReceipt);
    expect(mapped).not.toContain(undefined);
    expect(WORKER_FACING_LABELS).not.toHaveProperty("needs_clarification");
    expect(workerStatusFromReceipt("submitted")).toBe("sent");
    expect(workerStatusFromReceipt("rejected_unreadable")).toBe("needs_retake");
    expect(workerStatusFromReceipt("rejected")).toBe("declined");
    expect(workerStatusFromReceipt("exported")).toBe("approved");
  });

  it("does not delete queued images on sign-out", () => {
    expect(QUEUE_SIGN_OUT_POLICY.deleteQueuedImages).toBe(false);
    expect(QUEUE_SIGN_OUT_POLICY.resumeOnlyForSameOwner).toBe(true);
  });
});
