import type { LaborEntry, LaborReport } from "@svl/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  snapshot: null as { state: Record<string, unknown>; revision: number } | null,
  originals: new Map<string, Uint8Array>(),
  read: vi.fn(),
  readWorker: vi.fn(),
  cas: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
  sign: vi.fn(),
}));
vi.mock("./persistence", () => ({
  readSupabaseLaborState: cloud.read,
  readSupabaseLaborWorkerControl: cloud.readWorker,
  compareAndSwapSupabaseLaborState: cloud.cas,
  putSupabaseLaborOriginal: cloud.put,
  getSupabaseLaborOriginal: cloud.get,
  createSupabaseLaborOriginalDownloadUrl: cloud.sign,
}));
vi.mock("./job-catalog", () => ({
  loadLaborJobCatalog: async () => ({
    jobs: [],
    complete: false,
    lastSuccessfulSyncAt: null,
    fingerprint: null,
    warnings: [],
  }),
}));
vi.mock("@svl/integrations", () => ({
  parseSupercrewXlsx: async (data: Uint8Array) => JSON.parse(new TextDecoder().decode(data)),
  parseSupercrewNotesXlsx: async (data: Uint8Array, options: Record<string, unknown>) => ({
    ...JSON.parse(new TextDecoder().decode(data)),
    ...options,
  }),
}));

import {
  claimLaborWorker,
  ingestLaborFile,
  initializeSharedLaborLedger,
  loadLaborDashboard,
  loadLaborStatus,
  loadLaborWorkerPoll,
  type NotesImportOptions,
  originalLaborDownload,
  originalLaborFile,
  queueLaborSync,
  updateLaborPaySettings,
  updateLaborRules,
} from "./store";

