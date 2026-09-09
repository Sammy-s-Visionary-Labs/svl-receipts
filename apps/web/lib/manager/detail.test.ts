import { describe, expect, it } from "vitest";
import {
  buildFrozenSteps,
  buildSteps,
  extractionDraft,
  legacyReviewDraft,
  managerJob,
} from "./detail";

const intent = {
  id: "i",
  attachment_job_ids: ["job"],
  job_cost_lines: [{ job_id: "job", receipt_line_id: "line" }],
};
describe("manager detail normalization", () => {
  it("keeps two frozen pages on one job independent and targets retry by its exact attempt", () => {
    const steps = buildFrozenSteps(
      "current-intent",
      [
        {
          id: "page-step-0",
          housecall_job_id: "job",
          step: "attachment",
          receipt_page_id: "page-0",
          status: "succeeded",
          external_id: "external-page-0",
          payload: { image: { page_index: 0, storage_key: "private-page-0" } },
        },
        {
          id: "page-step-1",
          housecall_job_id: "job",
          step: "attachment",
          receipt_page_id: "page-1",
          status: "reconcile_required",
          payload: { image: { page_index: 1, storage_key: "private-page-1" } },
        },
      ],
      [
        { id: "attempt-1", export_step_id: "page-step-1", status: "retryable_failure" },
        {
          id: "old-success",
          export_step_id: "old-intent-page",
          status: "succeeded",
          external_id: "old-image",
        },
      ],
      [{ attempt_id: "attempt-1", status: "pending" }],
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      pageIndex: 0,
      status: "succeeded",
      externalId: "external-page-0",
      retryQueued: false,
    });
    expect(steps[1]).toMatchObject({
      id: "attempt-1",
      pageIndex: 1,
      status: "reconcile_required",
      externalId: null,
      retryQueued: true,
    });
    expect(JSON.stringify(steps)).not.toContain("private-page");
  });
  it("keeps expected attachment and cost pending without attempts", () =>
    expect(buildSteps(intent, [], [], []).map((s) => s.status)).toEqual(["pending", "pending"]));
  it("never loses a succeeded target to a later failed record", () =>
    expect(
      buildSteps(
        intent,
        [
          {
            id: "failed",
            housecall_job_id: "job",
            step: "attachment",
            status: "retryable_failure",
          },
          {
            id: "success",
            housecall_job_id: "job",
            step: "attachment",
            status: "succeeded",
            external_id: "external",
          },
        ],
        [],
        [],
      )[0],
    ).toMatchObject({ status: "succeeded", externalId: "external" }));
  it("treats an existing external link as succeeded", () =>
    expect(
      buildSteps(
        intent,
        [],
        [
          {
            housecall_job_id: "job",
            step: "job_cost",
            receipt_line_id: "line",
            external_id: "record",
          },
        ],
        [],
      )[1].status,
    ).toBe("succeeded"));
  it("shows retry queued only on the exact target", () =>
    expect(
      buildSteps(
        intent,
        [
          {
            id: "a",
            housecall_job_id: "job",
            step: "job_cost",
            receipt_line_id: "line",
            status: "retryable_failure",
          },
        ],
        [],
        [{ attempt_id: "a", status: "pending" }],
      ).map((s) => s.retryQueued),
    ).toEqual([false, true]));
  it("normalizes cents and source identity without including raw text", () => {
    const d = extractionDraft({
      id: "extraction",
      raw_text: "secret",
      vendor: "Vendor",
      lines: [{ description: "Wood", qty: 1.5, unit_cost_cents: 199 }],
    });
    expect(d.lines[0]).toMatchObject({
      qty: "1.5",
      unitCost: "1.99",
      sourceIndex: 0,
      id: "extraction:0",
    });
    expect(JSON.stringify(d)).not.toContain("secret");
  });
  it("preserves sparse extraction source indices when tax rows were filtered", () => {
    const draft = extractionDraft({
      id: "extraction",
      lines: [
        { source_index: 0, description: "Pipe" },
        { source_index: 2, description: "Connector" },
      ],
    });
    expect(draft.lines.map((line) => line.sourceIndex)).toEqual([0, 2]);
    expect(draft.lines[1].id).toBe("extraction:2");
  });
  it("does not invent missing job context", () =>
    expect(managerJob({ id: "job", label: "Same" })).toMatchObject({
      customer: null,
      number: null,
      status: null,
      technicians: [],
    }));
});

it("reopens legacy reviews with edited headers and posted job lines", () => {
  const original = extractionDraft({ vendor: "Original", lines: [] });
  const result = legacyReviewDraft(original, { vendor: "Corrected", invoice_number: "INV-2" }, [
    { id: "line", description: "Posted item", qty: 1.5, unit_cost_cents: 150, job_id: "job-final" },
  ]);
  expect(result).toMatchObject({
    vendor: "Corrected",
    invoiceNumber: "INV-2",
    lines: [{ description: "Posted item", qty: "1.5", unitCost: "1.50", jobId: "job-final" }],
  });
});
