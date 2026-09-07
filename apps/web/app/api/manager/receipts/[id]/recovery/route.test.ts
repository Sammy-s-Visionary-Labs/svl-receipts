import { EMPTY_REVIEW } from "@svl/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireManager } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { POST } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
const id = "44100000-0000-4000-8000-000000000001";
const rpc = vi.fn();
const run = (body: unknown) =>
  POST(new Request("http://localhost/recovery", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireManager).mockResolvedValue({
    actor: { userId: "actor", role: "manager" },
  } as never);
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as never);
  rpc.mockResolvedValue({ data: { id, status: "pending" } });
});
describe("recovery permissions and targets", () => {
  it("queues the exact retry attempt and never claims external success", async () => {
    const res = await run({ kind: "retry", intentId: id, attemptId: id, reason: "retry" });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe("pending");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_attempt_id: id, p_snapshot: null });
  });
  it("blocks manager correction", async () => {
    expect((await run({ kind: "correction" })).status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("requires explicit impact acknowledgement for administrators", async () => {
    vi.mocked(requireManager).mockResolvedValue({
      actor: { userId: "actor", role: "admin" },
    } as never);
    expect(
      (await run({ kind: "correction", intentId: id, reason: "correct", draft: EMPTY_REVIEW }))
        .status,
    ).toBe(400);
  });
  it("records admin correction with no direct provider call", async () => {
    vi.mocked(requireManager).mockResolvedValue({
      actor: { userId: "actor", role: "admin" },
    } as never);
    expect(
      (
        await run({
          kind: "correction",
          intentId: id,
          reason: "correct",
          draft: EMPTY_REVIEW,
          confirmImpact: true,
        })
      ).status,
    ).toBe(202);
  });
  it("rejects stale or succeeded target conflicts", async () => {
    rpc.mockResolvedValue({ error: { message: "conflict" } });
    expect(
      (await run({ kind: "retry", intentId: id, attemptId: id, reason: "retry" })).status,
    ).toBe(409);
  });
});
