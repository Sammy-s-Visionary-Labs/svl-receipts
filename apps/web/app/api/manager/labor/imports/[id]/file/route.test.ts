import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";

const mocks = vi.hoisted(() => ({ access: vi.fn(), download: vi.fn() }));
vi.mock("@/lib/labor/access", () => ({ requireLaborAccess: mocks.access }));
vi.mock("@/lib/labor/store", () => ({ originalLaborDownload: mocks.download }));

import { GET } from "./route";

const id = "42000000-0000-4000-8000-000000000001";
const request = () => new Request(`https://TEST.invalid/api/manager/labor/imports/${id}/file`);
const context = () => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("private original downloads", () => {
  it("checks manager access before resolving any original or URL", async () => {
    mocks.access.mockRejectedValue(new AuthHttpError(403, "forbidden", "Manager required"));
    expect((await GET(request(), context())).status).toBe(403);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("redirects shared originals without proxying workbook bytes or caching the signed URL", async () => {
    const url = "https://storage.example.invalid/private/TEST.xlsx?token=TEST";
    mocks.download.mockResolvedValue({ url });
    const response = await GET(request(), context());
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(url);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toBe("");
  });

  it("retains the local workbook attachment and returns 404 for missing provenance", async () => {
    const bytes = new Uint8Array([80, 75, 3, 4]);
    mocks.download.mockResolvedValue({ bytes, filename: "TEST hours.xlsx" });
    const response = await GET(request(), context());
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-disposition")).toContain("TEST%20hours.xlsx");
    mocks.download.mockResolvedValue(null);
    expect((await GET(request(), context())).status).toBe(404);
  });
});
