import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/housecall/config", () => ({
  housecallConfiguration: () => ({ allowedJobIds: new Set(["job-a"]), exportsEnabled: false }),
}));
const id = "44100000-0000-4000-8000-000000000001";
let rows: Record<string, unknown>;
let from: ReturnType<typeof vi.fn>;
const run = () =>
  GET(new Request(`http://localhost/api/manager/receipts/${id}/export-preview`), {
    params: Promise.resolve({ id }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  rows = {
    receipts: { id, submitted_at: "2026-09-09T12:00:00Z" },
    housecall_outbox: { intent_id: "intent", status: "pending" },
    housecall_intents: {
      id: "intent",
      payload_hash: "a".repeat(64),
      attachment_job_ids: ["job-a"],
    },
    housecall_export_steps: [
      {
        id: "image",
        housecall_job_id: "job-a",
        step: "attachment",
        status: "ready",
        external_id: null,
        payload: { image: { page_index: 0, storage_key: "secret/image.jpg" } },
      },
      {
        id: "line",
        housecall_job_id: "job-a",
        step: "job_cost",
        status: "ready",
        external_id: null,
        payload: {
          line: {
            description: "Frozen material",
            qty: 0.5,
            unit_cost_cents: 4200,
            extended_cost_cents: 2100,
          },
        },
      },
    ],
    manager_job_catalog: [{ id: "job-a", label: "RA6 Test Customer 2", unavailable: false }],
  };
  from = vi.fn((table: string) => {
    const result = () => ({ data: rows[table], error: null });
    const chain: Record<string, unknown> = {
      // biome-ignore lint/suspicious/noThenProperty: Supabase builders are awaitable.
      then: (resolve: (value: unknown) => void) => resolve(result()),
    };
    for (const method of ["select", "eq", "order", "limit", "in"])
      chain[method] = vi.fn(() => chain);
    for (const method of ["maybeSingle", "single"]) chain[method] = vi.fn(async () => result());
    return chain;
  });
  vi.mocked(requireManager).mockResolvedValue({
    actor: { role: "manager", userId: "actor" },
    supabase: { from },
  } as never);
});
describe("read-only manager export preview route", () => {
  it("returns only frozen reviewable fields and private no-store responses", async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      intentId: "intent",
      totalMaterialCostCents: 2100,
      liveWritesEnabled: false,
      previewOnly: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/secret|storage_key/);
    expect(from.mock.calls.map(([table]) => table)).not.toContain("housecall_write_approvals");
  });
  it.each(["content_deleted_at", "purge_claimed_at"])(
    "blocks %s before frozen content reads",
    async (field) => {
      rows.receipts = { ...(rows.receipts as object), [field]: "2026-09-09" };
      const response = await run();
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(from).toHaveBeenCalledTimes(1);
    },
  );
  it("does not expose cancelled or absent intents", async () => {
    rows.housecall_outbox = { intent_id: "intent", status: "cancelled" };
    expect(await (await run()).json()).toMatchObject({
      intentId: null,
      jobs: [],
      blockedReasons: ["no_current_intent"],
    });
    expect(from).not.toHaveBeenCalledWith("housecall_intents");
    expect(from).not.toHaveBeenCalledWith("housecall_export_steps");
  });
  it("requires manager authentication before database access", async () => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(403, "forbidden", "Denied"));
    expect((await run()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
  });
  it("refuses invalid stored costs instead of showing an inaccurate approval preview", async () => {
    (rows.housecall_export_steps as Array<{ payload: unknown }>)[1].payload = {
      line: {
        description: "Synthetic",
        qty: 0.5,
        unit_cost_cents: 4200,
        extended_cost_cents: 9999,
      },
    };
    expect((await run()).status).toBe(422);
  });
});

it("distinguishes audited manual handoff from other cancelled intents", async () => {
  rows.housecall_outbox = { intent_id: "intent", status: "cancelled" };
  expect((await (await run()).json()).closedForManualHandling).toBe(false);
  rows.housecall_manual_resolutions = { id: "resolution" };
  expect((await (await run()).json()).closedForManualHandling).toBe(true);
});
