import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireLaborWorker } from "@/lib/labor/access";
import type { LaborSyncState } from "@/lib/labor/contract";
import {
  getSupabaseLaborEncryptedWorkerSession,
  putSupabaseLaborEncryptedWorkerSession,
} from "@/lib/labor/persistence";
import {
  assertLaborWorkerLease,
  beginLaborWorkerConnection,
  claimLaborWorker,
  finishLaborWorker,
  heartbeatLaborWorker,
  markLaborWorkerConnected,
} from "@/lib/labor/store";
import { POST as claim } from "../claim/route";
import { POST as finish } from "../finish/route";
import { POST as heartbeat } from "../heartbeat/route";
import { GET, PUT } from "./route";

vi.mock("@/lib/labor/access", () => ({ requireLaborWorker: vi.fn() }));
vi.mock("@/lib/auth/guards", () => ({
  AuthHttpError: class extends Error {},
  authErrorResponse: vi.fn(),
}));
vi.mock("@/lib/labor/store", () => ({
  assertLaborWorkerLease: vi.fn(),
  beginLaborWorkerConnection: vi.fn(),
  markLaborWorkerConnected: vi.fn(),
  claimLaborWorker: vi.fn(),
  heartbeatLaborWorker: vi.fn(),
  finishLaborWorker: vi.fn(),
}));
vi.mock("@/lib/labor/persistence", () => ({
  getSupabaseLaborEncryptedWorkerSession: vi.fn(),
  putSupabaseLaborEncryptedWorkerSession: vi.fn(),
}));

const encrypted = Buffer.concat([
  Buffer.from("SVLSESSION1\n"),
  Buffer.alloc(28),
  Buffer.from("synthetic cipher"),
]);
const token = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const sync: LaborSyncState = {
  enabled: true,
  hour: 9,
  timeZone: "America/New_York",
  lookbackDays: 14,
  status: "idle",
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextRunAt: null,
  lastError: null,
  workerHeartbeatAt: null,
  command: null,
  commandId: null,
};
function binary(body: BodyInit = encrypted, headers: Record<string, string> = {}) {
  return new Request("https://fixture.example/api/manager/labor/worker/session", {
    method: "PUT",
    body,
    headers: {
      "content-type": "application/octet-stream",
      "x-labor-session-version": "2",
      ...headers,
    },
  });
}
function json(body: unknown) {
  return new Request("https://fixture.example/api/manager/labor/worker/control", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireLaborWorker).mockImplementation(() => {});
  vi.mocked(assertLaborWorkerLease).mockResolvedValue({
    commandId: token,
    leaseToken: token,
    runId: "fixture",
    period: { from: "2026-10-01", to: "2026-10-02" },
    claimedAt: "2026-10-03T13:00:00Z",
    expiresAt: "2026-10-03T13:15:00Z",
    imported: true,
  });
  vi.mocked(beginLaborWorkerConnection).mockResolvedValue(sync);
  vi.mocked(markLaborWorkerConnected).mockResolvedValue(sync);
  vi.mocked(putSupabaseLaborEncryptedWorkerSession).mockResolvedValue(3);
});

