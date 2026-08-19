import { describe, expect, it } from "vitest";
import { redactAuditPayload } from "./audit";
import { isCurrentIntentExportComplete } from "./housecall";
import { buildHousecallIntentFromApprove, canEnqueueHousecallOutbox } from "./outbox";
import {
  BACKUP_EXPIRATION_NOTE,
  computeDeleteAfterAt,
  isEligibleForContentDeletion,
  RETENTION_DAYS,
  RETENTION_START_EVENT,
  shouldStartRetention,
} from "./retention";
import {
  isDeferablePurgeReason,
  isHandledWorkKind,
  isWorkClaimable,
  nextAttemptAt,
  persistableWorkReason,
  retryDelayMinutes,
  scheduleWorkFailure,
  WORK_HANDLED_KINDS,
  WORK_MAX_ATTEMPTS,
} from "./work";

describe("audit redaction", () => {
  it("strips secrets, images, and OCR text from nested payloads", () => {
    const redacted = redactAuditPayload({
      status: "submitted",
      raw_text: "full ocr dump",
      nested: { api_key: "sk-live", vendor: "Select" },
      bytes: [1, 2, 3],
    });
    expect(redacted).toEqual({
      status: "submitted",
      raw_text: "[redacted]",
      nested: { api_key: "[redacted]", vendor: "Select" },
      bytes: "[redacted]",
    });
  });
});

describe("work leases and retries", () => {
  const now = new Date("2026-08-14T12:00:00.000Z");

  it("lets queued work and expired leases be claimed, but not active leases", () => {
    expect(
      isWorkClaimable({ status: "queued", nextAttemptAt: now, leaseExpiresAt: null }, now),
    ).toBe(true);
    expect(
      isWorkClaimable(
        {
          status: "leased",
          nextAttemptAt: now,
          leaseExpiresAt: new Date("2026-08-14T11:59:00.000Z"),
        },
        now,
      ),
    ).toBe(true);
    expect(
      isWorkClaimable(
        {
          status: "leased",
          nextAttemptAt: now,
          leaseExpiresAt: new Date("2026-08-14T12:05:00.000Z"),
        },
        now,
      ),
    ).toBe(false);
    expect(
      isWorkClaimable(
        {
          status: "queued",
          nextAttemptAt: new Date("2026-08-14T13:00:00.000Z"),
          leaseExpiresAt: null,
        },
        now,
      ),
    ).toBe(false);
  });

  it("backs off exponentially and dead-letters after max attempts", () => {
    expect(retryDelayMinutes(1)).toBe(1);
    expect(retryDelayMinutes(2)).toBe(2);
    expect(retryDelayMinutes(3)).toBe(4);
    expect(
      scheduleWorkFailure({ attemptCount: 1, retryable: true, reason: "timeout", now }),
    ).toEqual({
      status: "queued",
      nextAttemptAt: nextAttemptAt(1, now),
      terminalReason: null,
    });
    expect(
      scheduleWorkFailure({
        attemptCount: WORK_MAX_ATTEMPTS,
        retryable: true,
        reason: "timeout",
        now,
      }),
    ).toEqual({
      status: "dead_letter",
      nextAttemptAt: now,
      terminalReason: "timeout",
    });
    expect(
      scheduleWorkFailure({ attemptCount: 1, retryable: false, reason: "permanent", now }).status,
    ).toBe("dead_letter");
  });

  it("treats only purge as a handled work kind until extract/export providers exist", () => {
    expect(WORK_HANDLED_KINDS).toEqual(["purge"]);
    expect(isHandledWorkKind("purge")).toBe(true);
    expect(isHandledWorkKind("extract")).toBe(false);
    expect(isHandledWorkKind("export")).toBe(false);
  });

  it("persists allowlisted work codes and drops secret-bearing provider messages", () => {
    expect(persistableWorkReason("retention_hold")).toBe("retention_hold");
    expect(persistableWorkReason("purge_not_eligible")).toBe("purge_not_eligible");
    expect(persistableWorkReason("Authorization: Bearer TOPSECRET")).toBe("worker_failure");
    expect(persistableWorkReason(new Error("permission denied for function"))).toBe(
      "worker_failure",
    );
    expect(isDeferablePurgeReason({ message: "retention_hold" })).toBe(true);
    expect(isDeferablePurgeReason({ message: "conflict" })).toBe(false);
  });
});

describe("housecall outbox", () => {
  it("rejects unapproved receipts and builds an intent snapshot from approve lines", () => {
    expect(canEnqueueHousecallOutbox("needs_review")).toBe(false);
    expect(canEnqueueHousecallOutbox("approved")).toBe(true);
    expect(
      buildHousecallIntentFromApprove({
        receiptId: "rcp_1",
        lines: [
          {
            description: "pipe",
            qty: 2,
            unit_cost_cents: 500,
            job_id: "job_a",
          },
          {
            description: "fitting",
            qty: 1,
            unit_cost_cents: 100,
            job_id: "job_a",
          },
        ],
      }),
    ).toEqual({
      payload_version: 1,
      receipt_id: "rcp_1",
      attachment_job_ids: ["job_a"],
      job_cost_lines: [
        { job_id: "job_a", description: "pipe", qty: 2, unit_cost_cents: 500 },
        { job_id: "job_a", description: "fitting", qty: 1, unit_cost_cents: 100 },
      ],
    });
  });
});

