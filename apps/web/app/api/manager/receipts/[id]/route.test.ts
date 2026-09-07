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
    for (const method of ["select", "eq", "not", "order", "limit"])
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
  it("requires authorization before reading receipt contents", async () => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(403, "forbidden", "Denied"));
    expect((await run()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
});