describe("dedicated hosted worker routes", () => {
  it("requires the dedicated worker credential before reading, writing, or claiming anything", async () => {
    vi.mocked(requireLaborWorker).mockImplementation(() => {
      throw new Error("Worker token required");
    });
    for (const response of [
      await GET(new Request("https://fixture.example/session")),
      await PUT(binary()),
      await claim(json({ runId: "valid" })),
      await heartbeat(json({ leaseToken: token, status: "running" })),
      await finish(json({ leaseToken: token, status: "idle" })),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { message: "Worker token required" } });
    }
    expect(getSupabaseLaborEncryptedWorkerSession).not.toHaveBeenCalled();
    expect(putSupabaseLaborEncryptedWorkerSession).not.toHaveBeenCalled();
    expect(claimLaborWorker).not.toHaveBeenCalled();
    expect(heartbeatLaborWorker).not.toHaveBeenCalled();
    expect(finishLaborWorker).not.toHaveBeenCalled();
  });

  it("returns only encrypted bytes with a private version and distinguishes missing connections", async () => {
    vi.mocked(getSupabaseLaborEncryptedWorkerSession).mockResolvedValue(null);
    expect((await GET(new Request("https://fixture.example/session"))).status).toBe(404);
    vi.mocked(getSupabaseLaborEncryptedWorkerSession).mockResolvedValue({
      bytes: encrypted,
      version: 2,
    });
    const response = await GET(new Request("https://fixture.example/session"));
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-labor-session-version")).toBe("2");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(encrypted);
  });

  it("fences run session refresh by the active lease and expected session version", async () => {
    const response = await PUT(binary(encrypted, { "x-labor-lease-token": token }));
    expect(response.status).toBe(204);
    expect(response.headers.get("x-labor-session-version")).toBe("3");
    expect(assertLaborWorkerLease).toHaveBeenCalledTimes(3);
    expect(assertLaborWorkerLease).toHaveBeenCalledWith(token);
    expect(putSupabaseLaborEncryptedWorkerSession).toHaveBeenCalledWith(encrypted, 2, token);
    expect(beginLaborWorkerConnection).not.toHaveBeenCalled();
    expect(markLaborWorkerConnected).not.toHaveBeenCalled();
  });

  it("places a durable bootstrap barrier before publishing and marks connected only after CAS", async () => {
    expect((await PUT(binary())).status).toBe(204);
    const started = vi.mocked(beginLaborWorkerConnection).mock.invocationCallOrder[0];
    const saved = vi.mocked(putSupabaseLaborEncryptedWorkerSession).mock.invocationCallOrder[0];
    const connected = vi.mocked(markLaborWorkerConnected).mock.invocationCallOrder[0];
    expect(started).toBeLessThan(saved);
    expect(saved).toBeLessThan(connected);
    expect(putSupabaseLaborEncryptedWorkerSession).toHaveBeenCalledWith(encrypted, 2, null);
    vi.clearAllMocks();
    vi.mocked(putSupabaseLaborEncryptedWorkerSession).mockResolvedValue(null);
    expect((await PUT(binary())).status).toBe(409);
    expect(markLaborWorkerConnected).not.toHaveBeenCalled();
  });

  it("rejects a stale lease before storage and refuses a bootstrap while a run is active", async () => {
    vi.mocked(assertLaborWorkerLease).mockRejectedValue(new Error("Stale worker lease"));
    expect((await PUT(binary(encrypted, { "x-labor-lease-token": token }))).status).toBe(409);
    expect(putSupabaseLaborEncryptedWorkerSession).not.toHaveBeenCalled();
    vi.mocked(beginLaborWorkerConnection).mockRejectedValue(new Error("Worker busy"));
    expect((await PUT(binary())).status).toBe(409);
    expect(putSupabaseLaborEncryptedWorkerSession).not.toHaveBeenCalled();
  });

  it("bounds both declared and streamed bodies and rejects plaintext or unversioned writes", async () => {
    const invalid = [
      binary(encrypted, { "content-length": "1048577" }),
      binary(Buffer.alloc(1048577)),
      binary(encrypted, { "x-labor-session-version": "" }),
      binary(encrypted, { "x-labor-session-version": "9007199254740992" }),
      binary(encrypted, { "content-type": "application/json" }),
      binary(Buffer.from('{"cookies":[]}')),
    ];
    for (const request of invalid) expect((await PUT(request)).status).toBe(400);
    expect(putSupabaseLaborEncryptedWorkerSession).not.toHaveBeenCalled();
    expect(beginLaborWorkerConnection).not.toHaveBeenCalled();
  });

  it("validates bounded control inputs and leaves state changes to transactional wrappers", async () => {
    vi.mocked(claimLaborWorker).mockResolvedValue(null);
    expect(await (await claim(json({ runId: "github:123:1" }))).json()).toEqual({ claim: null });
    expect(claimLaborWorker).toHaveBeenCalledWith("github:123:1");
    expect((await claim(json({ runId: "bad\nrun" }))).status).toBe(400);
    expect((await heartbeat(json({ leaseToken: token, status: "idle" }))).status).toBe(400);
    expect(
      (await finish(json({ leaseToken: token, status: "idle", lastError: "x".repeat(501) })))
        .status,
    ).toBe(400);
    await heartbeat(json({ leaseToken: token, status: "running" }));
    expect(heartbeatLaborWorker).toHaveBeenCalledWith(token);
    await finish(json({ leaseToken: token, status: "failed", lastError: "Source unavailable" }));
    expect(finishLaborWorker).toHaveBeenCalledWith(token, "failed", "Source unavailable");
  });
});
