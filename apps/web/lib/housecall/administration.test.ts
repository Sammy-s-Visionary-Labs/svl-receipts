import { createHousecallClient, HousecallError } from "@svl/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as employeeMapping } from "@/app/api/admin/housecall/employee-mappings/route";
import { GET as health } from "@/app/api/admin/housecall/health/route";
import { POST as sync } from "@/app/api/admin/housecall/sync/route";
import { GET as cron } from "@/app/api/cron/housecall/route";
import { POST as reconcile } from "@/app/api/manager/receipts/[id]/export-reconcile/route";
import { AuthHttpError, requireAdmin, requireManager } from "@/lib/auth/guards";
import { runApprovedHousecallExports, runReceiptHousecallExport } from "@/lib/housecall/export";
import { syncHousecallJobs } from "@/lib/housecall/jobs";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { housecallConfiguration } from "./config";

vi.mock("@svl/integrations", async (original) => ({
  ...(await original<typeof import("@svl/integrations")>()),
  createHousecallClient: vi.fn(),
}));
vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireAdmin: vi.fn(),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/housecall/jobs", () => ({ syncHousecallJobs: vi.fn() }));
vi.mock("@/lib/housecall/export", () => ({
  runApprovedHousecallExports: vi.fn(),
  runReceiptHousecallExport: vi.fn(),
}));
const actorId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const receiptId = "33333333-3333-4333-8333-333333333333";
const context = { params: Promise.resolve({ id: receiptId }) };
const request = (body: unknown = {}) =>
  new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const rpc = vi.fn();
