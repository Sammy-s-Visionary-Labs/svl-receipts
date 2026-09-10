import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { syncHousecallJobs } from "@/lib/housecall/jobs";
import { GET, POST } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));

vi.mock("@/lib/housecall/jobs", () => ({ syncHousecallJobs: vi.fn() }));

const now = Date.parse("2026-09-09T16:00:00.000Z");
const day = 86_400_000;
const at = (offset: number) => new Date(now + offset).toISOString();
const rpc = vi.fn();
const request = (query = "") => new Request(`http://localhost/api/manager/jobs${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("HOUSECALL_ACTIVE_LOOKBACK_DAYS", "");
  vi.stubEnv("HOUSECALL_ACTIVE_LOOKAHEAD_DAYS", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Housecall requests are forbidden in saved-catalog search tests");
    }),
  );
  vi.mocked(requireManager).mockResolvedValue({
    actor: { userId: "manager_test", role: "manager", disabled: false },
    supabase: { rpc },
  } as never);
  rpc.mockResolvedValue({ data: [], error: null });
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("manager saved Housecall job search", () => {
  it.each([
    [401, "unauthenticated"],
    [401, "account_inactive"],
    [403, "forbidden"],
  ])("rejects %s/%s before parsing or database access", async (status, code) => {
    vi.mocked(requireManager).mockRejectedValue(
      new AuthHttpError(Number(status), String(code), "Access denied"),
    );
    const response = await GET(request("?scope=invalid"));
    expect(response.status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("searches all jobs by default and binds search windows to the authenticated catalog RPC", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobs: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requireManager).toHaveBeenCalledWith(expect.any(Request), "GET manager jobs");
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("manager_search_housecall_jobs", {
      p_search: "",
      p_active: false,
      p_limit: 50,
      p_recent_since: at(-30 * day),
      p_upcoming_until: at(90 * day),
    });
  });

  it("uses server-configured windows and passes trimmed all-job search as a bound value", async () => {
    vi.stubEnv("HOUSECALL_ACTIVE_LOOKBACK_DAYS", "7");
    vi.stubEnv("HOUSECALL_ACTIVE_LOOKAHEAD_DAYS", "45");
    const response = await GET(request("?scope=all&search=%20RA6%20Test%20Customer%202%20"));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("manager_search_housecall_jobs", {
      p_search: "RA6 Test Customer 2",
      p_active: false,
      p_limit: 50,
      p_recent_since: at(-7 * day),
      p_upcoming_until: at(45 * day),
    });
  });

  it.each(["?scope=", "?scope=inactive", "?scope=ACTIVE", `?search=${"x".repeat(121)}`])(
    "rejects invalid search/scope %s before the RPC",
    async (query) => {
      const response = await GET(request(query));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_request", message: "Invalid job search" },
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );

  it("projects safe catalog metadata without merging duplicate labels or hiding stale evidence", async () => {
    const row = {
      id: "job_exact_1",
      label: "RA6 Test Customer 2",
      customer: "RA6 Test Customer 2",
      job_number: "TEST-101",
      status: "scheduled",
      scheduled_at: at(day),
      technicians: ["Test Technician", 12, { private: "hidden" }],
      active: true,
      source: "housecall",
      unavailable: false,
      synced_at: at(-1000),
      api_key: "private-api-key",
      raw_payload: { secret: "private-provider-payload" },
      customer_email: "private-email",
    };
    rpc.mockResolvedValue({
      data: [row, { ...row, id: "job_exact_2", synced_at: "invalid timestamp", unavailable: true }],
      error: null,
    });
    const response = await GET(request("?search=RA6"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.jobs).toEqual([
      {
        id: "job_exact_1",
        label: row.label,
        customer: row.customer,
        number: row.job_number,
        status: "scheduled",
        scheduledAt: at(day),
        technicians: ["Test Technician"],
        active: true,
        source: "housecall",
        unavailable: false,
        syncedAt: at(-1000),
        stale: false,
      },
      {
        id: "job_exact_2",
        label: row.label,
        customer: row.customer,
        number: row.job_number,
        status: "scheduled",
        scheduledAt: at(day),
        technicians: ["Test Technician"],
        active: true,
        source: "housecall",
        unavailable: true,
        syncedAt: "invalid timestamp",
        stale: true,
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /private-api-key|private-provider-payload|private-email|hidden/,
    );
  });

  it("redacts unexpected database failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({ data: null, error: { message: "private database detail" } });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database detail");
  });
});

describe("manager catalog refresh", () => {
  it("allows a database manager to refresh without accepting client configuration", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_ACCESS_MODE", "all_jobs");
    vi.mocked(syncHousecallJobs).mockResolvedValue({
      count: 990,
      scanned: 990,
      full: true,
      syncedAt: new Date().toISOString(),
    });
    expect(
      (
        await POST(
          new Request("http://localhost/api/manager/jobs", {
            method: "POST",
            body: JSON.stringify({ enableWrites: true, actorId: "spoof" }),
          }),
        )
      ).status,
    ).toBe(200);
    expect(requireManager).toHaveBeenCalledWith(expect.any(Request), "POST manager jobs refresh");
    expect(syncHousecallJobs).toHaveBeenCalledWith({ full: true });
  });
  it("denies workers before any provider access", async () => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(403, "forbidden", "Denied"));
    expect((await POST(request())).status).toBe(403);
    expect(syncHousecallJobs).not.toHaveBeenCalled();
  });
});
