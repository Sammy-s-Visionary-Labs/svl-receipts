import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({ access: vi.fn(), list: vi.fn(), record: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/corrections", () => ({
  listLaborManualCorrections: mocks.list,
  recordLaborManualCorrection: mocks.record,
}));

import { GET, POST } from "./route";

const url = "https://TEST.invalid/api/manager/labor/corrections?approvalId=TEST-APPROVAL";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.access.mockResolvedValue({ actor: { userId: "TEST-MANAGER" } });
  mocks.list.mockResolvedValue({ corrections: [] });
  mocks.record.mockResolvedValue({ correction: { id: "TEST-CORRECTION" } });
});
describe("manual labor resolution manager boundary", () => {
  it("requires manager access before reading or writing correction evidence", async () => {
    mocks.access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Manager required"));
    expect((await GET(new Request(url))).status).toBe(403);
    expect((await POST(new Request(url, { method: "POST", body: "{}" }))).status).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("uses the authenticated actor and never caches correction details", async () => {
    const response = await GET(new Request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledWith("TEST-APPROVAL", "TEST-MANAGER");
    const body = { approvalId: "TEST-APPROVAL", actorId: "ATTACKER" };
    expect(
      (await POST(new Request(url, { method: "POST", body: JSON.stringify(body) }))).status,
    ).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(body, "TEST-MANAGER");
  });
  it("bounds evidence payload size before storage", async () => {
    const response = await POST(
      new Request(url, { method: "POST", body: JSON.stringify({ evidence: "a".repeat(49153) }) }),
    );
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it("accepts valid character limits even when Unicode uses multiple UTF-8 bytes", async () => {
    const body = {
      reason: "漢".repeat(2000),
      providerReference: "漢".repeat(500),
      evidence: "漢".repeat(4000),
    };
    expect(
      (await POST(new Request(url, { method: "POST", body: JSON.stringify(body) }))).status,
    ).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith(body, "TEST-MANAGER");
  });
});