type Source = {
  id: string;
  hash: string;
  filename: string;
  entryCount: number;
  report: LaborReport;
};
type SharedState = {
  imports: Source[];
  notesImports: unknown[];
  sync: Record<string, unknown>;
  receipts: unknown[];
  workerLease?: unknown;
  lastScheduledDate?: unknown;
};
const stored = () => cloud.snapshot?.state as unknown as SharedState;
const actorId = "93000000-0000-4000-8000-000000000001";
const period = { from: "2026-09-24", to: "2026-09-30" };
const row = (date: string, hours: number): LaborEntry => ({
  id: `TEST-${date}-${hours}`,
  kind: "work",
  date,
  workerName: "TEST worker",
  jobName: "TEST job",
  jobAddress: "TEST address",
  clockIn: "08:00",
  clockOut: "09:00",
  clockInMethod: "AutoClock",
  clockOutMethod: "AutoClock",
  timeEntryType: "",
  crew: "",
  role: "",
  jobCode: null,
  employeeId: null,
  hours,
  travel: false,
  laborCostCents: 0,
  billableCostCents: 0,
  sourceRow: 13,
});
const report = (entries: LaborEntry[], generatedAt = "2026-09-29 2:00:00 PM"): LaborReport => ({
  entries,
  generatedAt,
  period,
  filters: {
    jobs: "All jobs",
    workers: "All workers",
    timeEntryType: "All types",
    budgetStatus: "",
  },
  reportedTotals: {
    hours: entries.reduce((total, entry) => total + entry.hours, 0),
    travelHours: 0,
    laborCostCents: 0,
    billableCostCents: 0,
  },
  computedTotals: {
    hours: entries.reduce((total, entry) => total + entry.hours, 0),
    travelHours: 0,
    laborCostCents: 0,
    billableCostCents: 0,
  },
  warnings: [],
  formatVersion: "TEST",
});
const bytes = (value: LaborReport) => new TextEncoder().encode(JSON.stringify(value));

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LABOR_ENABLED", "1");
  cloud.snapshot = null;
  cloud.originals.clear();
  vi.clearAllMocks();
  cloud.read.mockImplementation(async () => structuredClone(cloud.snapshot));
  cloud.readWorker.mockImplementation(async () => {
    if (!cloud.snapshot) return null;
    const { sync, workerLease, lastScheduledDate, workerCatchup } = cloud.snapshot.state;
    return structuredClone({ sync, workerLease, lastScheduledDate, workerCatchup });
  });
  cloud.cas.mockImplementation(async (state: Record<string, unknown>, revision: number) => {
    if (revision !== (cloud.snapshot?.revision ?? 0)) return null;
    cloud.snapshot = { state: structuredClone(state), revision: revision + 1 };
    return revision + 1;
  });
  cloud.put.mockImplementation(async (id: string, data: Uint8Array) => {
    const original = cloud.originals.get(id);
    if (original && !Buffer.from(original).equals(Buffer.from(data)))
      throw new Error("Immutable original changed");
    cloud.originals.set(id, new Uint8Array(data));
  });
  cloud.get.mockImplementation(async (id: string) => cloud.originals.get(id) ?? null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("shared recurrence and source coverage", () => {
  const pairedSource = async (
    from: string,
    to: string,
    options: Partial<NotesImportOptions> = {},
    generatedAt = "2026-10-29 8:00:00 AM",
  ) => {
    const source = { ...report([], generatedAt), period: { from, to } };
    return ingestLaborFile(bytes(source), `TEST-${from}-${to}.xlsx`, "supercrew", source.period, {
      bytes: new TextEncoder().encode(
        JSON.stringify({ notes: [], warnings: [], datesVerified: true, formatVersion: "TEST" }),
      ),
      filename: "TEST-daily-notes.xlsx",
      scope: "daily_timesheet",
      complete: true,
      datesVerified: true,
      ...options,
    });
  };
  const legacyCoverage = async () => {
    delete stored().sync.coverageThrough;
    return (await loadLaborStatus()).sync.coverageThrough;
  };

  it("defaults old settings to daily and keeps the current pause state when saving", async () => {
    await queueLaborSync("pause", {}, actorId);
    delete stored().sync.intervalDays;
    expect((await loadLaborStatus()).sync.intervalDays).toBe(1);
    const configured = await queueLaborSync("configure", { intervalDays: 7, hour: 9 }, actorId);
    expect(configured).toMatchObject({ enabled: false, intervalDays: 7, hour: 9, nextRunAt: null });
    const resumed = await queueLaborSync("resume", {}, actorId);
    expect(resumed).toMatchObject({ enabled: true, intervalDays: 7, hour: 9 });
    expect((await queueLaborSync("configure", { lookbackDays: 3 }, actorId)).enabled).toBe(true);
    expect(stored().sync.intervalDays).toBe(7);
    expect(cloud.cas.mock.lastCall?.[2]).toBe(actorId);
  });

  it.each([
    [1, "2026-10-14T13:00:00.000Z"],
    [7, "2026-10-20T13:00:00.000Z"],
    [14, "2026-10-27T13:00:00.000Z"],
    [45, "2026-11-27T14:00:00.000Z"],
    [365, "2027-10-13T13:00:00.000Z"],
  ])(
    "persists %s-day settings and recalculates the public next gate",
    async (intervalDays, nextRunAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
      await queueLaborSync("resume", {}, actorId);
      stored().sync.status = "idle";
      stored().lastScheduledDate = "2026-10-13";
      const configured = await queueLaborSync("configure", { intervalDays, hour: 9 }, actorId);
      expect(configured).toMatchObject({ enabled: true, intervalDays, nextRunAt });
      expect((await loadLaborStatus()).sync.nextRunAt).toBe(nextRunAt);
      expect((await queueLaborSync("pause", {}, actorId)).nextRunAt).toBeNull();
      expect((await queueLaborSync("resume", {}, actorId)).nextRunAt).toBe(nextRunAt);
    },
  );

  it.each([0, 366, 1.5, Number.NaN])(
    "rejects invalid %s-day settings at the store boundary",
    async (intervalDays) => {
      await expect(queueLaborSync("configure", { intervalDays }, actorId)).rejects.toThrow(
        "intervalDays",
      );
      expect(cloud.cas).not.toHaveBeenCalled();
    },
  );

  it("derives legacy coverage from an ordered contiguous union of complete verified pairs", async () => {
    await pairedSource("2026-09-24", "2026-09-28");
    await pairedSource("2026-09-20", "2026-09-22");
    await pairedSource("2026-09-22", "2026-09-25");
    expect(await legacyCoverage()).toBe("2026-09-28");
  });

  it("stops at a missing date and makes that gap the next catch-up start", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T14:00:00Z"));
    await pairedSource("2026-09-20", "2026-09-22");
    await pairedSource("2026-09-24", "2026-09-28");
    expect(await legacyCoverage()).toBe("2026-09-22");
    await queueLaborSync("run", { intervalDays: 45, lookbackDays: 7 }, actorId);
    const claim = await claimLaborWorker("TEST-catchup-gap");
    expect(claim?.period).toEqual({ from: "2026-09-23", to: "2026-10-23" });
    expect((await loadLaborStatus()).pendingDownload).toEqual({
      from: "2026-09-23",
      to: "2026-10-28",
      nextRunAt: null,
    });
  });

  it.each([{ complete: false }, { datesVerified: false }, { scope: "mixed" as const }])(
    "excludes incomplete or unverified daily-note coverage: %j",
    async (options) => {
      await pairedSource("2026-09-24", "2026-09-30", options);
      expect(await legacyCoverage()).toBeNull();
    },
  );

  it("excludes the source generation date because it was not a completed date", async () => {
    await pairedSource("2026-10-20", "2026-10-29");
    expect(await legacyCoverage()).toBeNull();
  });

  it("excludes filtered timesheets and mismatched or missing paired source references", async () => {
    await pairedSource("2026-09-24", "2026-09-30");
    const notes = stored().notesImports[0] as Record<string, unknown>;
    const original = structuredClone(notes);
    for (const change of [
      { laborImportId: null },
      { laborImportId: "TEST-missing-source" },
      { period: { from: "2026-09-23", to: "2026-09-30" } },
    ]) {
      Object.assign(notes, original, change);
      expect(await legacyCoverage()).toBeNull();
    }
    Object.assign(notes, original);
    stored().imports[0].report.filters.workers = "TEST single worker";
    expect(await legacyCoverage()).toBeNull();
  });

  it("never infers covered source dates from a successful heartbeat alone", async () => {
    await queueLaborSync("pause", {}, actorId);
    stored().sync.lastSuccessAt = "2026-10-29T14:00:00Z";
    expect(await legacyCoverage()).toBeNull();
  });
});

