import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchLaborWorker } from "./dispatch";

const request = vi.fn<typeof fetch>();

beforeEach(() => {
  request.mockReset();
  vi.stubGlobal("fetch", request);
  vi.stubEnv("LABOR_GITHUB_DISPATCH_TOKEN", undefined);
  vi.stubEnv("LABOR_GITHUB_REPOSITORY", undefined);
  vi.stubEnv("LABOR_GITHUB_REF", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function configured() {
  vi.stubEnv("LABOR_GITHUB_DISPATCH_TOKEN", "TEST-DISPATCH-TOKEN");
  vi.stubEnv("LABOR_GITHUB_REPOSITORY", "test-owner/test-repository");
  vi.stubEnv("LABOR_GITHUB_REF", "codex/test-worker");
}

function noLaunchPromise(message: string) {
  expect(message).toContain("request saved");
  expect(message).toContain("running worker must check");
  expect(message).not.toMatch(/hourly|will start|shortly/i);
}

describe("optional Supercrew worker dispatch", () => {
  it("keeps an unconfigured request queued without claiming an hourly worker exists", async () => {
    const result = await dispatchLaborWorker();
    expect(result.dispatched).toBe(false);
    expect(result.message).toContain("No immediate worker trigger is configured");
    noLaunchPromise(result.message);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, "codex/test-worker"],
    ["invalid repository", "codex/test-worker"],
    ["test-owner/test-repository", "invalid ref!"],
  ])("does not attempt a malformed trigger (%s, %s)", async (repository, ref) => {
    configured();
    vi.stubEnv("LABOR_GITHUB_REPOSITORY", repository);
    vi.stubEnv("LABOR_GITHUB_REF", ref);
    const result = await dispatchLaborWorker();
    expect(result.dispatched).toBe(false);
    expect(result.message).toContain("needs configuration");
    noLaunchPromise(result.message);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports an accepted launch request without claiming the download has started", async () => {
    configured();
    request.mockResolvedValue(new Response(null, { status: 204 }));
    const result = await dispatchLaborWorker();
    expect(result.dispatched).toBe(true);
    expect(result.message).toContain("Worker launch requested");
    expect(result.message).not.toMatch(/will start|shortly|hourly/i);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(
      "https://api.github.com/repos/test-owner/test-repository/actions/workflows/supercrew-labor.yml/dispatches",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify({ ref: "codex/test-worker" }),
        headers: expect.objectContaining({ Authorization: "Bearer TEST-DISPATCH-TOKEN" }),
      }),
    );
  });

  it("leaves the request queued when the workflow endpoint rejects the launch", async () => {
    configured();
    request.mockResolvedValue(new Response(null, { status: 404 }));
    const result = await dispatchLaborWorker();
    expect(result.dispatched).toBe(false);
    expect(result.message).toContain("trigger is unavailable");
    noLaunchPromise(result.message);
  });

  it("leaves network failures queued and does not expose credential or provider details", async () => {
    configured();
    request.mockRejectedValue(new Error("TEST-DISPATCH-TOKEN private transport detail"));
    const result = await dispatchLaborWorker();
    expect(result.dispatched).toBe(false);
    noLaunchPromise(result.message);
    expect(JSON.stringify(result)).not.toMatch(/TEST-DISPATCH-TOKEN|private transport detail/);
  });
});
