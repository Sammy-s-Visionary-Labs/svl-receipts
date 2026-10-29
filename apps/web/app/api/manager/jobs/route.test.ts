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
const catalogIn = vi.fn();
const select = vi.fn(() => ({ in: catalogIn }));
const from = vi.fn(() => ({ select }));
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
    supabase: { rpc, from },
  } as never);
  rpc.mockResolvedValue({ data: [], error: null });
  catalogIn.mockResolvedValue({ data: [], error: null });
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

describe("manager saved job lookup by exact IDs", () => {
  it("returns selected jobs outside search windows with unavailable and stale evidence intact", async () => {
    const row = {
      id: "job_old",
      label: "Earlier customer job",
      customer: "Earlier customer",
      job_number: "123",
      status: "completed",
      scheduled_at: at(-365 * day),
      technicians: ["Assigned Technician", { private: "hidden" }],
      active: false,
      source: "housecall",
      synced_at: at(-1000),
      unavailable: false,
      raw_payload: { secret: "private-provider-payload" },
      customer_email: "private-email",
    };
    catalogIn.mockResolvedValue({
      data: [
        row,
        { ...row, id: "job_missing", unavailable: true },
        { ...row, id: "job_stale", synced_at: at(-2 * day) },
      ],
      error: null,
    });
    const response = await GET(request("?ids=job_old,job_missing,job_stale,job_old"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requireManager).toHaveBeenCalledWith(expect.any(Request), "GET manager jobs");
    expect(from).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith("manager_job_catalog");
    expect(select).toHaveBeenCalledWith(
      "id,label,customer,job_number,status,scheduled_at,technicians,active,source,synced_at,unavailable",
    );
    expect(catalogIn).toHaveBeenCalledWith("id", ["job_old", "job_missing", "job_stale"]);
    expect(rpc).not.toHaveBeenCalled();
    expect(syncHousecallJobs).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.jobs).toEqual([
      {
        id: "job_old",
        label: row.label,
        customer: row.customer,
        number: "123",
        status: "completed",
        scheduledAt: at(-365 * day),
        technicians: ["Assigned Technician"],
        active: false,
        source: "housecall",
        unavailable: false,
        syncedAt: at(-1000),
        stale: false,
      },
      expect.objectContaining({ id: "job_missing", unavailable: true, stale: false }),
      expect.objectContaining({ id: "job_stale", syncedAt: at(-2 * day), stale: true }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/private-provider-payload|private-email|hidden/);
  });

  it.each(["", "all_jobs"])("keeps the source policy for access mode %s", async (mode) => {
    vi.stubEnv("HOUSECALL_ACCESS_MODE", mode);
    catalogIn.mockResolvedValue({
      data: [
        { id: "job_provider", label: "Provider", source: "housecall", synced_at: at(-1000) },
        { id: "job_legacy", label: "Legacy", source: "legacy" },
      ],
      error: null,
    });
    const response = await GET(request("?ids=job_provider,job_legacy"));
    expect((await response.json()).jobs.map((job: { id: string }) => job.id)).toEqual(
      mode === "all_jobs" ? ["job_provider"] : ["job_provider", "job_legacy"],
    );
  });

  it("accepts 100 IDs at the maximum provider-ID length", async () => {
    const ids = Array.from(
      { length: 100 },
      (_, index) => `job_${String(index).padStart(3, "0")}_${"x".repeat(152)}`,
    );
    expect(ids[0]).toHaveLength(160);
    const response = await GET(request(`?ids=${ids.join(",")}&search=%20`));
    expect(response.status).toBe(200);
    expect(catalogIn).toHaveBeenCalledWith("id", ids);
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    "?ids=",
    "?ids=job_a,",
    "?ids=,job_a",
    "?ids=job_a,,job_b",
    "?ids=job_a&ids=job_b",
    "?ids=job_a&ids=",
    "?ids=job_a&search=customer",
    "?ids=job_a&search=&search=customer",
    "?ids=job.a",
    "?ids=job%20a",
    "?ids=job%2Fa",
    "?ids=job%22a",
    "?ids=job(a)",
    `?ids=${"x".repeat(161)}`,
    `?ids=${"x".repeat(16_100)}`,
    `?ids=${Array.from({ length: 101 }, (_, index) => `job_${index}`).join(",")}`,
  ])("rejects invalid or ambiguous ID lookup before catalog access: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Invalid job IDs" },
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("denies workers before parsing IDs or reading the catalog", async () => {
    vi.mocked(requireManager).mockRejectedValue(new AuthHttpError(403, "forbidden", "Denied"));
    const response = await GET(request("?ids="));
    expect(response.status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(syncHousecallJobs).not.toHaveBeenCalled();
  });

  it("redacts exact-lookup database failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    catalogIn.mockResolvedValue({ data: null, error: { message: "private database detail" } });
    const response = await GET(request("?ids=job_a"));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database detail");
  });
});

describe("manager catalog refresh", () => {
  it.each([
    [new HousecallError("authentication", 401), 503, "housecall_connection_unavailable"],
    [new HousecallError("forbidden", 403), 503, "housecall_connection_unavailable"],
    [new HousecallError("configuration"), 503, "housecall_connection_unavailable"],
    [new HousecallError("rate_limited", 429), 429, "housecall_rate_limited"],
    [new HousecallError("timeout"), 504, "housecall_refresh_timeout"],
    [new HousecallError("network"), 503, "housecall_temporarily_unavailable"],
    [new HousecallError("provider_unavailable", 503), 503, "housecall_temporarily_unavailable"],
    [new HousecallError("invalid_response"), 502, "housecall_refresh_invalid_response"],
    [new HousecallError("provider_rejected", 400), 502, "housecall_refresh_invalid_response"],
    [new Error("sync_unstable_pages"), 502, "housecall_refresh_incomplete"],
    [new Error("sync_page_limit"), 502, "housecall_refresh_incomplete"],
    [new Error("sync_wrong_customer"), 502, "housecall_refresh_incomplete"],
    [new Error("sync_deadline"), 504, "housecall_refresh_timeout"],
  ])("returns actionable refresh guidance for %s", async (error, status, code) => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_ACCESS_MODE", "all_jobs");
    vi.mocked(syncHousecallJobs).mockRejectedValue(error);
    const response = await POST(request());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect((await response.json()).error).toMatchObject({
      code,
      message: expect.stringMatching(/Housecall|job refresh/),
    });
  });
  it("keeps unexpected failures private and retains manager access errors", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_ACCESS_MODE", "all_jobs");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(syncHousecallJobs).mockRejectedValue(new Error("private database details"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database details");
  });
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

import { HousecallError } from "@svl/integrations";
