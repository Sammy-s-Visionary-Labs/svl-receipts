import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
const id = "44100000-0000-4000-8000-000000000001";
let rows: Record<string, unknown>;
let rpc: ReturnType<typeof vi.fn>;
let from: ReturnType<typeof vi.fn>;
const run = () =>
  GET(new Request(`http://localhost/api/manager/receipts/${id}`), {
    params: Promise.resolve({ id }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    receipts: {
      id,
      status: "needs_review",
      review_version: 0,
      submitted_at: "2026-09-07T12:00:00Z",
      gps_lat: null,
      gps_lng: null,
    },
    extractions: [{ id: "e", vendor: "Original", lines: [], confidence: {}, raw_text: "private" }],
    reviews: [],
    job_candidates: [],
    receipt_pages: [{ page_index: 0 }],
    housecall_outbox: null,
    manager_recovery_commands: [],
    receipt_lines: [],
  };
  from = vi.fn((table: string) => {
    const result = () => ({ data: rows[table], error: null });
    const chain: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are intentionally awaitable.
      then: (resolve: (value: unknown) => void) => resolve(result()),
    };
    for (const method of ["select", "eq", "not", "order", "limit", "in"])
      chain[method] = vi.fn(() => chain);
    for (const method of ["maybeSingle", "single"]) chain[method] = vi.fn(async () => result());
    return chain;
  });
  rpc = vi.fn(async (name) => ({
    data: name === "manager_legacy_review_edits" ? {} : [],
    error: null,
  }));
  vi.mocked(requireManager).mockResolvedValue({
    actor: { role: "manager", userId: "actor" },
    supabase: { from, rpc },
  } as never);
});
describe("manager receipt detail API", () => {
  it("uses authenticated reads and excludes storage/provider payloads", async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = await res.json();
    expect(body).toMatchObject({ id, editable: true, version: 0, draft: { vendor: "Original" } });
    expect(JSON.stringify(body)).not.toMatch(/raw_text|private|storage_key/);
  });
  it("keeps a full snapshot authoritative over extraction", async () => {
    rows.reviews = [{ snapshot: { vendor: "Edited", lines: [] }, version: 2 }];
    rows.receipts = { ...(rows.receipts as object), review_version: 2 };
    const body = await (await run()).json();
    expect(body.draft.vendor).toBe("Edited");
    expect(body.original.vendor).toBe("Original");
    expect(rpc).not.toHaveBeenCalledWith("manager_legacy_review_edits", expect.anything());
  });
  it("reopens historical lines and earlier sparse edits", async () => {
    rows.receipts = { ...(rows.receipts as object), status: "exported" };
    rows.receipt_lines = [
      {
        id: "line",
        description: "Actual posted material",
        qty: 2,
        unit_cost_cents: 125,
        job_id: "final-job",
      },
    ];
    rpc.mockImplementation(async (name) => ({
      data: name === "manager_legacy_review_edits" ? { vendor: "Legacy edit" } : [],
      error: null,
    }));
    const body = await (await run()).json();
    expect(body.editable).toBe(false);
    expect(body.draft).toMatchObject({
      vendor: "Legacy edit",
      lines: [{ jobId: "final-job", unitCost: "1.25" }],
    });
  });
  it.each(["content_deleted_at", "purge_claimed_at"])(
    "does not disclose fenced content %s",
    async (field) => {
      rows.receipts = { ...(rows.receipts as object), [field]: "2026-09-07" };
      expect((await run()).status).toBe(404);
      expect(from).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects oversized extraction instead of silently dropping lines", async () => {
    rows.extractions = [
      { id: "e", lines: Array.from({ length: 101 }, () => ({ description: "line" })) },
    ];
    expect((await run()).status).toBe(422);
  });
  it("preserves incomplete RA5 lines instead of replacing them with the valid material projection", async () => {
    rows.extractions = [
      {
        id: "e",
        work_item_id: "work",
        vendor: "Supply",
        lines: [
          { description: "Needs a cost", qty: 2, unit_cost_cents: null },
          { description: "Complete", qty: 1, unit_cost_cents: 100 },
        ],
        confidence: {},
      },
    ];
    rows.receipt_lines = [
      { id: "projected", description: "Complete", qty: 1, unit_cost_cents: 100 },
    ];
    const body = await (await run()).json();
    expect(body.draft.lines).toHaveLength(2);
    expect(body.draft.lines[0]).toMatchObject({ description: "Needs a cost", unitCost: "" });
  });
  it("keeps old line evidence across a reordered reextraction without applying new line suggestions to old lines", async () => {
    const oldId = "44900000-0000-4000-8000-000000000001";
    const newId = "44900000-0000-4000-8000-000000000002";
    rows.extractions = [
      {
        id: newId,
        work_item_id: "work",
        lines: [{ source_index: 0, description: "New first line" }],
      },
      { id: oldId, lines: [{ source_index: 0, description: "Old first line" }] },
    ];
    rows.reviews = [
      {
        extraction_id: oldId,
        snapshot: {
          vendor: "Saved",
          lines: [
            {
              id: `${oldId}:0`,
              sourceIndex: 0,
              suggestionId: "old-suggestion",
              description: "My saved material",
            },
          ],
        },
      },
    ];
    const body = await (await run()).json();
    expect(body.reprocessed).toBe(true);
    expect(body.draft.lines[0]).toEqual({ id: `${oldId}:0`, description: "My saved material" });
    expect(body.lineEvidence[`${oldId}:0`].description).toBe("Old first line");
  });
  it("does not surface stale unversioned or prior-generation suggestions on a new extraction", async () => {
    rows.extractions = [{ id: "current", work_item_id: "work", lines: [] }];
    rows.job_candidates = [
      { id: "legacy", housecall_job_id: "old" },
      { id: "stale", extraction_id: "previous", housecall_job_id: "prior" },
      { id: "new", extraction_id: "current", housecall_job_id: "current-job", score: 1002 },
    ];
    const body = await (await run()).json();
    expect(body.suggestions.map((job: { id: string }) => job.id)).toEqual(["current-job"]);
  });
  it("requires authorization before reading receipt contents", async () => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(403, "forbidden", "Denied"));
    expect((await run()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
});
