import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({
  requireWorker: vi.fn(),
  requireDevelopment: vi.fn(),
  isWorker: vi.fn(),
  poll: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/labor/access", () => ({
  requireLaborWorker: mocks.requireWorker,
  requireLaborDevelopment: mocks.requireDevelopment,
  isLaborWorker: mocks.isWorker,
}));
vi.mock("@/lib/labor/store", () => ({
  loadLaborWorkerPoll: mocks.poll,
  updateLaborWorker: mocks.update,
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireWorker.mockImplementation(() => {});
  mocks.requireDevelopment.mockImplementation(() => {});
  mocks.isWorker.mockReturnValue(true);
  mocks.poll.mockResolvedValue({ sync: { command: "run", enabled: false }, claimable: true });
});

describe("shared worker polling", () => {
  it("requires the private worker credential before reading the queue", async () => {
    mocks.requireWorker.mockImplementation(() => {
      throw new AuthHttpError(401, "unauthenticated", "Worker token required");
    });
    expect((await GET(new Request("https://TEST.invalid/api/worker"))).status).toBe(401);
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it("allows a read-only shared worker poll without enabling legacy heartbeat writes", async () => {
    mocks.requireDevelopment.mockImplementation(() => {
      throw new AuthHttpError(404, "not_found", "Not found");
    });
    const response = await GET(new Request("https://TEST.invalid/api/worker"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      sync: { command: "run", enabled: false },
      claimable: true,
    });
    const legacy = await POST(
      new Request("https://TEST.invalid/api/worker", {
        method: "POST",
        body: JSON.stringify({ status: "idle" }),
      }),
    );
    expect(legacy.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
