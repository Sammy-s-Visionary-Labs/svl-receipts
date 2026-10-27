import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { housecallConfiguration } from "@/lib/housecall/config";
import { runReceiptHousecallExport } from "@/lib/housecall/export";
import { POST } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/housecall/config", () => ({ housecallConfiguration: vi.fn() }));
vi.mock("@/lib/housecall/export", () => ({ runReceiptHousecallExport: vi.fn() }));
const id = "44100000-0000-4000-8000-000000000001";
let row: Record<string, unknown> | null;
let dbError: { message: string } | null;
const from = vi.fn();
const run = (receiptId = id) =>
  POST(
    new Request(`http://localhost/api/manager/receipts/${receiptId}/export-continue`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: receiptId }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  dbError = null;
  row = { id, status: "approved", submitted_at: "2026-10-27T12:00:00Z" };
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: row, error: dbError }),
  };
  from.mockReturnValue(query);
  vi.mocked(requireManager).mockResolvedValue({
    supabase: { from },
    actor: { role: "manager", userId: "actor" },
  } as never);
  vi.mocked(housecallConfiguration).mockReturnValue({
    mode: "manager_approved",
    exportsEnabled: true,
  } as never);
  vi.mocked(runReceiptHousecallExport).mockResolvedValue({ completed: 1, unresolved: 0 });
});
describe("continue an already approved export", () => {
  it.each(["approved", "exporting", "partial_success", "export_failed"])(
    "continues %s using only the existing frozen approval",
    async (status) => {
      row = { ...row, status };
      expect((await run()).status).toBe(202);
      expect(from).toHaveBeenCalledExactlyOnceWith("receipts");
      expect(runReceiptHousecallExport).not.toHaveBeenCalled();
      const callback = vi.mocked(after).mock.calls[0]?.[0] as () => Promise<void>;
      await callback();
      expect(runReceiptHousecallExport).toHaveBeenCalledExactlyOnceWith(id);
    },
  );
  it.each(["needs_review", "exported", "rejected", "duplicate"])(
    "does not continue %s",
    async (status) => {
      row = { ...row, status };
      expect((await run()).status).toBe(409);
      expect(after).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { submitted_at: null },
    { content_deleted_at: "2026-10-27" },
    { purge_claimed_at: "2026-10-27" },
  ])("enforces receipt visibility and retention %j", async (patch) => {
    row = patch === null ? null : { ...row, ...patch };
    expect((await run()).status).toBe(404);
    expect(after).not.toHaveBeenCalled();
  });
  it("does not continue without active manager access", async () => {
    vi.mocked(requireManager).mockRejectedValue(
      new AuthHttpError(403, "forbidden", "Manager access required"),
    );
    expect((await run()).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
  it("preserves the disabled/test-mode boundary", async () => {
    vi.mocked(housecallConfiguration).mockReturnValue({
      mode: "approved_test",
      exportsEnabled: true,
    } as never);
    expect((await run()).status).toBe(503);
    expect(after).not.toHaveBeenCalled();
  });
  it("fails closed on database errors and malformed IDs", async () => {
    dbError = { message: "unavailable" };
    expect((await run()).status).toBe(500);
    expect((await run("invalid")).status).toBe(400);
    expect(after).not.toHaveBeenCalled();
  });
});
