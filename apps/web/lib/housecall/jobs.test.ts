import {
  createHousecallClient,
  HousecallError,
  type HousecallJob,
  type HousecallJobsPage,
} from "@svl/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { jobCatalogRow, syncHousecallJobs } from "./jobs";

vi.mock("@svl/integrations", async (original) => ({
  ...(await original<typeof import("@svl/integrations")>()),
  createHousecallClient: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
const NOW = Date.now();
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
function job(id = "job_test_2", extra: Partial<HousecallJob> = {}): HousecallJob {
  return {
    id,
    invoiceNumber: "RA6-2",
    description: "Synthetic job",
    customerId: "customer_test",
    customerName: "RA6 Test Customer",
    customerNotificationsEnabled: false,
    address: "10 Test Road",
    workStatus: "scheduled",
    active: true,
    canceled: false,
    deleted: false,
    locked: false,
    scheduledStart: iso(),
    scheduledEnd: iso(3600000),
    assignedEmployeeIds: ["employee_test"],
    updatedAt: iso(),
    attachments: null,
    ...extra,
  };
}
function page(jobs: HousecallJob[], extra: Partial<HousecallJobsPage> = {}): HousecallJobsPage {
  return { jobs, page: 1, pageSize: 100, totalPages: 1, totalItems: jobs.length, ...extra };
}
type SyncState = {
  lease_token: string;
  last_success_at: string | null;
  last_full_sync_at: string | null;
};
function database(
  state: SyncState | null = {
    lease_token: "lease_test",
    last_success_at: null,
    last_full_sync_at: null,
  },
  finishError: unknown = null,
) {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "claim_housecall_job_sync") return { data: state, error: null };
      if (name === "finish_housecall_job_sync") return { data: null, error: finishError };
      if (name === "fail_housecall_job_sync") return { data: null, error: null };
      throw new Error("Unexpected mock RPC");
    }),
  };
}
type SyncInput = NonNullable<Parameters<typeof syncHousecallJobs>[0]>;
function run(
  db: ReturnType<typeof database>,
  listJobs: NonNullable<SyncInput["client"]>["listJobs"],
  extra: Partial<SyncInput> = {},
) {
  return syncHousecallJobs({
    db: db as unknown as SyncInput["db"],
    client: { listJobs },
    ...extra,
  });
}
function finishCall(db: ReturnType<typeof database>) {
  return (db.rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>).find(
    ([name]) => name === "finish_housecall_job_sync",
  )?.[1];
}
function expectFailedWithoutCommit(db: ReturnType<typeof database>, reason?: string) {
  expect(db.rpc).not.toHaveBeenCalledWith("finish_housecall_job_sync", expect.anything());
  expect(db.rpc).toHaveBeenCalledWith(
    "fail_housecall_job_sync",
    expect.objectContaining({
      p_lease_token: "lease_test",
      ...(reason ? { p_reason: reason } : {}),
    }),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live Housecall calls forbidden in tests");
    }),
  );
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Housecall catalog read synchronization", () => {
  it("disabled reads create no database or provider client", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "false");
    expect(await syncHousecallJobs()).toEqual({ skipped: "reads_disabled", count: 0 });
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(createHousecallClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("a competing synchronization lease makes no provider calls", async () => {
    const db = database(null);
    const listJobs = vi.fn();
    expect(await run(db, listJobs)).toEqual({ skipped: "sync_in_progress", count: 0 });
    expect(listJobs).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
  it("reads all pages and commits the validated catalog only after the final page", async () => {
    const db = database();
    const listJobs = vi
      .fn()
      .mockImplementationOnce(async () => {
        expect(finishCall(db)).toBeUndefined();
        return page([job()], { totalPages: 2, totalItems: 2 });
      })
      .mockImplementationOnce(async () => {
        expect(finishCall(db)).toBeUndefined();
        return page([job("job_test_3")], { page: 2, totalPages: 2, totalItems: 2 });
      });
    expect(await run(db, listJobs)).toMatchObject({ count: 2, scanned: 2, full: true });
    expect(listJobs.mock.calls).toEqual([
      [{ page: 1, pageSize: 100, sortBy: "updated_at", sortDirection: "desc" }],
      [{ page: 2, pageSize: 100, sortBy: "updated_at", sortDirection: "desc" }],
    ]);
    expect(finishCall(db)).toMatchObject({
      p_lease_token: "lease_test",
      p_full: true,
      p_jobs: [
        expect.objectContaining({ id: "job_test_2" }),
        expect.objectContaining({ id: "job_test_3" }),
      ],
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("incremental sync includes the five-minute overlap and unknown provider timestamps", async () => {
    const success = -3600000;
    const cutoff = success - 5 * 60000;
    const db = database({
      lease_token: "lease_test",
      last_success_at: iso(success),
      last_full_sync_at: iso(-86400000),
    });
    const listJobs = vi
      .fn()
      .mockResolvedValue(
        page([
          job("changed", { updatedAt: iso(success + 1) }),
          job("boundary", { updatedAt: iso(cutoff) }),
          job("old", { updatedAt: iso(cutoff - 1) }),
          job("unknown", { updatedAt: null }),
        ]),
      );
    expect(await run(db, listJobs)).toMatchObject({ count: 3, scanned: 4, full: false });
    expect(finishCall(db)?.p_jobs).toEqual([
      expect.objectContaining({ id: "changed" }),
      expect.objectContaining({ id: "boundary" }),
      expect.objectContaining({ id: "unknown" }),
    ]);
    expect(listJobs).toHaveBeenCalledWith(
      expect.not.objectContaining({ updated_since: expect.anything() }),
    );
  });
  it("refreshes observation freshness for unchanged jobs after a complete incremental scan", async () => {
    const db = database({
      lease_token: "lease_test",
      last_success_at: iso(-3600000),
      last_full_sync_at: iso(-86400000),
    });
    const listJobs = vi
      .fn()
      .mockResolvedValue(page([job("unchanged", { updatedAt: iso(-2 * 86400000) })]));
    expect(await run(db, listJobs)).toMatchObject({ count: 0, scanned: 1, full: false });
    expect(finishCall(db)).toMatchObject({ p_observed_job_ids: ["unchanged"] });
  });
  it("continues scanning past old timestamps so later missing timestamps are not lost", async () => {
    const db = database({
      lease_token: "lease_test",
      last_success_at: iso(-3600000),
      last_full_sync_at: iso(-86400000),
    });
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce(
        page([job("old", { updatedAt: iso(-2 * 86400000) })], { totalPages: 2, totalItems: 2 }),
      )
      .mockResolvedValueOnce(
        page([job("unknown", { updatedAt: null })], { page: 2, totalPages: 2, totalItems: 2 }),
      );
    expect(await run(db, listJobs)).toMatchObject({ count: 1, scanned: 2, full: false });
    expect(listJobs).toHaveBeenCalledTimes(2);
    expect(finishCall(db)?.p_jobs).toEqual([expect.objectContaining({ id: "unknown" })]);
  });
  it.each([{ full: true }, { staleFull: true }])(
    "performs full refresh when explicitly requested or weekly refresh is due %o",
    async (scenario) => {
      const db = database({
        lease_token: "lease_test",
        last_success_at: iso(-3600000),
        last_full_sync_at: iso(scenario.staleFull ? -8 * 86400000 : -86400000),
      });
      const listJobs = vi
        .fn()
        .mockResolvedValue(page([job("old", { updatedAt: iso(-20 * 86400000) })]));
      expect(await run(db, listJobs, { full: scenario.full })).toMatchObject({
        count: 1,
        full: true,
      });
    },
  );
  it.each([
    {
      name: "total item count drifts",
      second: page([job("job_test_3")], { page: 2, totalPages: 2, totalItems: 3 }),
    },
    {
      name: "total page count drifts",
      second: page([job("job_test_3")], { page: 2, totalPages: 3, totalItems: 2 }),
    },
    {
      name: "duplicate ID on later page",
      second: page([job()], { page: 2, totalPages: 2, totalItems: 2 }),
    },
    {
      name: "wrong page returned",
      second: page([job("job_test_3")], { page: 1, totalPages: 2, totalItems: 2 }),
    },
    {
      name: "empty page despite remaining items",
      second: page([], { page: 2, totalPages: 2, totalItems: 2 }),
    },
  ])("stops commit when $name", async ({ second }) => {
    const db = database();
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce(page([job()], { totalPages: 2, totalItems: 2 }))
      .mockResolvedValueOnce(second);
    await expect(run(db, listJobs)).rejects.toThrow("sync_unstable_pages");
    expectFailedWithoutCommit(db, "sync_unstable_pages");
  });
  it("rejects truncated total counts at the final page", async () => {
    const db = database();
    await expect(
      run(db, vi.fn().mockResolvedValue(page([job()], { totalItems: 3 }))),
    ).rejects.toThrow("sync_unstable_pages");
    expectFailedWithoutCommit(db);
  });
  it("allows a validated empty catalog", async () => {
    const db = database();
    expect(await run(db, vi.fn().mockResolvedValue(page([], { totalPages: 0 })))).toMatchObject({
      count: 0,
      scanned: 0,
    });
    expect(finishCall(db)?.p_jobs).toEqual([]);
  });
  it("does not commit a partial catalog when a later provider page fails", async () => {
    const db = database();
    const listJobs = vi
      .fn()
      .mockResolvedValueOnce(page([job()], { totalPages: 2, totalItems: 2 }))
      .mockRejectedValueOnce(new HousecallError("rate_limited", 429, 1000));
    await expect(run(db, listJobs)).rejects.toMatchObject({ code: "rate_limited" });
    expectFailedWithoutCommit(db, "provider_rate_limited");
  });
  it("records a classified error, never raw provider credentials, on authentication failure", async () => {
    const db = database();
    await expect(
      run(db, vi.fn().mockRejectedValue(new HousecallError("authentication", 401))),
    ).rejects.toMatchObject({ code: "authentication" });
    expectFailedWithoutCommit(db, "provider_authentication_failed");
  });
  it("stops before a provider call when the time budget cannot cover it", async () => {
    const db = database();
    const listJobs = vi.fn();
    await expect(run(db, listJobs, { deadlineAt: NOW + 1000 })).rejects.toThrow("sync_deadline");
    expect(listJobs).not.toHaveBeenCalled();
    expectFailedWithoutCommit(db, "sync_deadline");
  });
  it("caps a growing catalog scan without committing partial data", async () => {
    const db = database();
    const listJobs = vi.fn(async ({ page: requestedPage = 1 }) =>
      page([job(`job_${requestedPage}`)], {
        page: requestedPage,
        totalPages: 101,
        totalItems: 101,
      }),
    );
    await expect(run(db, listJobs)).rejects.toThrow("sync_page_limit");
    expect(listJobs).toHaveBeenCalledTimes(100);
    expectFailedWithoutCommit(db, "sync_page_limit");
  });
});

describe("Housecall job catalog safety mapping", () => {
  it.each([{ canceled: true }, { deleted: true }, { locked: true }])(
    "marks unsafe destination unavailable %o",
    (state) => {
      expect(jobCatalogRow(job("unsafe", state))).toMatchObject({
        active: false,
        unavailable: true,
      });
    },
  );
  it("maps employee identifiers without inventing application user identities", () => {
    const row = jobCatalogRow(job());
    expect(row.assigned_employee_ids).toEqual(["employee_test"]);
    expect(row).not.toHaveProperty("assigned_worker_ids");
    expect(row).not.toHaveProperty("latitude");
    expect(row).not.toHaveProperty("longitude");
  });
  it("uses an explicit fallback label when description is empty", () => {
    expect(jobCatalogRow(job("blank", { description: "" })).label).toBe("RA6 Test Customer #RA6-2");
  });
});

describe("Housecall unknown timestamp normalization", () => {
  it("includes a malformed provider timestamp for refresh and stores it as unknown", async () => {
    const db = database({
      lease_token: "lease_test",
      last_success_at: iso(-3600000),
      last_full_sync_at: iso(-86400000),
    });
    const listJobs = vi
      .fn()
      .mockResolvedValue(
        page([job("malformed", { updatedAt: "not-a-date", scheduledStart: "not-a-date" })]),
      );
    expect(await run(db, listJobs)).toMatchObject({ count: 1, scanned: 1, full: false });
    expect(finishCall(db)?.p_jobs).toEqual([
      expect.objectContaining({ id: "malformed", provider_updated_at: null, scheduled_at: null }),
    ]);
  });
});
