import { EMPTY_REVIEW } from "@svl/domain";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { POST } from "./route";

vi.mock("@/lib/auth/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
const id = "44100000-0000-4000-8000-000000000001";
const rpc = vi.fn();
const draft = {
  ...EMPTY_REVIEW,
  vendor: "Supply",
  purchaseDate: "2026-09-07",
  category: "Materials",
  lines: [{ description: "Wood", qty: "2", uom: "ea", unitCost: "1.25", jobId: "job-a" }],
};
const body = { decision: "approve", version: 0, extractionId: null, draft, taxExcluded: true };
const run = (payload: unknown) =>
  POST(
    new Request("http://localhost/api/manager/receipts/x/review", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    { params: Promise.resolve({ id }) },
  );
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(requireManager).mockResolvedValue({
    actor: { userId: "actor", role: "manager", disabled: false },
  } as never);
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as never);
  rpc.mockResolvedValue({ data: { id, version: 1, status: "approved" }, error: null });
});
describe("manager review API", () => {
  it("uses only the server's configured test session for atomic approval", async () => {
    const sessionId = "79100000-0000-4000-8000-000000000099";
    vi.stubEnv("HOUSECALL_TEST_SESSION_ID", sessionId);
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_EXPORT_MODE", "approved_test");
    vi.stubEnv("HOUSECALL_TEST_CUSTOMER_IDS", "customer-test");
    vi.stubEnv("HOUSECALL_TEST_JOB_IDS", "job-a");
    expect((await run({ ...body, sessionId: "spoofed", exportAuthorized: true })).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "manager_review_with_test_export",
      expect.objectContaining({ p_session_id: sessionId, p_actor_id: "actor" }),
    );
  });
  it("keeps drafts available while an automatic-export environment is disabled", async () => {
    vi.stubEnv("HOUSECALL_TEST_SESSION_ID", "79100000-0000-4000-8000-000000000099");
    vi.stubEnv("HOUSECALL_EXPORT_MODE", "disabled");
    expect((await run(body)).status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
    expect((await run({ ...body, decision: "save_draft" })).status).toBe(200);
    expect(rpc.mock.calls[0][0]).toBe("manager_review_command");
  });
  it("blocks unsupported precision before saving approval or kicking export", async () => {
    const response = await run({
      ...body,
      draft: { ...draft, lines: [{ ...draft.lines[0], qty: "1.005" }] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).fields["lines.0.qty"]).toContain("will not be rounded");
    expect(rpc).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });
  it("takes the actor from auth and forwards a versioned sanitized snapshot", async () => {
    const response = await run({
      ...body,
      actorId: "spoof",
      draft: { ...draft, secret: "discard" },
    });
    expect(response.status).toBe(200);
    expect(after).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith(
      "manager_review_command",
      expect.objectContaining({ p_actor_id: "actor", p_version: 0, p_snapshot: draft }),
    );
  });
  it.each([
    { version: -1 },
    { version: 1.1 },
    { version: null },
    { extractionId: "wrong" },
    { decision: "hack" },
    { taxExcluded: false },
    { draft: { ...draft, lines: [{ ...draft.lines[0], qty: -1 }] } },
  ])("rejects malformed request %j", async (patch) => {
    expect((await run({ ...body, ...patch })).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("returns inline approval errors without exporting", async () => {
    const response = await run({
      ...body,
      draft: { ...draft, lines: [{ ...draft.lines[0], jobId: "" }] },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).fields["lines.0.jobId"]).toBeTruthy();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("reports stale drafts as conflict", async () => {
    rpc.mockResolvedValue({ error: { message: "conflict_stale_review" } });
    expect((await run(body)).status).toBe(409);
  });
  it.each(["decline", "mark_duplicate", "request_clarification"])(
    "requires reason for %s",
    async (decision) => {
      expect((await run({ ...body, decision })).status).toBe(400);
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("requires canonical UUID for duplicates", async () =>
    expect(
      (await run({ ...body, decision: "mark_duplicate", reason: "same", canonicalReceiptId: "x" }))
        .status,
    ).toBe(400));
  it("accepts incomplete save for later without approval", async () => {
    expect((await run({ ...body, decision: "save_draft", draft: EMPTY_REVIEW })).status).toBe(200);
    expect(rpc.mock.calls[0][1].p_decision).toBe("save_draft");
  });
  it.each([401, 403])("denies unauthorized %s before creating service client", async (status) => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(status, "forbidden", "Denied"));
    expect((await run(body)).status).toBe(status);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it("bounds streamed JSON request size", async () => {
    expect((await run({ ...body, padding: "a".repeat(128001) })).status).toBe(413);
    expect(rpc).not.toHaveBeenCalled();
  });
});
