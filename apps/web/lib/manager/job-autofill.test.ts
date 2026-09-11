import { type JobCatalogEntry, type ReviewDraft, rankJobCandidates } from "@svl/domain";
import { describe, expect, it } from "vitest";
import { autofillReceiptJobs } from "./job-autofill";
import type { ManagerJob } from "./review-contract";

const draft = (count = 1): ReviewDraft => ({
  vendor: "Supply",
  purchaseDate: "2026-07-10",
  invoiceNumber: "",
  ticketNumber: "",
  category: "Materials",
  referenceTotal: "80.00",
  managerNotes: "",
  lines: Array.from({ length: count }, (_, sourceIndex) => ({
    sourceIndex,
    description: "Material",
    qty: "2",
    uom: "yd3",
    unitCost: "40.00",
    jobId: "",
  })),
});
const catalog: JobCatalogEntry[] = [
  {
    id: "singh",
    customer: "Purshottam Singh",
    label: "Purshottam Singh #1990",
    number: "1990",
    active: true,
  },
  { id: "benner", customer: "Sue Benner", label: "Sue Benner #2040", number: "2040", active: true },
  {
    id: "sophia",
    customer: "Sophia Smith",
    label: "Sophia Smith #2050",
    number: "2050",
    active: true,
  },
];
const hints = (text: string) => ({ job_hints: [{ text }], confidence: { "job_hints.0": 0.95 } });
function suggestions(text: string, sourceIndex?: number, jobs = catalog): ManagerJob[] {
  return rankJobCandidates({ hints: [{ text, sourceIndex }], sourceIndex }, jobs).candidates.map(
    (candidate) => ({
      ...candidate,
      id: candidate.housecallJobId,
      customer: jobs.find((j) => j.id === candidate.housecallJobId)?.customer ?? null,
      number: null,
      status: null,
      scheduledAt: null,
      technicians: [],
      active: true,
      source: "housecall",
      stale: false,
      unavailable: false,
    }),
  );
}
describe("automatic job selection in a pristine manager draft", () => {
  it("does not break a shared-name tie using schedule, worker, vendor or GPS context", () => {
    const candidates = suggestions("Singh");
    candidates.push({ ...candidates[0], id: "another-singh-job", score: 100 });
    expect(autofillReceiptJobs(draft(), hints("Singh"), candidates).draft.lines[0].jobId).toBe("");
  });
  it.each(["Purshottam", "Singh", "Purshottam Singh", "PO 1990"])(
    "fills a unique name/reference %s using catalog IDs",
    (text) => {
      const original = draft();
      const result = autofillReceiptJobs(original, hints(text), suggestions(text));
      expect(result.draft.lines[0].jobId).toBe("singh");
      expect(result.assignments[0]).toMatchObject({ jobId: "singh", sourceText: text });
      expect(original.lines[0].jobId).toBe("");
    },
  );
  it.each(["Other Singh", "Purshottam Singh"])(
    "leaves shared names or multiple jobs for the same customer to review: %s",
    (customer) => {
      const jobs = [...catalog, { ...catalog[0], id: "other", customer, number: "1991" }];
      expect(
        autofillReceiptJobs(draft(), hints("Singh"), suggestions("Singh", undefined, jobs)).draft
          .lines[0].jobId,
      ).toBe("");
    },
  );
  it.each([
    { stale: true },
    { stale: undefined },
    { unavailable: true },
    { source: "demo" },
    { scoringVersion: "ra5-rules-v1:g100:k10:m8" },
    { reasons: [{ code: "schedule", message: "Nearby date" }] },
  ])("does not select stale, unavailable, legacy or context-only evidence %j", (change) => {
    const jobs = suggestions("Purshottam").map((job) => ({ ...job, ...change }));
    expect(autofillReceiptJobs(draft(), hints("Purshottam"), jobs).draft.lines[0].jobId).toBe("");
  });
  it("requires confident extraction and matching evidence instead of using a high unrelated score", () => {
    expect(
      autofillReceiptJobs(
        draft(),
        { ...hints("Purshottam"), confidence: { "job_hints.0": 0.6 } },
        suggestions("Purshottam"),
      ).draft.lines[0].jobId,
    ).toBe("");
    expect(
      autofillReceiptJobs(draft(), hints("Benner"), suggestions("Purshottam")).draft.lines[0].jobId,
    ).toBe("");
  });
  it("maps separate printed line names independently, and leaves Shop and unlabelled lines blank", () => {
    const text = ["Benner", "Sophia", "Shop", null];
    const extraction = {
      job_hints: [{ text: "Benner" }, { text: "Sophia" }, { text: "Shop" }],
      lines: text.map((job_hint, source_index) => ({ source_index, job_hint })),
      confidence: {
        "job_hints.0": 0.95,
        "job_hints.1": 0.95,
        "job_hints.2": 0.95,
        "lines.0.job_hint": 0.95,
        "lines.1.job_hint": 0.95,
        "lines.2.job_hint": 0.95,
      },
    };
    const candidates = [
      ...suggestions("Benner"),
      ...suggestions("Benner", 0),
      ...suggestions("Sophia", 1),
      ...suggestions("Benner", 3),
    ];
    const result = autofillReceiptJobs(draft(4), extraction, candidates);
    expect(result.draft.lines.map((line) => line.jobId)).toEqual(["benner", "sophia", "", ""]);
    expect(result.assignments[2].message).toContain("Shop or general materials");
    expect(result.assignments[3].message).toContain("unlabelled line");
  });
  it("does not spread a mixed receipt's names across every line even if one has a stronger score", () => {
    const extraction = {
      job_hints: [{ text: "PO 1990" }, { text: "Sophia" }],
      confidence: { "job_hints.0": 0.95, "job_hints.1": 0.95 },
    };
    expect(
      autofillReceiptJobs(draft(2), extraction, [
        ...suggestions("PO 1990"),
        ...suggestions("Sophia"),
      ]).draft.lines.map((line) => line.jobId),
    ).toEqual(["", ""]);
  });
  it.each(["Shop", "Stock", "Overhead", "General materials"])(
    "leaves %s for manager allocation even if a customer has that name",
    (text) => {
      const jobs = [{ ...catalog[0], customer: text }];
      expect(
        autofillReceiptJobs(draft(), hints(text), suggestions(text, undefined, jobs)).draft.lines[0]
          .jobId,
      ).toBe("");
    },
  );
  it("preserves manager selections and does not move a line hint onto another source index", () => {
    const saved = draft();
    saved.lines[0].jobId = "manager-choice";
    expect(
      autofillReceiptJobs(saved, hints("Purshottam"), suggestions("Purshottam")).draft.lines[0]
        .jobId,
    ).toBe("manager-choice");
    const extraction = {
      lines: [{ source_index: 0, job_hint: "Purshottam" }],
      confidence: { "lines.0.job_hint": 0.95 },
    };
    expect(
      autofillReceiptJobs(draft(), extraction, suggestions("Purshottam", 1)).draft.lines[0].jobId,
    ).toBe("");
  });
});
