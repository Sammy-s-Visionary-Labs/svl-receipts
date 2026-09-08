import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as category } from "@/app/api/admin/categories/route";
import { GET as evaluation } from "@/app/api/admin/intelligence/evaluation/route";
import { POST as duplicate } from "@/app/api/manager/receipts/[id]/duplicates/route";
import { POST as reextract } from "@/app/api/manager/receipts/[id]/reextract/route";
import { AuthHttpError, requireAdmin, requireManager } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
const id = "44100000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ id }) };
const request = (body: unknown) =>
  new Request("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });
const rpc = vi.fn();
const from = vi.fn();
let result: { data: unknown; error: unknown };
beforeEach(() => {
  vi.clearAllMocks();
  result = { data: { id }, error: null };
  from.mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "order", "limit", "eq", "or"])
      chain[method] = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => result);
    // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are awaitable.
    chain.then = (resolve: (v: unknown) => void) => resolve(result);
    return chain;
  });
  const ctx = {
    actor: { userId: "real-actor", role: "admin", disabled: false },
    supabase: { from },
  };
  vi.mocked(requireAdmin).mockResolvedValue(ctx as never);
  vi.mocked(requireManager).mockResolvedValue(ctx as never);
  rpc.mockResolvedValue({ data: { id }, error: null });
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as never);
});
describe("intelligence mutation authority", () => {
  it("requires admin authorization before configuring categories and disregards supplied actor", async () => {
    expect(
      (
        await category(
          request({
            id: "materials",
            label: "Materials",
            active: true,
            keywords: ["PIPE", "pipe"],
            actorId: "spoof",
          }),
        )
      ).status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "configure_receipt_category",
      expect.objectContaining({ p_actor_id: "real-actor", p_keywords: ["pipe"] }),
    );
  });
  it.each([{ id: "invalid id" }, { active: "true" }, { keywords: ["x".repeat(81)] }])(
    "validates category configuration %j",
    async (patch) => {
      expect(
        (
          await category(
            request({ id: "materials", label: "Materials", active: true, keywords: [], ...patch }),
          )
        ).status,
      ).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("denies workers and managers at the admin boundary", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new AuthHttpError(403, "forbidden", "Admin required"),
    );
    expect((await category(request({}))).status).toBe(403);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it("allows dismissal only for a candidate visible on this receipt", async () => {
    expect(
      (await duplicate(request({ decision: "dismiss", candidateId: id }), context)).status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith("dismiss_duplicate_candidate", {
      p_id: id,
      p_actor_id: "real-actor",
    });
    rpc.mockClear();
    result = { data: null, error: null };
    expect(
      (await duplicate(request({ decision: "dismiss", candidateId: id }), context)).status,
    ).toBe(404);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("does not accept confirmation through the dismissal endpoint", async () => {
    expect(
      (await duplicate(request({ decision: "confirm", candidateId: id }), context)).status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("queues reextraction only after the actor-checked database request succeeds", async () => {
    expect((await reextract(request({ actorId: "spoof" }), context)).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("request_receipt_reextraction", {
      p_receipt_id: id,
      p_actor_id: "real-actor",
    });
    expect(after).toHaveBeenCalledOnce();
    vi.mocked(after).mockClear();
    rpc.mockResolvedValue({ error: { message: "conflict" } });
    expect((await reextract(request({}), context)).status).toBe(409);
    expect(after).not.toHaveBeenCalled();
  });
});
describe("evaluation privacy", () => {
  it("exports pseudonymous text/identities with numeric pairs and no raw notes", async () => {
    result = {
      data: [
        {
          id,
          created_at: "2026-09-08T12:00:00Z",
          receipt_id: "private-receipt",
          actor_id: "private-actor",
          field_path: "vendor",
          suggested_value: "private vendor",
          final_value: "secret",
          accepted: false,
          model: "gemini-test",
          scoring_version: "ra5-rules-v1",
        },
        { field_path: "managerNotes", suggested_value: "private notes", final_value: "secret" },
      ],
      error: null,
    };
    const response = await evaluation(
      new Request("http://localhost/api/admin/intelligence/evaluation"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.records).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(
      /private-receipt|private-actor|private vendor|secret|private notes/,
    );
  });
  it("rejects malformed paging cursors", async () => {
    expect(
      (
        await evaluation(
          new Request("http://localhost/api/admin/intelligence/evaluation?cursor=garbage"),
        )
      ).status,
    ).toBe(400);
    expect(from).not.toHaveBeenCalled();
  });
});
