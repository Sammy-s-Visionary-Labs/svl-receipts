import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({ access: vi.fn(), dashboard: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/store", () => ({ loadLaborDashboard: mocks.dashboard }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("streamed labor dashboard", () => {
  it("authorizes before loading any private hours or opening a stream", async () => {
    mocks.access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Manager required"));
    const response = await GET(new Request("https://TEST.invalid/api/manager/labor"));
    expect(response.status).toBe(403);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it("preserves the JSON contract and streams large authorized snapshots", async () => {
    const data = { entries: [{ jobName: "TEST ".repeat(1_000_000) }], imports: [] };
    mocks.dashboard.mockResolvedValue(data);
    const response = await GET(new Request("https://TEST.invalid/api/manager/labor"));
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("content-length")).toBe(false);
    if (!response.body) throw new Error("Missing response stream");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
    await reader.cancel();
    const complete = await GET(new Request("https://TEST.invalid/api/manager/labor"));
    expect(await complete.json()).toEqual(data);
  });

  it("streams CSV while retaining attachment naming and spreadsheet-formula escaping", async () => {
    mocks.dashboard.mockResolvedValue({
      entries: [
        {
          date: "2026-10-29",
          workerName: "TEST worker",
          jobName: "=TEST formula",
          jobAddress: "TEST address",
          hours: 1,
          travel: false,
          laborCostCents: 2500,
          importId: "TEST import",
          sourceRow: 13,
        },
      ],
    });
    const response = await GET(new Request("https://TEST.invalid/api/manager/labor?format=csv"));
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("supercrew-hours");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain('"\'=TEST formula"');
  });
});