const checkHealth = vi.fn();
const from = vi.fn();
let receipt: Record<string, unknown> | null;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOUSECALL_READS_ENABLED", "false");
  vi.stubEnv("HOUSECALL_EXPORT_MODE", "disabled");
  vi.stubEnv("HOUSECALL_TEST_JOB_IDS", "");
  vi.stubEnv("HOUSECALL_API_KEY", "");
  vi.stubEnv("CRON_SECRET", "synthetic-ra6-cron-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network forbidden in tests");
    }),
  );
  receipt = {
    id: receiptId,
    submitted_at: "2026-09-09T12:00:00Z",
    content_deleted_at: null,
    purge_claimed_at: null,
  };
  from.mockImplementation(() => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: receipt, error: null }),
    };
    return query;
  });
  const auth = { actor: { userId: actorId, role: "admin", disabled: false }, supabase: { from } };
  vi.mocked(requireAdmin).mockResolvedValue(
    auth as unknown as Awaited<ReturnType<typeof requireAdmin>>,
  );
  vi.mocked(requireManager).mockResolvedValue(
    auth as unknown as Awaited<ReturnType<typeof requireManager>>,
  );
  rpc.mockResolvedValue({ data: null, error: null });
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as unknown as ReturnType<
    typeof createServiceRoleClient
  >);
  checkHealth.mockResolvedValue({ connected: true, writesEnabled: false });
  vi.mocked(createHousecallClient).mockReturnValue({ checkHealth } as unknown as ReturnType<
    typeof createHousecallClient
  >);
  vi.mocked(syncHousecallJobs).mockResolvedValue({ count: 0, skipped: "reads_disabled" });
  vi.mocked(runApprovedHousecallExports).mockResolvedValue({ completed: 0, unresolved: 0 });
  vi.mocked(runReceiptHousecallExport).mockResolvedValue({ completed: 0, unresolved: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Housecall server configuration", () => {
  it("defaults to disabled and never returns a secret", () => {
    const result = housecallConfiguration({
      NODE_ENV: "test",
      HOUSECALL_API_KEY: "synthetic-secret",
    });
    expect(result).toMatchObject({
      configured: true,
      readsEnabled: false,
      exportsEnabled: false,
      mode: "disabled",
    });
    expect(result.allowedJobIds.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  it.each([
    {},
    { HOUSECALL_READS_ENABLED: "true" },
    { HOUSECALL_READS_ENABLED: "true", HOUSECALL_EXPORT_MODE: "approved_test" },
    {
      HOUSECALL_READS_ENABLED: "true",
      HOUSECALL_EXPORT_MODE: "production",
      HOUSECALL_TEST_JOB_IDS: "job_test_2",
    },
    {
      HOUSECALL_READS_ENABLED: "TRUE",
      HOUSECALL_EXPORT_MODE: "approved_test",
      HOUSECALL_TEST_JOB_IDS: "job_test_2",
    },
    {
      HOUSECALL_READS_ENABLED: "true",
      HOUSECALL_EXPORT_MODE: "approved_test",
      HOUSECALL_TEST_JOB_IDS: "../jobs/real",
    },
    {
      HOUSECALL_READS_ENABLED: "true",
      HOUSECALL_EXPORT_MODE: "approved_test",
      HOUSECALL_TEST_JOB_IDS: Array.from({ length: 21 }, (_, i) => `job_${i}`).join(","),
    },
  ])("fails closed when settings are missing, broad, or malformed %o", (env) => {
    expect(housecallConfiguration({ NODE_ENV: "test", ...env }).exportsEnabled).toBe(false);
  });
  it("permits only the exact bounded test-job set configured on the server", () => {
    const result = housecallConfiguration({
      NODE_ENV: "test",
      HOUSECALL_READS_ENABLED: "true",
      HOUSECALL_EXPORT_MODE: "approved_test",
      HOUSECALL_TEST_JOB_IDS: " job_test_2, job_test_3 ",
    });
    expect(result.exportsEnabled).toBe(true);
    expect([...result.allowedJobIds]).toEqual(["job_test_2", "job_test_3"]);
    expect(result.allowedJobIds.has("Test Customer 2")).toBe(false);
  });
});

describe("Housecall administration authorization", () => {
  it.each([401, 403])(
    "denies non-admin requests before any provider or service-role client (%s)",
    async (status) => {
      vi.mocked(requireAdmin).mockRejectedValue(
        new AuthHttpError(status, "forbidden", "Admin required"),
      );
      expect((await health(new Request("http://localhost/api/health"))).status).toBe(status);
      expect((await sync(request())).status).toBe(status);
      expect((await employeeMapping(request({ employeeId: "employee_test", userId }))).status).toBe(
        status,
      );
      expect(createHousecallClient).not.toHaveBeenCalled();
      expect(syncHousecallJobs).not.toHaveBeenCalled();
      expect(createServiceRoleClient).not.toHaveBeenCalled();
      expect(rpc).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it("reports disabled reads without a provider request even if a server key exists", async () => {
    vi.stubEnv("HOUSECALL_API_KEY", "synthetic-private-key");
    const response = await health(
      new Request("http://localhost/api/health?readsEnabled=true&exportMode=approved_test"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      configured: true,
      readsEnabled: false,
      connected: false,
      requiresExplicitWriteApproval: true,
    });
    expect(JSON.stringify(body)).not.toContain("synthetic-private-key");
    expect(createHousecallClient).not.toHaveBeenCalled();
  });
  it("missing credentials do not trigger a connection attempt", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    const response = await health(new Request("http://localhost/api/health"));
    expect(await response.json()).toMatchObject({ configured: false, connected: false });
    expect(createHousecallClient).not.toHaveBeenCalled();
  });
  it("health checks use only the read-only provider method and expose no API key", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_API_KEY", "synthetic-private-key");
    const response = await health(new Request("http://localhost/api/health"));
    const body = await response.json();
    expect(body).toMatchObject({ connected: true, requiresExplicitWriteApproval: true });
    expect(checkHealth).toHaveBeenCalledTimes(1);
    expect(createHousecallClient).toHaveBeenCalledWith({
      apiKey: "synthetic-private-key",
      timeoutMs: 10000,
      allowedWriteJobIds: [],
      allowedReadJobIds: [],
      allowedReadCustomerIds: [],
    });
    expect(JSON.stringify(body)).not.toContain("synthetic-private-key");
  });
  it.each([
    { error: new HousecallError("authentication", 401), code: "authentication" },
    {
      error: new Error("synthetic-private-key provider returned confidential response"),
      code: "connection_failed",
    },
  ])("redacts connection failures to a safe error code $code", async ({ error, code }) => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_API_KEY", "synthetic-private-key");
    checkHealth.mockRejectedValue(error);
    const response = await health(new Request("http://localhost/api/health"));
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ connected: false, error: code });
    expect(JSON.stringify(body)).not.toMatch(/synthetic-private-key|confidential/);
  });
  it("admin synchronization ignores client write switches and invokes a full read-only scan", async () => {
    const response = await sync(
      request({ full: false, enableWrites: true, allowedJobIds: ["real_business_job"] }),
    );
    expect(response.status).toBe(200);
    expect(syncHousecallJobs).toHaveBeenCalledWith({ full: true });
    expect(runApprovedHousecallExports).not.toHaveBeenCalled();
    expect(runReceiptHousecallExport).not.toHaveBeenCalled();
    expect(createHousecallClient).not.toHaveBeenCalled();
  });
});

