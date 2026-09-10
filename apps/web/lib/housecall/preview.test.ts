import { describe, expect, it } from "vitest";
import { buildHousecallExportPreview, type PreviewStepRow } from "./preview";

const attachment = (id: string, job: string, page: number, status = "ready"): PreviewStepRow => ({
  id,
  housecall_job_id: job,
  step: "attachment",
  status,
  external_id: null,
  payload: {
    image: { page_index: page, storage_key: "private/image.jpg", checksum: "private-checksum" },
  },
});
const material = (job: string): PreviewStepRow => ({
  id: `material-${job}`,
  housecall_job_id: job,
  step: "job_cost",
  status: "ready",
  external_id: null,
  payload: {
    line: {
      description: "Synthetic material",
      qty: 1.005,
      unit_cost_cents: 100,
      extended_cost_cents: 101,
      uom: "ton",
      raw_text: "private OCR",
    },
  },
});
const input = () => ({
  receiptId: "receipt",
  intent: { id: "intent", payload_hash: "a".repeat(64), attachment_job_ids: ["job-a", "job-b"] },
  steps: [
    attachment("a1", "job-a", 0, "succeeded"),
    attachment("a2", "job-a", 1, "reconcile_required"),
    material("job-a"),
    attachment("b1", "job-b", 0),
    attachment("b2", "job-b", 1),
    material("job-b"),
  ],
  catalog: [
    { id: "job-a", label: "Same test name" },
    { id: "job-b", label: "Same test name" },
  ],
  allowedJobIds: new Set(["job-a"]),
  liveWritesEnabled: false,
});
describe("frozen Housecall export preview", () => {
  it("keeps distinct job IDs and page states, exact half-up costs, and the write restriction", () => {
    const preview = buildHousecallExportPreview(input());
    expect(preview).toMatchObject({
      previewOnly: true,
      separateApprovalRequired: true,
      taxExcluded: true,
      totalMaterialCostCents: 202,
      blockedReasons: [
        "live_writes_disabled",
        "destination_not_approved",
        "unsupported_quantity_precision",
      ],
    });
    expect(preview.jobs.map((job) => job.id)).toEqual(["job-a", "job-b"]);
    expect(preview.jobs[0].images.map((image) => image.status)).toEqual([
      "succeeded",
      "reconcile_required",
    ]);
    expect(preview.jobs[0].materialCostCents).toBe(101);
    expect(preview.jobs[1].destinationAllowed).toBe(false);
    expect(JSON.stringify(preview)).not.toMatch(/storage_key|checksum|raw_text|private/);
  });
  it("marks missing legacy plans and never derives draft values", () => {
    expect(
      buildHousecallExportPreview({ ...input(), intent: null, steps: [] }).blockedReasons,
    ).toEqual(["no_current_intent"]);
    expect(
      buildHousecallExportPreview({
        ...input(),
        intent: { ...input().intent, payload_hash: null },
        steps: [],
      }).blockedReasons,
    ).toContain("missing_frozen_plan");
  });
  it("rejects mismatched arithmetic and steps on an unexpected destination", () => {
    const altered = input();
    altered.steps[2] = {
      ...material("job-a"),
      payload: {
        line: {
          description: "Synthetic",
          qty: 1.005,
          unit_cost_cents: 100,
          extended_cost_cents: 100,
        },
      },
    };
    expect(() => buildHousecallExportPreview(altered)).toThrow();
    expect(() =>
      buildHousecallExportPreview({ ...input(), steps: [material("other-job")] }),
    ).toThrow();
  });
});
