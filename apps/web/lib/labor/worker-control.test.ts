import { describe, expect, it } from "vitest";
import type { LaborSyncState } from "./contract";
import {
  assertWorkerLease,
  claimWorker,
  finishWorker,
  getClaimPeriod,
  heartbeatWorker,
  LABOR_WORKER_LEASE_MS,
  LABOR_WORKER_RECOVERY_DELAY_MS,
  type LaborWorkerControlState,
  nextWorkerRun,
  recoverExpiredLaborLease,
  workerCalendar,
  workerClaimAvailable,
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

  it.each([
    [undefined, "2026-10-14T13:17:00.000Z"],
    [7, "2026-10-20T13:17:00.000Z"],
    [14, "2026-10-27T13:17:00.000Z"],
    [45, "2026-11-27T14:17:00.000Z"],
    [365, "2027-10-13T13:17:00.000Z"],
  ])("uses a %s-day calendar interval from the latest attempt", (intervalDays, expected) => {
    const value = state({ intervalDays, lastSuccessAt: "2026-10-12T13:17:00Z" });
    value.lastScheduledDate = "2026-10-13";
    expect(nextWorkerRun(value, now)).toBe(expected);
    expect(workerClaimAvailable(value, now)).toBe(false);
    expect(workerClaimAvailable(value, new Date(expected))).toBe(true);
  });

  it("retains overdue gates and catches up before today's configured hour", () => {
    const value = state({ intervalDays: 7 });
    value.lastScheduledDate = "2026-10-01";
    expect(nextWorkerRun(value, now)).toBe("2026-10-08T13:17:00.000Z");
    expect(workerClaimAvailable(value, new Date("2026-10-13T04:00:00Z"))).toBe(true);
    value.sync.enabled = false;
    expect(workerClaimAvailable(value, now)).toBe(false);
  });

  it("a Mac restarted after missed weeks claims every missing completed date before today's start hour", () => {
    const value = state({
      intervalDays: 7,
      coverageThrough: "2026-10-28",
      lastSuccessAt: "2026-10-29T13:00:00Z",
    });
    value.lastScheduledDate = "2026-10-29";
    const restarted = new Date("2026-11-15T07:00:00Z");
    expect(nextWorkerRun(value, restarted)).toBe("2026-11-05T14:17:00.000Z");
    const claim = claimWorker(
      JSON.parse(JSON.stringify(value)),
      "mac:after-power-off",
      restarted,
      ids,
    );
    expect(claim?.period).toEqual({ from: "2026-10-29", to: "2026-11-14" });
    value.sync.enabled = false;
    expect(claimWorker(value, "mac:paused-start", restarted, ids)).toBeNull();
    value.sync.enabled = true;
    value.sync.status = "not_connected";
    expect(claimWorker(value, "mac:before-first-connection", restarted, ids)).toBeNull();
  });

  it("uses the first repeated fall gate and the next real spring gate", () => {
    expect(nextWorkerRun(state({ hour: 1 }), new Date("2026-11-01T04:00:00Z"))).toBe(
      "2026-11-01T05:17:00.000Z",
    );
    expect(nextWorkerRun(state({ hour: 2 }), new Date("2026-03-08T05:00:00Z"))).toBe(
      "2026-03-08T07:17:00.000Z",
    );
  });

  it("consumes the whole interval on failure and resets it after a later manual success", () => {
    const value = state({ intervalDays: 7 });
    claimWorker(value, "github:failed", now, ids);
    finishWorker(value, ids.leaseToken, "failed", "Source unavailable", now);
    expect(value.sync.nextRunAt).toBe("2026-10-20T13:17:00.000Z");
    expect(claimWorker(value, "github:retry", new Date("2026-10-14T13:17:00Z"), ids)).toBeNull();
    value.sync.command = "run";
    value.sync.commandId = ids.commandId;
    const manual = new Date("2026-10-15T13:17:00Z");
    claimWorker(value, "github:manual", manual, ids);
    assertWorkerLease(value, ids.leaseToken, manual).imported = true;
    finishWorker(value, ids.leaseToken, "idle", null, manual);
    expect(value.sync.nextRunAt).toBe("2026-10-22T13:17:00.000Z");
    value.sync.intervalDays = 14;
    expect(nextWorkerRun(value, manual)).toBe("2026-10-29T13:17:00.000Z");
    value.sync.intervalDays = 1;
    expect(nextWorkerRun(value, manual)).toBe("2026-10-16T13:17:00.000Z");
  });

  it.each([0, 366, 1.5, Number.NaN])("rejects invalid interval %s", (intervalDays) => {
    expect(() => nextWorkerRun(state({ intervalDays }), now)).toThrow("interval");
    expect(() => workerClaimAvailable(state({ intervalDays }), now)).toThrow("interval");
  });

  it("covers long gaps in finite chunks and resumes after persisted state reload", () => {
    let value = state({ intervalDays: 90, coverageThrough: "2026-07-01", lookbackDays: 7 });
    value.lastScheduledDate = "2026-07-02";
    const periods = [];
    let attempt = now;
    for (let index = 0; index < 4; index++) {
      const claim = claimWorker(value, `github:chunk${index}`, attempt, ids);
      expect(claim).not.toBeNull();
      periods.push(claim?.period);
      assertWorkerLease(value, ids.leaseToken, attempt).imported = true;
      finishWorker(value, ids.leaseToken, "idle", null, attempt);
      // Persisted cursor is the authority across process/server restarts.
      value = JSON.parse(JSON.stringify(value));
      if (index < 3) {
        expect(workerClaimAvailable(value, attempt)).toBe(false);
        expect(value.sync.nextRunAt).toBe(new Date(attempt.getTime() + 3600000).toISOString());
        attempt = new Date(attempt.getTime() + 3600000);
      }
    }
    expect(periods).toEqual([
      { from: "2026-07-02", to: "2026-08-01" },
      { from: "2026-08-02", to: "2026-09-01" },
      { from: "2026-09-02", to: "2026-10-02" },
      { from: "2026-10-03", to: "2026-10-12" },
    ]);
    expect(value.sync.coverageThrough).toBe("2026-10-12");
    expect(value.workerCatchup).toBeNull();
    expect(value.sync.nextRunAt).toBe("2027-01-11T14:17:00.000Z");
  });

  it("keeps pending dates when paused or failed and advances only committed chunks", () => {
    const value = state({ enabled: false, intervalDays: 7, coverageThrough: "2026-08-01" });
    value.sync.command = "run";
    value.sync.commandId = ids.commandId;
    claimWorker(value, "manual:first", now, ids);
    assertWorkerLease(value, ids.leaseToken, now).imported = true;
    finishWorker(value, ids.leaseToken, "idle", null, now);
    expect(value.sync.coverageThrough).toBe("2026-09-01");
    expect(value.workerCatchup?.nextFrom).toBe("2026-09-02");
    expect(value.sync.nextRunAt).toBeNull();
    const nextHour = new Date(now.getTime() + 3600000);
    expect(workerClaimAvailable(value, nextHour)).toBe(false);
    value.sync.enabled = true;
    const claim = claimWorker(value, "resume:next", nextHour, ids);
    finishWorker(value, ids.leaseToken, "failed", "Download failed", nextHour);
    expect(value.sync.coverageThrough).toBe("2026-09-01");
    expect(value.workerCatchup?.nextFrom).toBe(claim?.period.from);
    expect(value.workerCatchup?.nextClaimAt).toBeNull();
    expect(workerClaimAvailable(value, new Date(nextHour.getTime() + 3600000))).toBe(false);
    expect(value.sync.nextRunAt).toBe("2026-10-20T13:17:00.000Z");
  });

  it("does not re-download a chunk already committed when its worker lease expires", () => {
    const value = state({ coverageThrough: "2026-08-01" });
    claimWorker(value, "interrupted", now, ids);
    assertWorkerLease(value, ids.leaseToken, now).imported = true;
    const recovered = new Date(now.getTime() + LABOR_WORKER_LEASE_MS);
    recoverExpiredLaborLease(value, recovered);
    expect(value.sync.coverageThrough).toBe("2026-09-01");
    expect(value.workerCatchup?.nextFrom).toBe("2026-09-02");
    expect(value.sync.lastSuccessAt).toBeNull();
    expect(workerClaimAvailable(value, recovered)).toBe(false);
    const next = new Date(recovered.getTime() + LABOR_WORKER_RECOVERY_DELAY_MS);
    expect(claimWorker(value, "mac:remaining-after-crash", next, ids)?.period).toEqual({
      from: "2026-09-02",
      to: "2026-10-02",
    });
  });

  it("retries an interrupted acquisition after a bounded recovery delay without waiting a yearly cadence", () => {
    const value = state({ intervalDays: 365, coverageThrough: "2026-08-01" });
    const first = claimWorker(value, "mac:before-power-loss", now, ids);
    const restarted: LaborWorkerControlState = JSON.parse(JSON.stringify(value));
    const boot = new Date(now.getTime() + 4 * 3600000);
    expect(claimWorker(restarted, "mac:after-power-loss", boot, ids)).toBeNull();
    expect(restarted.workerLease).toBeNull();
    expect(restarted.sync.coverageThrough).toBe("2026-08-01");
    const retryAt = new Date(boot.getTime() + LABOR_WORKER_RECOVERY_DELAY_MS);
    expect(restarted.sync.nextRunAt).toBe(retryAt.toISOString());
    expect(workerClaimAvailable(restarted, new Date(retryAt.getTime() - 1))).toBe(false);
    expect(claimWorker(restarted, "mac:resumed", retryAt, ids)?.period).toEqual(first?.period);
  });

  it("does not auto-resume recovered pending dates while paused", () => {
    const value = state({ intervalDays: 365 });
    claimWorker(value, "mac:before-pause", now, ids);
    value.sync.enabled = false;
    const boot = new Date(now.getTime() + 4 * 3600000);
    expect(claimWorker(value, "mac:paused-restart", boot, ids)).toBeNull();
    expect(value.workerCatchup).not.toBeNull();
    expect(value.sync.nextRunAt).toBeNull();
    expect(workerClaimAvailable(value, new Date(boot.getTime() + 3600000))).toBe(false);
  });

  it("includes newly completed dates on a fresh manual catch-up request without replaying committed chunks", () => {
    const value = state({ enabled: false, intervalDays: 7, coverageThrough: "2026-08-01" });
    value.sync.command = "run";
    value.sync.commandId = ids.commandId;
    claimWorker(value, "manual:first", now, ids);
    assertWorkerLease(value, ids.leaseToken, now).imported = true;
    finishWorker(value, ids.leaseToken, "idle", null, now);
    expect(value.workerCatchup?.to).toBe("2026-10-12");
    value.sync.command = "run";
    value.sync.commandId = ids.commandId;
    const later = new Date("2026-10-20T13:17:00Z");
    expect(claimWorker(value, "manual:later", later, ids)?.period).toEqual({
      from: "2026-09-02",
      to: "2026-10-02",
    });
    expect(value.workerCatchup?.to).toBe("2026-10-19");
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

  it("recovers interrupted leases visibly without immediately repeating their acquisition", () => {
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