describe("retention policy v1", () => {
  const start = new Date("2025-01-01T00:00:00.000Z");
  const deleteAfter = computeDeleteAfterAt(start);

  it("starts the clock after a complete current-intent export or a decline, not on submit, and uses 365 days", () => {
    expect(RETENTION_START_EVENT).toBe("housecall_export_succeeded_or_declined");
    expect(RETENTION_DAYS).toBe(365);
    expect(deleteAfter.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(
      shouldStartRetention({
        status: "submitted",
        exportComplete: false,
        retentionStartedAt: null,
      }),
    ).toBe(false);
    expect(
      shouldStartRetention({
        status: "approved",
        exportComplete: false,
        retentionStartedAt: null,
      }),
    ).toBe(false);
    expect(
      shouldStartRetention({
        status: "exported",
        exportComplete: true,
        retentionStartedAt: null,
      }),
    ).toBe(true);
    expect(
      shouldStartRetention({
        status: "rejected",
        exportComplete: false,
        retentionStartedAt: null,
      }),
    ).toBe(true);
    expect(
      shouldStartRetention({
        status: "duplicate",
        exportComplete: false,
        retentionStartedAt: null,
      }),
    ).toBe(true);
    expect(
      shouldStartRetention({
        status: "failed",
        exportComplete: false,
        retentionStartedAt: null,
      }),
    ).toBe(false);
    expect(
      shouldStartRetention({
        status: "exported",
        exportComplete: true,
        retentionStartedAt: start,
      }),
    ).toBe(false);
  });

  it("is not due at 364 days, and is due at 365 and 366 days", () => {
    const base = {
      retentionStartedAt: start,
      deleteAfterAt: deleteAfter,
      retentionHold: false,
      contentDeletedAt: null,
    };
    expect(
      isEligibleForContentDeletion({
        ...base,
        now: new Date("2025-12-31T23:59:59.000Z"),
      }),
    ).toBe(false);
    expect(isEligibleForContentDeletion({ ...base, now: deleteAfter })).toBe(true);
    expect(
      isEligibleForContentDeletion({
        ...base,
        now: new Date("2026-01-02T00:00:00.000Z"),
      }),
    ).toBe(true);
  });

  it("keeps held and never-started receipts, and skips already-purged rows", () => {
    const now = new Date("2026-02-01T00:00:00.000Z");
    expect(
      isEligibleForContentDeletion({
        retentionStartedAt: start,
        deleteAfterAt: deleteAfter,
        retentionHold: true,
        contentDeletedAt: null,
        now,
      }),
    ).toBe(false);
    expect(
      isEligibleForContentDeletion({
        retentionStartedAt: null,
        deleteAfterAt: null,
        retentionHold: false,
        contentDeletedAt: null,
        now,
      }),
    ).toBe(false);
    expect(
      isEligibleForContentDeletion({
        retentionStartedAt: start,
        deleteAfterAt: deleteAfter,
        retentionHold: false,
        contentDeletedAt: now,
        now,
      }),
    ).toBe(false);
  });

  it("documents backup expiration as a release risk", () => {
    expect(BACKUP_EXPIRATION_NOTE).toMatch(/PITR/i);
    expect(BACKUP_EXPIRATION_NOTE).toMatch(/backup/i);
  });
});

describe("current-intent export completeness", () => {
  const attempts = [
    {
      intentId: "intent_2",
      step: "attachment",
      housecallJobId: "job_a",
      receiptLineId: null,
    },
    {
      intentId: "intent_2",
      step: "job_cost",
      housecallJobId: "job_a",
      receiptLineId: "line_1",
    },
  ];

  it("requires every attachment job and every job-cost line on the current intent", () => {
    expect(
      isCurrentIntentExportComplete({
        intentId: "intent_2",
        attachmentJobIds: ["job_a", "job_b"],
        jobCostLines: [
          { job_id: "job_a", receipt_line_id: "line_1" },
          { job_id: "job_b", receipt_line_id: "line_2" },
        ],
        succeededAttempts: attempts,
      }),
    ).toBe(false);
    expect(
      isCurrentIntentExportComplete({
        intentId: "intent_2",
        attachmentJobIds: ["job_a"],
        jobCostLines: [{ job_id: "job_a", receipt_line_id: "line_1" }],
        succeededAttempts: attempts,
      }),
    ).toBe(true);
  });

  it("ignores succeeded attempts from a previous intent", () => {
    expect(
      isCurrentIntentExportComplete({
        intentId: "intent_2",
        attachmentJobIds: ["job_a"],
        jobCostLines: [{ job_id: "job_a", receipt_line_id: "line_1" }],
        succeededAttempts: [
          {
            intentId: "intent_1",
            step: "attachment",
            housecallJobId: "job_a",
            receiptLineId: null,
          },
          {
            intentId: "intent_1",
            step: "job_cost",
            housecallJobId: "job_a",
            receiptLineId: "line_1",
          },
        ],
      }),
    ).toBe(false);
  });
});