describe("shared labor transactions", () => {
  it("polls a paused idle worker without database writes or ledger revision changes", async () => {
    await queueLaborSync("pause", {}, actorId);
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockClear();
    cloud.read.mockClear();
    for (let index = 0; index < 3; index++)
      expect((await loadLaborWorkerPoll()).claimable).toBe(false);
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.read).not.toHaveBeenCalled();
    expect(cloud.readWorker).toHaveBeenCalledTimes(3);
    expect(cloud.snapshot).toEqual(before);
  });

  it("exposes a queued request while paused without claiming or clearing it", async () => {
    await queueLaborSync("pause", {}, actorId);
    await queueLaborSync("run", { lookbackDays: 7 }, actorId);
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockClear();
    const polled = await loadLaborWorkerPoll();
    expect(polled.claimable).toBe(true);
    expect(polled.sync).toEqual(stored().sync);
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.snapshot).toEqual(before);
  });

  it("allows lease recovery to be requested without recovering or changing it during a poll", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    await queueLaborSync("run", {}, actorId);
    await claimLaborWorker("TEST-poll-recovery");
    const active = await loadLaborWorkerPoll();
    expect(active.claimable).toBe(false);
    vi.setSystemTime(new Date("2026-10-01T12:16:00Z"));
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockClear();
    expect((await loadLaborWorkerPoll()).claimable).toBe(true);
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.snapshot).toEqual(before);
  });

  const claim = async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    await queueLaborSync("run", { lookbackDays: 7 }, actorId);
    const claimed = await claimLaborWorker("TEST-leased-run");
    if (!claimed) throw new Error("Test claim was not granted");
    return claimed;
  };
  const pairedNotes = () => ({
    bytes: new TextEncoder().encode(
      JSON.stringify({ notes: [], warnings: [], datesVerified: true, formatVersion: "TEST" }),
    ),
    filename: "TEST-daily.xlsx",
    scope: "daily_timesheet" as const,
    complete: true,
    datesVerified: true,
  });

  it("does not activate uploaded originals when a rejected commit is retried after lease expiry", async () => {
    const claimed = await claim();
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-01T12:16:00Z"));
      return null;
    });
    await expect(
      ingestLaborFile(
        bytes(report([row("2026-09-24", 2)], "2026-10-01 8:00:00 AM")),
        "TEST-expired.xlsx",
        "supercrew",
        claimed.period,
        pairedNotes(),
        null,
        { leaseToken: claimed.leaseToken, commandId: claimed.commandId },
      ),
    ).rejects.toThrow("Stale worker lease");
    expect(cloud.snapshot).toEqual(before);
    expect(stored().imports).toEqual([]);
    expect(stored().notesImports).toEqual([]);
    expect(cloud.originals.size).toBe(2);
    expect(cloud.cas.mock.lastCall?.[3]).toEqual({
      leaseToken: claimed.leaseToken,
      commandId: claimed.commandId,
      period: claimed.period,
    });
  });

  it("passes the claimed command, token and report period into the guarded commit", async () => {
    await queueLaborSync("pause", {}, actorId);
    const lease = {
      leaseToken: "94000000-0000-4000-8000-000000000001",
      commandId: "94000000-0000-4000-8000-000000000002",
      period,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      imported: false,
    };
    stored().workerLease = lease;
    stored().sync = {
      ...stored().sync,
      status: "running",
      command: "run",
      commandId: lease.commandId,
    };
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 8)])),
      "TEST.xlsx",
      "supercrew",
      period,
      undefined,
      null,
      { leaseToken: lease.leaseToken, commandId: lease.commandId },
    );
    expect(cloud.cas.mock.lastCall?.[3]).toEqual({
      leaseToken: lease.leaseToken,
      commandId: lease.commandId,
      period,
    });
  });

  it("resaves unchanged reviewed aliases after their historical worker-day rows are compacted", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 8)])), "TEST-old.xlsx", "upload");
    const initial = await loadLaborDashboard();
    const key = JSON.stringify(["TEST job", "TEST address"]);
    const rules = {
      ...initial.rules,
      locations: [
        {
          sourceKey: key,
          kind: "customer" as const,
          job: { key, name: "TEST job", address: "TEST address", housecallJobId: null },
        },
      ],
      jobAliases: [
        {
          alias: "TEST location alias",
          sourceKey: key,
          workerName: "TEST worker",
          date: "2026-09-24",
        },
      ],
      workerAliases: [{ alias: "TEST worker alias", workerName: "TEST worker" }],
    };
    await updateLaborRules(rules, initial.rulesRevision, actorId);
    await ingestLaborFile(bytes(report([], "2026-09-30 3:00:00 PM")), "TEST-new.xlsx", "upload");
    const dashboard = await loadLaborDashboard();
    const resaved = await updateLaborRules(rules, dashboard.rulesRevision, actorId);
    expect(resaved.rules.jobAliases).toEqual(rules.jobAliases);
    expect(resaved.rules.workerAliases).toEqual(rules.workerAliases);
    await expect(
      updateLaborRules(
        { ...rules, jobAliases: [{ ...rules.jobAliases[0], date: "2026-09-25" }] },
        resaved.rulesRevision,
        actorId,
      ),
    ).rejects.toThrow("recorded worker and work date");
    await expect(
      updateLaborRules(
        { ...rules, workerAliases: [{ alias: "TEST changed alias", workerName: "TEST unknown" }] },
        resaved.rulesRevision,
        actorId,
      ),
    ).rejects.toThrow("Worker alias destination is unknown");
  });

  it("retains saved worker rate identities after a newer snapshot compacts their source rows", async () => {
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 8)])),
      "TEST-old.xlsx",
      "upload",
      undefined,
      undefined,
      actorId,
    );
    const initial = await loadLaborDashboard();
    const saved = {
      ...initial.paySettings,
      workerRates: [{ workerName: "TEST worker", hourlyRateCents: 2400, active: false }],
    };
    await updateLaborPaySettings(saved, initial.payRevision, actorId);
    await ingestLaborFile(
      bytes(report([], "2026-09-30 3:00:00 PM")),
      "TEST-new.xlsx",
      "upload",
      undefined,
      undefined,
      actorId,
    );
    expect(stored().imports.flatMap((item) => item.report.entries)).toEqual([]);
    const dashboard = await loadLaborDashboard();
    expect(dashboard.paySettings.workerRates).toEqual(saved.workerRates);
    const changed = {
      ...dashboard.paySettings,
      workerRates: [{ workerName: "TEST worker", hourlyRateCents: 2500, active: false }],
    };
    const result = await updateLaborPaySettings(changed, dashboard.payRevision, actorId);
    expect(result.settings.workerRates).toEqual(changed.workerRates);
    await expect(
      updateLaborPaySettings(
        {
          ...changed,
          workerRates: [{ workerName: "TEST unknown", hourlyRateCents: 2500, active: true }],
        },
        result.payRevision,
        actorId,
      ),
    ).rejects.toThrow("Pay worker is not recorded");
  });

  it("retries against fresh control without losing a concurrent manager edit or duplicating the source", async () => {
    await queueLaborSync("pause", {}, actorId);
    cloud.cas.mockImplementationOnce(async () => {
      const snapshot = cloud.snapshot;
      if (!snapshot) throw new Error("Missing initial test snapshot");
      (snapshot.state.sync as Record<string, unknown>).hour = 9;
      snapshot.revision++;
      return null;
    });
    const data = bytes(report([row("2026-09-24", 2)]));
    const result = await ingestLaborFile(
      data,
      "TEST.xlsx",
      "upload",
      undefined,
      undefined,
      actorId,
    );
    expect(cloud.snapshot?.revision).toBe(3);
    expect(stored().sync.hour).toBe(9);
    expect(stored().imports).toHaveLength(1);
    expect(cloud.originals.size).toBe(1);
    const attempts = cloud.cas.mock.calls.slice(1);
    expect(attempts.map((call) => call[1])).toEqual([1, 2]);
    expect(attempts.every((call) => call[2] === actorId)).toBe(true);
    expect(cloud.put.mock.calls.map((call) => call[0])).toEqual([
      result.import.id,
      result.import.id,
    ]);
    expect((await originalLaborFile(result.import.id))?.bytes).toEqual(data);
  });

  it("bounds repeated conflicts and leaves the last committed state intact", async () => {
    await queueLaborSync("pause", {}, actorId);
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockResolvedValue(null);
    cloud.cas.mockClear();
    await expect(queueLaborSync("resume", {}, actorId)).rejects.toThrow("storage is busy");
    expect(cloud.cas).toHaveBeenCalledTimes(5);
    expect(cloud.snapshot).toEqual(before);
  });

  it("keeps original source counts when a stale attempt prunes incoming overlapping rows", async () => {
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 3)], "2026-09-29 5:00:00 PM")),
      "TEST-new.xlsx",
      "upload",
    );
    cloud.cas.mockImplementationOnce(async () => {
      if (!cloud.snapshot) throw new Error("Missing test snapshot");
      cloud.snapshot.revision++;
      return null;
    });
    const original = bytes(report([row("2026-09-24", 1), row("2026-09-25", 1)]));
    const result = await ingestLaborFile(original, "TEST-old.xlsx", "upload");
    expect(result.import.entryCount).toBe(2);
    expect(result.import.workerCount).toBe(1);
    expect(stored().imports[1].entryCount).toBe(2);
    expect(stored().imports[1].report.entries).toEqual([]);
    expect((await originalLaborFile(result.import.id))?.bytes).toEqual(original);
  });

  it("retains every original and summary while keeping overlapping parsed hours once", async () => {
    const firstData = bytes(report([row("2026-09-24", 1), row("2026-09-25", 1)]));
    const secondReport = report([row("2026-09-24", 3)], "2026-09-29 5:00:00 PM");
    secondReport.period = { from: "2026-09-24", to: "2026-09-24" };
    const secondData = bytes(secondReport);
    const first = await ingestLaborFile(firstData, "TEST-before.xlsx", "upload");
    await ingestLaborFile(secondData, "TEST-after.xlsx", "upload");
    expect(stored().imports).toHaveLength(2);
    expect(stored().imports[0].entryCount).toBe(2);
    expect(stored().imports[0].report.entries.map((entry) => entry.date)).toEqual(["2026-09-25"]);
    expect(stored().imports.flatMap((source) => source.report.entries)).toHaveLength(2);
    expect((await loadLaborDashboard()).overview.hours).toBe(4);
    expect((await originalLaborFile(first.import.id))?.bytes).toEqual(firstData);
    expect(cloud.originals.size).toBe(2);
  });

  it("orders by source generation even when an older workbook arrives later", async () => {
    const newer = bytes(report([row("2026-09-24", 3)], "2026-09-29 5:00:00 PM"));
    const older = bytes(report([row("2026-09-24", 1)], "2026-09-29 2:00:00 PM"));
    await ingestLaborFile(newer, "TEST-newer.xlsx", "upload");
    const oldImport = await ingestLaborFile(older, "TEST-older.xlsx", "upload");
    expect((await loadLaborDashboard()).overview.hours).toBe(3);
    expect(stored().imports[1].entryCount).toBe(1);
    expect(stored().imports[1].report.entries).toEqual([]);
    expect((await originalLaborFile(oldImport.import.id))?.bytes).toEqual(older);
  });

  it("deduplicates reuploads without writing the original again", async () => {
    const data = bytes(report([row("2026-09-24", 2)]));
    const first = await ingestLaborFile(data, "TEST.xlsx", "upload");
    const duplicate = await ingestLaborFile(data, "TEST-copy.xlsx", "upload");
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.import.id).toBe(first.import.id);
    expect(stored().imports).toHaveLength(1);
    expect(stored().imports[0].filename).toBe("TEST.xlsx");
    expect(cloud.put).toHaveBeenCalledTimes(1);
    expect(await originalLaborFile("93000000-0000-4000-8000-000000000099")).toBeNull();
    expect(cloud.get).not.toHaveBeenCalled();
  });

  it("validates paired files before any source or control writes", async () => {
    await expect(
      ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST.xlsx", "supercrew", period, {
        bytes: new TextEncoder().encode("invalid JSON"),
        filename: "TEST-notes.xlsx",
        scope: "mixed",
        complete: true,
        datesVerified: true,
      }),
    ).rejects.toThrow();
    expect(cloud.put).not.toHaveBeenCalled();
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.snapshot).toBeNull();
  });
});

