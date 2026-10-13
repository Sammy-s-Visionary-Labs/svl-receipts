import type { LaborEntry, LaborReport } from "@svl/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cloud = vi.hoisted(() => ({
  snapshot: null as { state: Record<string, unknown>; revision: number } | null,
  originals: new Map<string, Uint8Array>(),
  read: vi.fn(),
  cas: vi.fn(),
  put: vi.fn(),
  get: vi.fn(),
}));
vi.mock("./persistence", () => ({
  readSupabaseLaborState: cloud.read,
  compareAndSwapSupabaseLaborState: cloud.cas,
  putSupabaseLaborOriginal: cloud.put,
  getSupabaseLaborOriginal: cloud.get,
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

describe("shared labor transactions", () => {
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
    await expect(
      initializeSharedLaborLedger(before?.state, new Map(cloud.originals), actorId),
    ).rejects.toThrow("already contains records");
    expect(cloud.snapshot).toEqual(before);
    expect(cloud.cas).not.toHaveBeenCalled();
  });
});
