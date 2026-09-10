import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireAdmin } from "@/lib/auth/guards";
import { closeExportForManualHandling } from "@/lib/housecall/resolution";
import { POST } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireAdmin: vi.fn(),
}));
vi.mock("@/lib/housecall/resolution", () => ({ closeExportForManualHandling: vi.fn() }));
const id = "66100000-0000-4000-8000-000000000001";
const body = {
  intentId: id,
  payloadHash: "a".repeat(64),
  confirmStop: true,
  reason: "Reviewed provider mismatch",
};
const run = (value: unknown = body) =>
  POST(
    new Request("http://localhost/close-export", { method: "POST", body: JSON.stringify(value) }),
    { params: Promise.resolve({ id }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({ actor: { userId: "admin", role: "admin" } } as never);
  vi.mocked(closeExportForManualHandling).mockResolvedValue({ closed: true, exported: false });
});
describe("manual export closure authorization", () => {
  it.each([401, 403])(
    "rejects unauthorized callers (%s) before reading input or provider",
    async (status) => {
      vi.mocked(requireAdmin).mockRejectedValue(
        new AuthHttpError(status, "forbidden", "Admin required"),
      );
      expect((await run()).status).toBe(status);
      expect(closeExportForManualHandling).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...body, confirmStop: false },
    { ...body, intentId: [] },
    { ...body, payloadHash: "wrong" },
    { ...body, reason: "" },
    { ...body, reason: "x".repeat(2001) },
  ])("rejects invalid or unconfirmed requests", async (value) => {
    expect((await run(value)).status).toBe(400);
    expect(closeExportForManualHandling).not.toHaveBeenCalled();
  });
  it("passes the authenticated actor and frozen plan, returning no-store", async () => {
    const response = await run();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ closed: true, exported: false });
    expect(closeExportForManualHandling).toHaveBeenCalledWith({
      actorId: "admin",
      receiptId: id,
      intentId: id,
      payloadHash: body.payloadHash,
      reason: body.reason,
    });
  });
});