describe("checked shared-ledger initialization", () => {
  it("rejects extra originals before storing any workbook", async () => {
    const source = bytes(report([row("2026-09-24", 2)]));
    await ingestLaborFile(source, "TEST.xlsx", "upload");
    const seed = structuredClone(cloud.snapshot?.state);
    const originals = new Map(cloud.originals);
    originals.set("93000000-0000-4000-8000-000000000099", source);
    cloud.snapshot = null;
    cloud.put.mockClear();
    cloud.cas.mockClear();
    await expect(initializeSharedLaborLedger(seed, originals, actorId)).rejects.toThrow(
      "must match the ledger exactly",
    );
    expect(cloud.put).not.toHaveBeenCalled();
    expect(cloud.cas).not.toHaveBeenCalled();
  });

  it("rejects mismatched or missing originals before writing shared data", async () => {
    const source = bytes(report([row("2026-09-24", 2)]));
    const imported = await ingestLaborFile(source, "TEST.xlsx", "upload");
    const seed = structuredClone(cloud.snapshot?.state);
    cloud.snapshot = null;
    cloud.put.mockClear();
    cloud.cas.mockClear();
    for (const originals of [
      new Map<string, Uint8Array>(),
      new Map([[imported.import.id, new Uint8Array([1])]]),
    ]) {
      await expect(initializeSharedLaborLedger(seed, originals, actorId)).rejects.toThrow(
        "hash does not match",
      );
    }
    expect(cloud.put).not.toHaveBeenCalled();
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.snapshot).toBeNull();
  });

  it("seeds checked sources with inactive scheduling and compacts parsed rows while preserving original bytes", async () => {
    const oldReport = report([row("2026-09-24", 1)]);
    const oldBytes = bytes(oldReport);
    const first = await ingestLaborFile(oldBytes, "TEST-old.xlsx", "upload");
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 3)], "2026-09-29 5:00:00 PM")),
      "TEST-new.xlsx",
      "upload",
    );
    const seed = structuredClone(cloud.snapshot?.state) as Record<string, unknown>;
    (seed.imports as Source[])[0].report = oldReport;
    seed.sync = {
      ...stored().sync,
      enabled: true,
      status: "running",
      command: "run",
      commandId: "TEST-command",
      workerHeartbeatAt: "2026-09-29T12:00:00Z",
    };
    seed.workerLease = { leaseToken: "TEST-private-token" };
    seed.lastScheduledDate = "2026-09-29";
    seed.receipts = [{ id: "TEST-preview-receipt" }];
    const originals = new Map(cloud.originals);
    cloud.snapshot = null;
    const result = await initializeSharedLaborLedger(seed, originals, actorId);
    expect(result).toEqual({ imports: 2, notesImports: 0, entryCount: 1 });
    expect(stored().sync).toMatchObject({
      enabled: false,
      status: "not_connected",
      command: null,
      commandId: null,
      workerHeartbeatAt: null,
    });
    expect(stored().workerLease).toBeNull();
    expect(stored().lastScheduledDate).toBeNull();
    expect(stored().receipts).toEqual([]);
    expect(stored().imports[0].report.entries).toEqual([]);
    expect(stored().imports[0].entryCount).toBe(1);
    expect((await originalLaborFile(first.import.id))?.bytes).toEqual(oldBytes);
    expect(cloud.cas.mock.lastCall?.[2]).toBe(actorId);
  });

  it("refuses to replace an existing shared ledger", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST.xlsx", "upload");
    const before = structuredClone(cloud.snapshot);
    cloud.cas.mockClear();
    cloud.put.mockClear();
    await expect(
      initializeSharedLaborLedger(before?.state, new Map(cloud.originals), actorId),
    ).rejects.toThrow("already contains records");
    expect(cloud.snapshot).toEqual(before);
    expect(cloud.cas).not.toHaveBeenCalled();
    expect(cloud.put).not.toHaveBeenCalled();
  });

  it("preserves manager settings saved while originals are uploading", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST.xlsx", "upload");
    const seed = structuredClone(cloud.snapshot?.state);
    const originals = new Map(cloud.originals);
    cloud.snapshot = null;
    cloud.put.mockImplementationOnce(async () => {
      await queueLaborSync("pause", { hour: 11 }, actorId);
    });
    await expect(initializeSharedLaborLedger(seed, originals, actorId)).rejects.toThrow(
      "already contains records",
    );
    expect(stored().sync.hour).toBe(11);
    expect(stored().imports).toEqual([]);
  });

  it("rejects a configured target even when it has no source imports", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST.xlsx", "upload");
    const seed = structuredClone(cloud.snapshot?.state);
    const originals = new Map(cloud.originals);
    cloud.snapshot = null;
    await queueLaborSync("pause", { hour: 11 }, actorId);
    cloud.put.mockClear();
    await expect(initializeSharedLaborLedger(seed, originals, actorId)).rejects.toThrow(
      "already contains records",
    );
    expect(cloud.put).not.toHaveBeenCalled();
    expect(stored().sync.hour).toBe(11);
  });
});

describe("shared original download", () => {
  it("requires ledger provenance before issuing a private download URL", async () => {
    const source = bytes(report([row("2026-09-24", 2)]));
    const result = await ingestLaborFile(source, "TEST report.xlsx", "upload");
    cloud.sign.mockResolvedValue("https://storage.example.invalid/TEST?token=TEST");
    expect(await originalLaborDownload("93000000-0000-4000-8000-000000000099")).toBeNull();
    expect(cloud.sign).not.toHaveBeenCalled();
    expect(await originalLaborDownload(result.import.id)).toEqual({
      url: "https://storage.example.invalid/TEST?token=TEST",
    });
    expect(cloud.sign).toHaveBeenCalledWith(result.import.id, "TEST report.xlsx");
    expect(cloud.get).not.toHaveBeenCalled();
  });
});
