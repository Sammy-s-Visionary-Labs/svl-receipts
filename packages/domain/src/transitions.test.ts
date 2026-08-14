import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RECEIPT_STATUSES } from "./receipt-status";
import {
  evaluateHousecallStepAttempt,
  evaluateReceiptTransition,
  housecallStepHasSucceeded,
  RECEIPT_TRANSITIONS,
  TRANSITION_GUARD_CODES,
} from "./transitions";

const actor = {
  actorId: "user_1",
  occurredAt: new Date("2026-08-14T15:00:00.000Z"),
};

function receipt(from: string, to: string) {
  return evaluateReceiptTransition({ from, to, ...actor });
}

function attempt(
  existing: Parameters<typeof evaluateHousecallStepAttempt>[0]["existing"],
  nextStatus: string,
  extras?: { receiptLineId?: string | null; housecallJobId?: string },
) {
  return evaluateHousecallStepAttempt({
    existing,
    step: "job_cost",
    housecallJobId: extras?.housecallJobId ?? "job_a",
    receiptLineId: extras?.receiptLineId === undefined ? "line_1" : extras.receiptLineId,
    nextStatus,
    ...actor,
  });
}

describe("receipt transitions", () => {
  it("declares an edge list for every canonical status", () => {
    for (const status of RECEIPT_STATUSES) {
      expect(RECEIPT_TRANSITIONS[status]).toBeDefined();
    }
  });

  it("allows the happy path through review and export", () => {
    expect(receipt("upload_pending", "submitted").ok).toBe(true);
    expect(receipt("submitted", "processing").ok).toBe(true);
    expect(receipt("processing", "needs_review").ok).toBe(true);
    expect(receipt("needs_review", "approved").ok).toBe(true);
    expect(receipt("approved", "exporting").ok).toBe(true);
    expect(receipt("exporting", "exported").ok).toBe(true);
  });

  it("maps legacy from-values at the boundary and rejects them as targets", () => {
    expect(receipt("uploaded", "processing")).toEqual({
      ok: true,
      from: "submitted",
      to: "processing",
    });
    expect(receipt("parsed", "needs_review")).toEqual({
      ok: true,
      from: "processing",
      to: "needs_review",
    });
    expect(receipt("pending_review", "approved")).toEqual({
      ok: true,
      from: "needs_review",
      to: "approved",
    });
    expect(receipt("needs_review", "uploaded")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.invalid_status,
    });
  });

  it("rejects illegal jumps including skipped approve and leaving exported", () => {
    expect(receipt("exported", "upload_pending")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.illegal_transition,
    });
    expect(receipt("needs_review", "exported")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.illegal_transition,
    });
    expect(receipt("approved", "exported")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.illegal_transition,
    });
    expect(receipt("submitted", "needs_review")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.illegal_transition,
    });
  });

  it("requires actor id and a valid timestamp", () => {
    expect(
      evaluateReceiptTransition({
        from: "upload_pending",
        to: "submitted",
        actorId: "",
        occurredAt: actor.occurredAt,
      }),
    ).toEqual({ ok: false, code: TRANSITION_GUARD_CODES.missing_actor });
    expect(
      evaluateReceiptTransition({
        from: "upload_pending",
        to: "submitted",
        actorId: "user_1",
        occurredAt: new Date("not-a-date"),
      }),
    ).toEqual({ ok: false, code: TRANSITION_GUARD_CODES.missing_timestamp });
  });

  it("allows an explicit retry from partial_success without treating it as a free jump to exported from review", () => {
    expect(receipt("exporting", "partial_success").ok).toBe(true);
    expect(receipt("partial_success", "exporting").ok).toBe(true);
    expect(receipt("partial_success", "exported").ok).toBe(true);
    expect(receipt("partial_success", "failed").ok).toBe(true);
    expect(receipt("partial_success", "needs_review").ok).toBe(false);
  });
});

describe("Housecall step attempts", () => {
  const succeededCost = {
    step: "job_cost" as const,
    housecallJobId: "job_a",
    receiptLineId: "line_1",
    status: "succeeded" as const,
  };

  it("rejects repeating a succeeded step, including during partial_success retries", () => {
    expect(housecallStepHasSucceeded([succeededCost], "job_cost", "job_a", "line_1")).toBe(true);
    expect(attempt([succeededCost], "in_progress")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.step_already_succeeded,
    });
    expect(
      attempt([succeededCost], "succeeded", { housecallJobId: "job_b", receiptLineId: "line_2" })
        .ok,
    ).toBe(true);
    expect(
      evaluateHousecallStepAttempt({
        existing: [succeededCost],
        step: "attachment",
        housecallJobId: "job_a",
        receiptLineId: null,
        nextStatus: "succeeded",
        ...actor,
      }).ok,
    ).toBe(true);
  });

  it("allows retry after retryable_failure and forbids jumps from succeeded/permanent_failure", () => {
    const failed = { ...succeededCost, status: "retryable_failure" as const };
    expect(attempt([failed], "in_progress").ok).toBe(true);
    expect(attempt([failed], "succeeded").ok).toBe(true);

    const permanent = { ...succeededCost, status: "permanent_failure" as const };
    expect(attempt([permanent], "in_progress")).toEqual({
      ok: false,
      code: TRANSITION_GUARD_CODES.illegal_transition,
    });
  });

  it("requires actor id and timestamp on every attempt", () => {
    expect(
      evaluateHousecallStepAttempt({
        existing: [],
        step: "attachment",
        housecallJobId: "job_a",
        receiptLineId: null,
        nextStatus: "succeeded",
        actorId: " ",
        occurredAt: actor.occurredAt,
      }),
    ).toEqual({ ok: false, code: TRANSITION_GUARD_CODES.missing_actor });
  });
});

describe("RA-84 succeeded-step unique indexes", () => {
  const sql = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../supabase/migrations/20260814160000_transition_guards.sql",
    ),
    "utf8",
  );

  it("prevents a second succeeded attempt for the same attachment or job-cost target", () => {
    expect(sql).toContain("create unique index export_attempts_succeeded_attachment_uidx");
    expect(sql).toContain("create unique index export_attempts_succeeded_job_cost_uidx");
    expect(sql).toContain("where status = 'succeeded' and step = 'attachment'");
    expect(sql).toContain("where status = 'succeeded' and step = 'job_cost'");
  });
});