describe("Housecall employee mapping authority", () => {
  it("uses the authenticated admin identity and ignores a supplied actor ID", async () => {
    const response = await employeeMapping(
      request({ employeeId: "employee_test", userId, actorId: "spoofed_actor" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(rpc).toHaveBeenCalledWith("configure_housecall_employee_mapping", {
      p_actor_id: actorId,
      p_employee_id: "employee_test",
      p_user_id: userId,
    });
    expect(createHousecallClient).not.toHaveBeenCalled();
  });
  it.each([
    { employeeId: "../employees/real" },
    { employeeId: "" },
    { employeeId: "x".repeat(161) },
    { userId: "not-a-uuid" },
    { userId: null },
  ])("validates the exact employee/app-user identifiers %o", async (change) => {
    expect(
      (await employeeMapping(request({ employeeId: "employee_test", userId, ...change }))).status,
    ).toBe(400);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
  it("respects database rejection without exposing database error detail", async () => {
    rpc.mockResolvedValue({ error: { message: "forbidden synthetic confidential DB text" } });
    const response = await employeeMapping(request({ employeeId: "employee_test", userId }));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("confidential");
  });
});

describe("Housecall reconciliation route is authorized and read only", () => {
  it("denies workers before looking up content or calling an exporter", async () => {
    vi.mocked(requireManager).mockRejectedValue(
      new AuthHttpError(403, "forbidden", "Manager required"),
    );
    expect((await reconcile(request(), context)).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(runReceiptHousecallExport).not.toHaveBeenCalled();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { submitted_at: null },
    { submitted_at: "now", content_deleted_at: "now" },
    { submitted_at: "now", purge_claimed_at: "now" },
  ])("does not reconcile missing or purged receipt content %o", async (row) => {
    receipt = row;
    expect((await reconcile(request(), context)).status).toBe(404);
    expect(runReceiptHousecallExport).not.toHaveBeenCalled();
  });
  it("forces reconciliation-only mode even when a request asks to write", async () => {
    const response = await reconcile(
      request({ reconcileOnly: false, enableWrites: true, approvalId: "fake" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(runReceiptHousecallExport).toHaveBeenCalledWith(receiptId, { reconcileOnly: true });
  });
});

describe("Housecall scheduler authentication", () => {
  it.each([undefined, "Bearer wrong-secret"])(
    "blocks untrusted cron requests before sync or export",
    async (authorization) => {
      const response = await cron(
        new Request("http://localhost/api/cron/housecall", {
          headers: authorization ? { authorization } : {},
        }),
      );
      expect(response.status).toBe(401);
      expect(syncHousecallJobs).not.toHaveBeenCalled();
      expect(runApprovedHousecallExports).not.toHaveBeenCalled();
    },
  );
  it("passes bounded time budgets after validating the exact cron secret", async () => {
    const response = await cron(
      new Request("http://localhost/api/cron/housecall", {
        headers: { authorization: "Bearer synthetic-ra6-cron-secret" },
      }),
    );
    expect(response.status).toBe(200);
    const syncInput = vi.mocked(syncHousecallJobs).mock.calls[0]?.[0];
    const exportInput = vi.mocked(runApprovedHousecallExports).mock.calls[0]?.[0];
    expect(syncInput?.deadlineAt).toEqual(expect.any(Number));
    expect((exportInput?.deadlineAt ?? 0) - (syncInput?.deadlineAt ?? 0)).toBe(55000);
  });
});

it("retains safe health history and records classified failures", async () => {
  vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
  vi.stubEnv("HOUSECALL_API_KEY", "synthetic-private-key");
  rpc.mockResolvedValue({
    data: { lastSuccessfulCheckAt: "2026-09-10T12:00:00Z", lastError: "authentication" },
    error: null,
  });
  checkHealth.mockRejectedValue(new HousecallError("authentication", 401));
  const response = await health(new Request("http://localhost/health"));
  expect(await response.json()).toMatchObject({
    lastSuccessfulCheckAt: "2026-09-10T12:00:00Z",
    lastError: "authentication",
  });
  expect(rpc).toHaveBeenCalledWith("housecall_health_status", {
    p_connected: false,
    p_error: "authentication",
  });
});
