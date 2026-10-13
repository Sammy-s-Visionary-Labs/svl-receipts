import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "./proxy";

const mocks = vi.hoisted(() => ({ updateSession: vi.fn() }));
vi.mock("./lib/supabase/proxy-session", () => ({ updateSession: mocks.updateSession }));
beforeEach(() => {
  vi.stubEnv("LABOR_ENABLED", "0");
  vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "0");
  vi.stubEnv("LABOR_LOCAL_PREVIEW", "0");
  mocks.updateSession.mockResolvedValue({ signedIn: false, supabaseResponse: NextResponse.next() });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("labor proxy isolation", () => {
  it("hides the new sections and API routes in production before any database access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    vi.stubEnv("LABOR_LOCAL_PREVIEW", "1");
    for (const path of [
      "/labor-hours",
      "/jobs",
      "/api/manager/labor/import",
      "/api/manager/jobs/activity",
    ]) {
      const response = await proxy(
        new NextRequest(`http://127.0.0.1:3145${path}`, {
          headers: { Authorization: "Bearer TEST-only" },
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it("keeps a loopback development preview independent of the receipt database", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    vi.stubEnv("LABOR_LOCAL_PREVIEW", "1");
    expect((await proxy(new NextRequest("http://127.0.0.1:3145/jobs"))).status).toBe(200);
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });
  it("reuses the existing hosted account session for enabled labor pages and APIs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LABOR_ENABLED", "1");
    const sessionResponse = NextResponse.next();
    sessionResponse.headers.set("TEST-session", "refreshed");
    mocks.updateSession.mockResolvedValue({ signedIn: true, supabaseResponse: sessionResponse });
    for (const path of [
      "/labor-hours",
      "/jobs",
      "/api/manager/labor/sync",
      "/api/manager/jobs/activity",
    ]) {
      expect(await proxy(new NextRequest(`https://receipts.example.test${path}`))).toBe(
        sessionResponse,
      );
    }
    expect(mocks.updateSession).toHaveBeenCalledTimes(4);
  });
  it("requires hosted authentication even when preview flags are copied", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LABOR_ENABLED", "1");
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    vi.stubEnv("LABOR_LOCAL_PREVIEW", "1");
    const page = await proxy(new NextRequest("https://receipts.example.test/labor-hours"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe(
      "https://receipts.example.test/login?next=%2Flabor-hours",
    );
    const api = await proxy(
      new NextRequest("https://receipts.example.test/api/manager/labor/sync"),
    );
    expect(api.status).toBe(401);
    vi.stubEnv("NODE_ENV", "development");
    expect((await proxy(new NextRequest("https://receipts.example.test/jobs"))).status).toBe(307);
    expect(mocks.updateSession).toHaveBeenCalledTimes(3);
  });
  it("passes API bearer authentication to route guards without granting page access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("LABOR_ENABLED", "1");
    const headers = { authorization: "Bearer TEST-route-guard-verifies" };
    expect(
      (
        await proxy(
          new NextRequest("https://receipts.example.test/api/manager/labor/sync", { headers }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await proxy(new NextRequest("https://receipts.example.test/labor-hours", { headers })))
        .status,
    ).toBe(307);
    expect(mocks.updateSession).toHaveBeenCalledTimes(2);
  });
});
