import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({ access: vi.fn(), queue: vi.fn(), dispatch: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/store", () => ({ queueLaborSync: mocks.queue }));
vi.mock("@/lib/labor/dispatch", () => ({ dispatchLaborWorker: mocks.dispatch }));

import { POST } from "./route";

const request = (body: unknown) =>
  new Request("https://test.invalid/api/manager/labor/sync", {
    method: "POST",
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue({ actor: { userId: "manager-id" } });
  mocks.queue.mockResolvedValue({ enabled: false, intervalDays: 7 });
  mocks.dispatch.mockResolvedValue({ status: "dispatched" });
});

describe("labor recurrence configuration", () => {
  it("requires manager access before reading or changing settings", async () => {
    mocks.access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Manager required"));
    expect((await POST(request({ action: "configure", intervalDays: 7 }))).status).toBe(403);
    expect(mocks.queue).not.toHaveBeenCalled();
  });

  it.each([1, 7, 14, 45, 365])(
    "saves %s-day recurrence without resuming or dispatching",
    async (intervalDays) => {
      const response = await POST(
        request({ action: "configure", intervalDays, hour: 9, lookbackDays: 14 }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(mocks.queue).toHaveBeenCalledWith(
        "configure",
        { intervalDays, hour: 9, lookbackDays: 14 },
        "manager-id",
      );
      expect(mocks.dispatch).not.toHaveBeenCalled();
      expect(await response.json()).toEqual({ sync: { enabled: false, intervalDays: 7 } });
    },
  );

  it.each([0, 366, 1.1, "7", null])(
    "rejects invalid interval %s before writing",
    async (intervalDays) => {
      const response = await POST(request({ action: "configure", intervalDays }));
      expect(response.status).toBe(400);
      expect(mocks.queue).not.toHaveBeenCalled();
      expect(mocks.dispatch).not.toHaveBeenCalled();
    },
  );

  it("does not replace omitted settings on legacy manual requests", async () => {
    const response = await POST(request({ action: "run" }));
    expect(response.status).toBe(200);
    expect(mocks.queue).toHaveBeenCalledWith(
      "run",
      { intervalDays: undefined, hour: undefined, lookbackDays: undefined },
      "manager-id",
    );
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
});
