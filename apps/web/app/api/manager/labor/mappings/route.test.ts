import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";
import { POST } from "./route";

const { access, dashboard, update } = vi.hoisted(() => ({
  access: vi.fn(),
  dashboard: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: access }));
vi.mock("@/lib/labor/store", () => ({
  loadLaborDashboard: dashboard,
  updateLaborJobMappings: update,
}));
const source = {
  sourceKey: '["TEST Customer","123 TEST Road"]',
  name: "TEST Customer",
  address: "123 TEST Road",
  jobCodes: [],
  fromDate: "2026-09-17",
  toDate: "2026-10-07",
  classification: "customer",
};
const job = {
  id: "TEST-HCP",
  customerId: "TEST-CUSTOMER",
  customer: source.name,
  number: "TEST-1",
  label: "TEST Job",
  address: source.address,
  status: "completed",
  scheduledAt: null,
  active: false,
  unavailable: false,
  syncedAt: new Date().toISOString(),
  providerUpdatedAt: null,
};
const mapping = {
  sourceKey: source.sourceKey,
  housecallJobId: job.id,
  fromDate: source.fromDate,
  toDate: source.toDate,
  method: "reviewed",
  confirmedAt: "UNTRUSTED",
  confirmedBy: "UNTRUSTED",
};
function request(mappings: unknown[] = [mapping], fingerprint = "TEST-FINGERPRINT") {
  return new Request("http://localhost/api/manager/labor/mappings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mappings, expectedRevision: 3, catalogFingerprint: fingerprint }),
  });
}
function data(overrides = {}) {
  return {
    jobMappings: [],
    mappingSources: [source],
    jobCatalog: { jobs: [job], complete: true, fingerprint: "TEST-FINGERPRINT" },
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  access.mockResolvedValue({ actor: { userId: "TEST-MANAGER" } });
  dashboard.mockResolvedValue(data());
  update.mockResolvedValue({ mappings: [], jobMappingsRevision: 4 });
});
describe("manager labor mapping confirmations", () => {
  it("authorizes before reading the catalog or saving anything", async () => {
    access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Forbidden"));
    expect((await POST(request())).status).toBe(403);
    expect(dashboard).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("passes manager identity, revision and verified catalog fingerprint to the guarded store", async () => {
    expect((await POST(request())).status).toBe(200);
    expect(update).toHaveBeenCalledWith([mapping], 3, "TEST-MANAGER", "TEST-FINGERPRINT");
  });
  it("refuses partial catalog and changed catalog fingerprints", async () => {
    dashboard.mockResolvedValue(
      data({ jobCatalog: { jobs: [job], complete: false, fingerprint: null } }),
    );
    expect((await POST(request())).status).toBe(503);
    expect(update).not.toHaveBeenCalled();
    dashboard.mockResolvedValue(data());
    expect((await POST(request([mapping], "OLD-FINGERPRINT"))).status).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });
  it("allows automatic method only after complete-catalog exact unique proof", async () => {
    expect((await POST(request([{ ...mapping, method: "exact_customer_address" }]))).status).toBe(
      200,
    );
    update.mockClear();
    dashboard.mockResolvedValue(
      data({
        jobCatalog: {
          jobs: [job, { ...job, id: "TEST-SECOND", unavailable: true }],
          complete: true,
          fingerprint: "TEST-FINGERPRINT",
        },
      }),
    );
    expect((await POST(request([{ ...mapping, method: "exact_customer_address" }]))).status).toBe(
      400,
    );
    expect(update).not.toHaveBeenCalled();
  });
  it("does not prevent explicit review of an ambiguous but eligible job", async () => {
    dashboard.mockResolvedValue(
      data({
        jobCatalog: {
          jobs: [job, { ...job, id: "TEST-SECOND" }],
          complete: true,
          fingerprint: "TEST-FINGERPRINT",
        },
      }),
    );
    expect((await POST(request())).status).toBe(200);
  });
  it("rejects stale, unavailable or noncustomer destinations", async () => {
    for (const changed of [
      { ...job, unavailable: true },
      { ...job, customerId: null },
      { ...job, syncedAt: "2020-01-01T00:00:00Z" },
    ]) {
      dashboard.mockResolvedValue(
        data({ jobCatalog: { jobs: [changed], complete: true, fingerprint: "TEST-FINGERPRINT" } }),
      );
      expect((await POST(request())).status).toBe(400);
    }
    dashboard.mockResolvedValue(
      data({ mappingSources: [{ ...source, classification: "supplier" }] }),
    );
    expect((await POST(request())).status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
  it("allows removal of old links even when the catalog is unavailable", async () => {
    dashboard.mockResolvedValue(
      data({
        jobMappings: [mapping],
        jobCatalog: { jobs: [], complete: false, fingerprint: null },
      }),
    );
    expect((await POST(request([]))).status).toBe(200);
    expect(update).toHaveBeenCalledWith([], 3, "TEST-MANAGER", undefined);
  });
});
