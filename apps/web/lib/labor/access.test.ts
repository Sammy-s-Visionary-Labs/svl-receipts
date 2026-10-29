import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError } from "@/lib/auth/guards";
import {
  getLaborPageActor,
  isLaborWorker,
  requireLaborAccess,
  requireLaborDevelopment,
  requireLaborWorker,
} from "./access";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  cookieActor: vi.fn(),
  requireManager: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/auth/guards", () => ({
  AuthHttpError: class extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
  getActorFromCookies: mocks.cookieActor,
  requireManager: mocks.requireManager,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LABOR_ENABLED", "1");
  vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "0");
  vi.stubEnv("LABOR_LOCAL_PREVIEW", "0");
  mocks.headers.mockResolvedValue(new Headers({ host: "receipts.example.test" }));
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`redirect:${path}`);
  });
  mocks.notFound.mockImplementation(() => {
    throw new Error("not found");
  });
});
afterEach(() => vi.unstubAllEnvs());
describe("development labor access", () => {
  it("accepts actual loopback browser origins when Next uses a canonical localhost URL", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    const request = (origin: string) =>
      new Request("http://localhost:3145/api/manager/labor/sync", {
        headers: { host: "127.0.0.1:3145", origin },
      });
    expect(() => requireLaborDevelopment(request("http://127.0.0.1:3145"))).not.toThrow();
    expect(() => requireLaborDevelopment(request("https://external.test"))).toThrow("Same-origin");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => requireLaborDevelopment(request("http://127.0.0.1:3145"))).toThrow("Not found");
  });
  it("rejects missing, short and differently encoded worker tokens", () => {
    vi.stubEnv("LABOR_WORKER_TOKEN", "a".repeat(32));
    const request = (token: string) =>
      new Request("http://127.0.0.1:3145/test", { headers: { authorization: `Bearer ${token}` } });
    expect(isLaborWorker(request("a".repeat(32)))).toBe(true);
    expect(isLaborWorker(request("a".repeat(31)))).toBe(false);
    expect(isLaborWorker(request("é".repeat(32)))).toBe(false);
    vi.stubEnv("LABOR_WORKER_TOKEN", "a".repeat(24));
    expect(isLaborWorker(request("a".repeat(24)))).toBe(false);
  });
});

describe("hosted labor access", () => {
  const actor = { userId: "TEST-existing-manager", role: "manager" as const, disabled: false };
  const request = (options: RequestInit = {}) =>
    new Request("https://receipts.example.test/api/manager/labor/sync", options);

  it("uses the existing manager account guard in production", async () => {
    mocks.requireManager.mockResolvedValue({ actor, supabase: "TEST-client" });
    const incoming = request();
    expect(await requireLaborAccess(incoming)).toEqual({
      actor,
      supabase: "TEST-client",
      worker: false,
    });
    expect(mocks.requireManager).toHaveBeenCalledWith(incoming, "/api/manager/labor/sync");
  });

  it.each([
    [401, "account_inactive", "Account is not active"],
    [403, "forbidden", "Manager role required"],
  ])(
    "preserves the existing guard's %s denial for inactive accounts and workers",
    async (status, code, message) => {
      mocks.requireManager.mockRejectedValue(
        new AuthHttpError(Number(status), String(code), String(message)),
      );
      await expect(requireLaborAccess(request())).rejects.toMatchObject({ status, code });
    },
  );

  it("copied preview flags cannot bypass production or hosted development authentication", async () => {
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    vi.stubEnv("LABOR_LOCAL_PREVIEW", "1");
    mocks.requireManager.mockRejectedValue(
      new AuthHttpError(401, "unauthenticated", "Sign in required"),
    );
    await expect(
      requireLaborAccess(new Request("http://127.0.0.1:3145/api/manager/labor/sync")),
    ).rejects.toMatchObject({ status: 401 });
    vi.stubEnv("NODE_ENV", "development");
    await expect(requireLaborAccess(request())).rejects.toMatchObject({ status: 401 });
    vi.stubEnv("LABOR_PERSISTENCE", "supabase");
    await expect(
      requireLaborAccess(new Request("http://127.0.0.1:3145/api/manager/labor/sync")),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.requireManager).toHaveBeenCalledTimes(3);
  });

  it("requires same-origin cookie mutations before calling the account guard", async () => {
    for (const origin of [undefined, "https://external.example.test"]) {
      await expect(
        requireLaborAccess(request({ method: "POST", headers: origin ? { origin } : {} })),
      ).rejects.toMatchObject({ status: 403, code: "invalid_origin" });
    }
    expect(mocks.requireManager).not.toHaveBeenCalled();
    mocks.requireManager.mockResolvedValue({ actor, supabase: "TEST-client" });
    expect(
      (
        await requireLaborAccess(
          request({ method: "POST", headers: { origin: "https://receipts.example.test" } }),
        )
      ).actor,
    ).toEqual(actor);
  });

  it("authenticates workers only on explicitly allowed worker endpoints", async () => {
    vi.stubEnv("LABOR_WORKER_TOKEN", "a".repeat(32));
    const workerRequest = request({
      method: "POST",
      headers: { authorization: `Bearer ${"a".repeat(32)}` },
    });
    expect(await requireLaborAccess(workerRequest, true)).toEqual({
      actor: null,
      supabase: null,
      worker: true,
    });
    expect(mocks.requireManager).not.toHaveBeenCalled();
    mocks.requireManager.mockRejectedValue(
      new AuthHttpError(401, "unauthenticated", "Sign in required"),
    );
    await expect(requireLaborAccess(workerRequest)).rejects.toMatchObject({ status: 401 });
    expect(() => requireLaborWorker(workerRequest)).not.toThrow();
    expect(() => requireLaborWorker(request())).toThrow("Worker token required");
  });

  it("keeps disabled features hidden even from managers and worker tokens", async () => {
    vi.stubEnv("LABOR_ENABLED", "0");
    vi.stubEnv("LABOR_WORKER_TOKEN", "a".repeat(32));
    const incoming = request({ headers: { authorization: `Bearer ${"a".repeat(32)}` } });
    await expect(requireLaborAccess(incoming, true)).rejects.toMatchObject({ status: 404 });
    expect(() => requireLaborWorker(incoming)).toThrow("Not found");
    expect(mocks.requireManager).not.toHaveBeenCalled();
  });
});

describe("labor page accounts", () => {
  it.each(["manager", "admin"])("accepts an existing active %s account", async (role) => {
    const actor = { userId: "TEST-existing-account", role, disabled: false };
    mocks.cookieActor.mockResolvedValue(actor);
    expect(await getLaborPageActor()).toEqual(actor);
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("redirects inactive or missing accounts to login and workers to their field app", async () => {
    // The shared account guard returns null for a disabled profile.
    mocks.cookieActor.mockResolvedValue(null);
    await expect(getLaborPageActor()).rejects.toThrow("redirect:/login");
    mocks.cookieActor.mockResolvedValue({ userId: "TEST-worker", role: "worker", disabled: false });
    await expect(getLaborPageActor()).rejects.toThrow("redirect:/field");
  });

  it("does not turn copied preview flags into a production page account", async () => {
    vi.stubEnv("LABOR_DEVELOPMENT_ENABLED", "1");
    vi.stubEnv("LABOR_LOCAL_PREVIEW", "1");
    mocks.headers.mockResolvedValue(new Headers({ host: "127.0.0.1:3145" }));
    mocks.cookieActor.mockResolvedValue(null);
    await expect(getLaborPageActor()).rejects.toThrow("redirect:/login");
    expect(mocks.cookieActor).toHaveBeenCalledOnce();
  });
});
