import { describe, expect, it } from "vitest";
import type { LaborSyncState } from "./contract";
import {
  assertWorkerLease,
  claimWorker,
  finishWorker,
  getClaimPeriod,
  heartbeatWorker,
  LABOR_WORKER_LEASE_MS,
  type LaborWorkerControlState,
  nextWorkerRun,
  recoverExpiredLaborLease,
  workerCalendar,
} from "./worker-control";

const ids = {
  commandId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  leaseToken: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
};
const now = new Date("2026-10-13T13:17:00Z");
function state(overrides: Partial<LaborSyncState> = {}): LaborWorkerControlState {
  return {
    sync: {
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
      ...overrides,
    },
  };
}

describe("hosted worker leases and calendar scheduling", () => {
  it("claims the last fourteen completed local dates and excludes the current date", () => {
    const value = state();
    expect(getClaimPeriod(value.sync, new Date("2026-10-13T01:00:00Z"))).toEqual({
      from: "2026-09-28",
      to: "2026-10-11",
    });
    const claim = claimWorker(value, "github:123:1", now, ids);
    expect(claim?.period).toEqual({ from: "2026-09-29", to: "2026-10-12" });
    expect(claim?.sync.status).toBe("running");
    expect(value.workerLease?.expiresAt).toBe(
      new Date(now.getTime() + LABOR_WORKER_LEASE_MS).toISOString(),
    );
    expect(value.workerLease?.imported).toBe(false);
  });

  it("gates automatic work by local hour, connection, pause, and one attempt per day", () => {
    for (const overrides of [
      { enabled: false },
      { status: "not_connected" as const },
      { status: "needs_login" as const },
      { command: "connect" as const },
      { hour: 10 },
    ])
      expect(claimWorker(state(overrides), "github:123:1", now, ids)).toBeNull();
    const value = state();
    expect(claimWorker(value, "github:123:1", now, ids)).not.toBeNull();
    finishWorker(
      value,
      ids.leaseToken,
      "failed",
      "Source unavailable",
      new Date(now.getTime() + 1000),
    );
    expect(claimWorker(value, "github:124:1", new Date(now.getTime() + 3600000), ids)).toBeNull();
    expect(
      claimWorker(value, "github:125:1", new Date("2026-10-14T13:17:00Z"), ids),
    ).not.toBeNull();
  });

  it("allows an explicitly queued manual run while paused and reuses its command ID", () => {
    const queued = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    const value = state({ enabled: false, hour: 23, command: "run", commandId: queued });
    value.lastScheduledDate = "2026-10-13";
    expect(claimWorker(value, "github:123:1", now, ids)?.commandId).toBe(queued);
    expect(value.workerLease?.commandId).toBe(queued);
    expect(claimWorker(value, "github:124:1", now, ids)).toBeNull();
  });

  it("computes the next hourly gate through daylight-saving changes", () => {
    const value = state({ hour: 2 });
    expect(nextWorkerRun(value, new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01T07:17:00.000Z");
    expect(workerCalendar(new Date("2026-11-01T04:00:00Z"), value.sync.timeZone)).toEqual({
      date: "2026-11-01",
      hour: 0,
    });
    value.lastScheduledDate = "2026-11-01";
    expect(nextWorkerRun(value, new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-02T07:17:00.000Z");
    expect(nextWorkerRun(state({ enabled: false }), now)).toBeNull();
    expect(nextWorkerRun(state({ status: "needs_login" }), now)).toBeNull();
  });

  it("extends only the current unexpired lease and refuses stale worker heartbeats", () => {
    const value = state();
    claimWorker(value, "github:123:1", now, ids);
    const later = new Date(now.getTime() + 60000);
    heartbeatWorker(value, ids.leaseToken, later);
    expect(value.workerLease?.expiresAt).toBe(
      new Date(later.getTime() + LABOR_WORKER_LEASE_MS).toISOString(),
    );
    expect(() => heartbeatWorker(value, ids.commandId, later)).toThrow("Stale worker lease");
    expect(() =>
      heartbeatWorker(value, ids.leaseToken, new Date(later.getTime() + LABOR_WORKER_LEASE_MS)),
    ).toThrow("Stale worker lease");
  });

  it("cannot finish successfully until the paired import has committed", () => {
    const value = state();
    claimWorker(value, "github:123:1", now, ids);
    expect(() => finishWorker(value, ids.leaseToken, "idle", null, now)).toThrow(
      "paired import commits",
    );
    expect(value.sync.lastSuccessAt).toBeNull();
    const lease = assertWorkerLease(value, ids.leaseToken, now);
    lease.imported = true;
    finishWorker(value, ids.leaseToken, "idle", null, now);
    expect(value.workerLease).toBeNull();
    expect(value.sync.commandId).toBeNull();
    expect(value.sync.lastSuccessAt).toBe(now.toISOString());
    expect(value.sync.nextRunAt).toBe("2026-10-14T13:17:00.000Z");
    expect(() => finishWorker(value, ids.leaseToken, "idle", null, now)).toThrow(
      "Stale worker lease",
    );
  });

  it("records a failed or disconnected run without falsely updating last success", () => {
    const prior = "2026-10-12T13:17:00.000Z";
    const value = state({ lastSuccessAt: prior });
    claimWorker(value, "github:123:1", now, ids);
    finishWorker(value, ids.leaseToken, "needs_login", "Reconnect Supercrew", now);
    expect(value.sync.lastSuccessAt).toBe(prior);
    expect(value.sync.status).toBe("needs_login");
    expect(value.sync.nextRunAt).toBeNull();
    expect(value.sync.lastError).toBe("Reconnect Supercrew");
  });

  it("recovers interrupted leases visibly without starting another automatic export that day", () => {
    for (const imported of [true, false]) {
      const value = state();
      claimWorker(value, "github:123:1", now, ids);
      if (value.workerLease) value.workerLease.imported = imported;
      const expired = new Date(now.getTime() + LABOR_WORKER_LEASE_MS);
      expect(recoverExpiredLaborLease(value, expired)).toBe(true);
      expect(value.sync.status).toBe("failed");
      expect(value.sync.lastSuccessAt).toBeNull();
      expect(value.sync.lastError).toContain(imported ? "after importing" : "before completing");
      expect(value.sync.command).toBeNull();
      expect(claimWorker(value, "github:124:1", expired, ids)).toBeNull();
      expect(recoverExpiredLaborLease(value, expired)).toBe(false);
    }
  });

  it("protects command identity and validates bounded run IDs and calendar configuration", () => {
    const value = state();
    expect(() => claimWorker(value, "unsafe\nrun", now, ids)).toThrow("run ID");
    expect(() => claimWorker(value, "valid", now, { ...ids, leaseToken: "secret" })).toThrow(
      "claim IDs",
    );
    expect(() => getClaimPeriod(state({ lookbackDays: 0 }).sync, now)).toThrow("lookback");
    expect(() => getClaimPeriod(state({ lookbackDays: 32 }).sync, now)).toThrow("lookback");
    claimWorker(value, "github:123:1", now, ids);
    value.sync.commandId = "cccccccc-cccc-4ccc-cccc-cccccccccccc";
    expect(() => assertWorkerLease(value, ids.leaseToken, now)).toThrow("Stale worker lease");
  });
});
