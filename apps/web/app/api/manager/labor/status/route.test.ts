import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireLaborAccess } from "@/lib/labor/access";
import { loadLaborStatus } from "@/lib/labor/store";
import { GET } from "./route";

vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  AuthHttpError: class extends Error {},
  authErrorResponse: vi.fn(),
}));
vi.mock("@/lib/labor/store", () => ({ loadLaborStatus: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe("lightweight manager labor status", () => {
  it("authorizes the manager before reading status", async () => {
    vi.mocked(requireLaborAccess).mockRejectedValue(new Error("Manager role required"));
    expect(
      (await GET(new Request("https://fixture.example/api/manager/labor/status"))).status,
    ).toBe(400);
    expect(loadLaborStatus).not.toHaveBeenCalled();
  });
  it("returns only public sync and data revision privately", async () => {
    vi.mocked(requireLaborAccess).mockResolvedValue({ actor: null, supabase: null, worker: false });
    const status = {
      sync: {
        enabled: false,
        hour: 6,
        timeZone: "America/New_York",
        lookbackDays: 14,
        status: "idle" as const,
        lastAttemptAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        lastError: null,
        workerHeartbeatAt: null,
        command: null,
        commandId: null,
      },
      dataRevision: "synthetic-revision",
    };
    vi.mocked(loadLaborStatus).mockResolvedValue(status);
    const request = new Request("https://fixture.example/api/manager/labor/status");
    const response = await GET(request);
    expect(requireLaborAccess).toHaveBeenCalledWith(request);
    expect(await response.json()).toEqual(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
