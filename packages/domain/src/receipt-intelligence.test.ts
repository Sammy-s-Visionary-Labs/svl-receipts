import { describe, expect, it } from "vitest";
import {
  type DuplicateReceipt,
  type JobCatalogEntry,
  rankJobCandidates,
  sanitizeFeedbackRecords,
  scoreDuplicateReceipts,
  suggestReceiptCategory,
} from "./receipt-intelligence";

const receipt: DuplicateReceipt = {
  id: "a",
  accessScope: "company",
  pageHashes: ["hash1"],
  vendor: "Home Depot",
  purchaseDate: "2026-09-08",
  totalCents: 12000,
  invoiceNumber: "1234",
};
const job: JobCatalogEntry = {
  id: "ra5-test-job-sullivan",
  label: "Sullivan",
  customer: "Sullivan",
  number: "TEST-1042",
  active: true,
};
describe("duplicate evidence", () => {
  it("matches full-image hash even when extraction differs, but never another access scope or deleted content", () => {
    const same = { ...receipt, id: "b", vendor: "different" };
    expect(
      scoreDuplicateReceipts(receipt, [
        same,
        { ...same, id: "c", deleted: true },
        { ...same, id: "d", purging: true },
        { ...same, id: "e", accessScope: "other" },
      ]),
    ).toMatchObject([{ receiptId: "b", score: 100 }]);
  });
  it("requires the whole multipage document for exact matching", () => {
    expect(
      scoreDuplicateReceipts(
        {
          ...receipt,
          pageHashes: ["hash1", "hash2"],
          vendor: null,
          purchaseDate: null,
          totalCents: null,
          invoiceNumber: null,
        },
        [{ ...receipt, id: "b" }],
      ),
    ).toEqual([]);
  });
  it("finds different photographs by ticket and makes separate transactions negative", () => {
    expect(
      scoreDuplicateReceipts(receipt, [
        { ...receipt, id: "b", pageHashes: ["photo2"] },
      ])[0]?.reasons.some((r) => r.code === "document_identifier"),
    ).toBe(true);
    expect(
      scoreDuplicateReceipts(receipt, [
        { ...receipt, id: "b", invoiceNumber: "5678", pageHashes: ["photo2"] },
      ]),
    ).toEqual([]);
  });
  it("allows configured near-duplicate thresholds and rejects malformed settings", () => {
    const sparse = { ...receipt, invoiceNumber: null };
    expect(
      scoreDuplicateReceipts(sparse, [{ ...sparse, id: "b", pageHashes: ["photo2"] }], {
        threshold: 45,
      }),
    ).toHaveLength(1);
    expect(() => scoreDuplicateReceipts(receipt, [], { threshold: NaN })).toThrow();
  });
});
describe("local job ranking", () => {
  it("puts exact handwritten/printed references above names and soft history and returns only catalog IDs", () => {
    const result = rankJobCandidates(
      {
        hints: [{ text: "PO TEST-1042" }, { text: "Sullivan" }],
        uploaderId: "worker",
        vendor: "Select",
        uploaderJobIds: ["other"],
        purchaseDate: "2026-09-08",
      },
      [
        job,
        {
          ...job,
          id: "other",
          number: "2048",
          scheduledAt: "2026-09-08",
          assignedWorkerIds: ["worker"],
          vendorHistory: ["Select"],
        },
      ],
    );
    expect(result.topCandidate?.housecallJobId).toBe(job.id);
    expect(result.topCandidate?.reasons[0]?.evidence).toEqual(["PO TEST-1042"]);
    expect(rankJobCandidates({ hints: [{ text: "made-up-job" }] }, []).candidates).toEqual([]);
  });
  it("matches compact and punctuated references at token boundaries", () => {
    expect(
      rankJobCandidates({ hints: [{ text: "PO TEST1042" }] }, [job]).topCandidate?.housecallJobId,
    ).toBe(job.id);
    expect(
      rankJobCandidates({ hints: [{ text: "PO TEST-10420" }] }, [job]).topCandidate,
    ).toBeNull();
  });
  it("does not promote a numeric substring or accumulate repeated hints", () => {
    expect(rankJobCandidates({ hints: [{ text: "TEST-10420" }] }, [job]).topCandidate).toBeNull();
    const once = rankJobCandidates({ hints: [{ text: "TEST-1042" }] }, [job]);
    expect(
      rankJobCandidates({ hints: Array(200).fill({ text: "TEST-1042" }) }, [job]).topCandidate
        ?.score,
    ).toBe(once.topCandidate?.score);
  });
  it("keeps line hints attached to their source and limits results to five deterministically", () => {
    const catalog = [...Array(9)].map((_, i) => ({ ...job, id: String(i) }));
    expect(
      rankJobCandidates({ hints: [{ text: "TEST-1042", sourceIndex: 0 }], sourceIndex: 1 }, catalog)
        .candidates,
    ).toEqual([]);
    expect(
      rankJobCandidates(
        { hints: [{ text: "TEST-1042", sourceIndex: 0 }], sourceIndex: 0 },
        catalog,
      ).candidates.map((j) => j.housecallJobId),
    ).toEqual(["0", "1", "2", "3", "4"]);
  });
  it("prioritizes a line-specific job reference when the receipt also names another job", () => {
    const result = rankJobCandidates(
      {
        sourceIndex: 1,
        hints: [{ text: "TEST-1042" }, { text: "Sullivan" }, { text: "TEST-2048", sourceIndex: 1 }],
      },
      [job, { ...job, id: "ra5-test-job-oak", number: "TEST-2048", customer: "Oak" }],
    );
    expect(result.topCandidate?.housecallJobId).toBe("ra5-test-job-oak");
  });
  it("does not let a receipt-wide PO override a different customer's name on a material line", () => {
    const result = rankJobCandidates(
      {
        sourceIndex: 1,
        hints: [{ text: "TEST-1042" }, { text: "Sullivan" }, { text: "Sophia", sourceIndex: 1 }],
      },
      [job, { ...job, id: "sophia", number: "TEST-2048", customer: "Sophia Smith" }],
    );
    expect(result.topCandidate?.housecallJobId).toBe("sophia");
    expect(result.topCandidate?.reasons).toContainEqual(
      expect.objectContaining({ code: "similar_customer", evidence: ["Sophia"] }),
    );
    expect(result.candidates.some((candidate) => candidate.housecallJobId === job.id)).toBe(false);
  });
  it("ignores missing/inaccurate GPS and invalid/missing service addresses", () => {
    const base = { hints: [{ text: "Sullivan" }] };
    const located = { ...job, serviceAddress: "123 Test Street", lat: 41, lng: -83 };
    const gps = { lat: 41, lng: -83, accuracyMeters: 25 };
    const score = rankJobCandidates(base, [located]).topCandidate?.score ?? 0;
    expect(rankJobCandidates({ ...base, gps }, [located]).topCandidate?.score).toBe(score + 5);
    for (const bad of [
      { ...gps, accuracyMeters: 200 },
      { ...gps, lat: NaN },
      { ...gps, accuracyMeters: -1 },
    ])
      expect(rankJobCandidates({ ...base, gps: bad }, [located]).topCandidate?.score).toBe(score);
    expect(
      rankJobCandidates({ ...base, gps }, [{ ...located, serviceAddress: null }]).topCandidate
        ?.score,
    ).toBe(score);
  });
});
describe("category rules and sanitized feedback", () => {
  const cats = [
    { id: "materials", label: "Materials", active: true, keywords: ["pipe", "gravel"], version: 1 },
    { id: "dump", label: "Disposal", active: true, keywords: ["disposal"], version: 1 },
  ];
  it("suggests only configured active categories and sends ambiguous or unknown values to review", () => {
    expect(suggestReceiptCategory("PVC pipe", cats).categoryId).toBe("materials");
    expect(
      suggestReceiptCategory(
        "PVC pipe",
        cats.map((category) => ({ ...category, active: false })),
      ).categoryId,
    ).toBeNull();
    expect(suggestReceiptCategory("pipe disposal", cats).categoryId).toBeNull();
    expect(suggestReceiptCategory("", cats, "fake").categoryId).toBeNull();
    expect(suggestReceiptCategory("pipe", []).categoryId).toBeNull();
  });
  it("excludes arbitrary fields and text/identities while preserving numeric evaluation pairs", () => {
    const base = {
      receipt_id: "real-receipt",
      actor_id: "private-actor",
      accepted: false,
      model: "gemini-test",
      scoring_version: "ra5-rules-v1",
    };
    const exported = sanitizeFeedbackRecords(
      [
        {
          ...base,
          field_path: "vendor",
          suggested_value: "private vendor",
          final_value: "secret api key",
        },
        { ...base, field_path: "lines.0.unitCost", suggested_value: "20.00", final_value: "24.70" },
        { ...base, field_path: "managerNotes", suggested_value: "secret", final_value: "private" },
        {
          ...base,
          field_path: "lines.0.description",
          suggested_value: { raw: "secret" },
          final_value: "name",
        },
      ],
      () => "opaque-token",
    );
    expect(exported).toHaveLength(3);
    expect(exported[1]).toMatchObject({ suggested: "20.00", final: "24.70" });
    expect(JSON.stringify(exported)).not.toMatch(/private|secret|real-receipt|managerNotes/);
    expect(exported[2]?.suggested).toBe("[redacted]");
  });
});
