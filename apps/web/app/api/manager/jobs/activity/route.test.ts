import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({ access: vi.fn(), dashboard: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/jobs", () => ({ loadJobsDashboard: mocks.dashboard }));

import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
});

describe("streamed job activity", () => {
  it("denies access before fetching or streaming private job activity", async () => {
    mocks.access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Manager required"));
    expect((await GET(new Request("https://TEST.invalid/api/manager/jobs/activity"))).status).toBe(
      403,
    );
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });

  it("uses the authorized client and retains the existing JSON contract", async () => {
    const supabase = { TEST: "authorized client" };
    mocks.access.mockResolvedValue({ supabase });
    const data = { jobs: [{ name: "TEST job", hours: 12.5 }] };
    mocks.dashboard.mockResolvedValue(data);
    const response = await GET(new Request("https://TEST.invalid/api/manager/jobs/activity"));
    expect(mocks.dashboard).toHaveBeenCalledWith(supabase);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.has("content-length")).toBe(false);
    expect(await response.json()).toEqual(data);
  });
});
