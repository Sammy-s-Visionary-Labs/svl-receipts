import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";
import { GET, POST } from "./route";

const { access, workspace, action } = vi.hoisted(() => ({
  access: vi.fn(),
  workspace: vi.fn(),
  action: vi.fn(),
}));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: access }));
vi.mock("@/lib/labor/approval-service", () => ({
  loadLaborApprovalWorkspace: workspace,
  laborApprovalAction: action,
}));
const manager = "00000000-0000-4000-8000-000000000001";
function request(body: unknown) {
  return new Request("https://example.test/api/manager/labor/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ actor: { userId: manager } });
  workspace.mockResolvedValue({ preview: "TEST" });
  action.mockResolvedValue({ approval: "TEST" });
});
describe("manager job-hour approval API", () => {
  it("denies anonymous/worker/disabled access before reading or mutating approvals", async () => {
    for (const status of [401, 403]) {
      access.mockRejectedValue(new AuthHttpError(status, "forbidden", "Denied"));
      expect(
        (await GET(new Request("https://example.test/api/manager/labor/approvals"))).status,
      ).toBe(status);
      expect((await POST(request({ action: "send", approvalId: "TEST" }))).status).toBe(status);
    }
    expect(workspace).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
  it("passes exact date/job/worker review scope to the server and returns private no-store data", async () => {
    const query = new URLSearchParams({
      housecallJobId: "TEST-JOB",
      fromDate: "2026-09-17",
      toDate: "2026-09-23",
      workers: JSON.stringify(["TEST Worker"]),
    });
    const result = await GET(
      new Request(`https://example.test/api/manager/labor/approvals?${query}`),
    );
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(workspace).toHaveBeenCalledWith({
      housecallJobId: "TEST-JOB",
      fromDate: "2026-09-17",
      toDate: "2026-09-23",
      workerNames: ["TEST Worker"],
    });
  });
  it("uses the authenticated manager, never an actor identity from browser input", async () => {
    const input = { action: "approve", reviewed: true, actorId: "UNTRUSTED" };
    expect((await POST(request(input))).status).toBe(200);
    expect(action).toHaveBeenCalledWith(input, manager);
  });
  it("rejects malformed or oversized input without changing approval state", async () => {
    expect((await POST(request([]))).status).toBe(400);
    expect((await POST(request({ padding: "x".repeat(9000) }))).status).toBe(400);
    expect(action).not.toHaveBeenCalled();
  });
  it("propagates disabled sending and stale reviews without executing another action", async () => {
    action.mockRejectedValueOnce(
      new AuthHttpError(403, "labor_sending_disabled", "Nothing was sent."),
    );
    expect((await POST(request({ action: "send" }))).status).toBe(403);
    action.mockRejectedValueOnce(new AuthHttpError(409, "stale_review", "Refresh."));
    expect((await POST(request({ action: "approve" }))).status).toBe(409);
  });
});
