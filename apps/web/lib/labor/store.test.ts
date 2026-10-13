import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type LaborEntry, type LaborNote, type LaborReport, sourceJobKey } from "@svl/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@svl/integrations", () => ({
  parseSupercrewXlsx: async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)),
  parseSupercrewNotesXlsx: async (
    bytes: Uint8Array,
    options: { period: { from: string; to: string }; scope: string },
  ) => ({
    ...JSON.parse(new TextDecoder().decode(bytes)),
    period: options.period,
    scope: options.scope,
  }),
}));

import {
  ingestLaborFile,
  ingestLaborNotesFile,
  loadLaborDashboard,
  originalLaborFile,
  updateLaborPaySettings,
  updateLaborRules,
  verifyLaborNote,
} from "./store";

let directory: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "svl-test-labor-"));
  vi.stubEnv("LABOR_DATA_DIR", directory);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});
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
  period: { from: "2026-09-24", to: "2026-09-30" },
  filters: {
    jobs: "All jobs",
    workers: "All workers",
    timeEntryType: "All types",
    budgetStatus: "",
  },
  reportedTotals: { hours: 1, travelHours: 0, laborCostCents: 0, billableCostCents: 0 },
  computedTotals: { hours: 1, travelHours: 0, laborCostCents: 0, billableCostCents: 0 },
  warnings: [],
  formatVersion: "TEST",
});
const bytes = (value: LaborReport) => new TextEncoder().encode(JSON.stringify(value));
const notesBytes = (notes: Partial<LaborNote>[] = []) =>
  new TextEncoder().encode(
    JSON.stringify({ notes, warnings: [], datesVerified: true, formatVersion: "TEST" }),
  );
const period = { from: "2026-09-24", to: "2026-09-30" };
const notesOptions = { scope: "mixed" as const, complete: true, datesVerified: true };

describe("labor import snapshots", () => {
  it("deduplicates an exact re-upload and keeps the original source", async () => {
    const data = bytes(report([row("2026-09-24", 1)]));
    const first = await ingestLaborFile(data, "TEST.xlsx", "upload");
    const second = await ingestLaborFile(data, "TEST-copy.xlsx", "upload");
    expect(second.duplicate).toBe(true);
    expect(second.import.id).toBe(first.import.id);
    expect((await loadLaborDashboard()).overview.entryCount).toBe(1);
  });
  it("replaces overlapping complete source scopes without appending old quantities", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST-before.xlsx", "upload");
    await ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST-after.xlsx", "upload");
    const dashboard = await loadLaborDashboard();
    expect(dashboard.overview.hours).toBe(2);
    expect(dashboard.imports).toHaveLength(2);
  });
  it("does not let future zero cells erase later-dated known records", async () => {
    await ingestLaborFile(
      bytes(report([row("2026-09-30", 3)], "2026-10-01 2:00:00 PM")),
      "TEST-later.xlsx",
      "upload",
    );
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST-partial.xlsx", "upload");
    expect((await loadLaborDashboard()).entries.map((entry) => entry.date)).toContain("2026-09-30");
  });
  it("keeps a newer source snapshot active when an older file is imported later", async () => {
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 2)], "2026-09-29 5:00:00 PM")),
      "TEST-newer.xlsx",
      "upload",
    );
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 1)], "2026-09-29 2:00:00 PM")),
      "TEST-older.xlsx",
      "upload",
    );
    const dashboard = await loadLaborDashboard();
    expect(dashboard.overview.hours).toBe(2);
    expect(dashboard.imports).toHaveLength(2);
  });
  it("rejects restricted time-type or budget snapshots without replacing stored hours", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 2)])), "TEST-full.xlsx", "upload");
    for (const filter of [{ timeEntryType: "Travel" }, { budgetStatus: "Over budget" }]) {
      const restricted = report([row("2026-09-24", 1)]);
      Object.assign(restricted.filters, filter);
      await expect(
        ingestLaborFile(bytes(restricted), "TEST-filtered.xlsx", "upload"),
      ).rejects.toThrow("unfiltered");
    }
    expect((await loadLaborDashboard()).overview.hours).toBe(2);
  });
  it("checks the requested worker interval before saving the downloaded workbook", async () => {
    await expect(
      ingestLaborFile(bytes(report([])), "TEST-wrong-period.xlsx", "supercrew", {
        from: "2026-09-15",
        to: "2026-09-28",
      }),
    ).rejects.toThrow("requested report period");
    expect((await loadLaborDashboard()).imports).toEqual([]);
  });
});

describe("labor notes and reviewed rules", () => {
  it("rejects an invalid paired notes artifact without activating the timesheet", async () => {
    await expect(
      ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST.xlsx", "supercrew", period, {
        ...notesOptions,
        bytes: new TextEncoder().encode("invalid JSON"),
        filename: "TEST-notes.xlsx",
      }),
    ).rejects.toThrow();
    expect((await loadLaborDashboard()).imports).toEqual([]);
  });

  it("imports changed notes alongside an unchanged timesheet without duplicating hours", async () => {
    const data = bytes(report([row("2026-09-24", 1)]));
    await ingestLaborFile(data, "TEST.xlsx", "upload");
    const result = await ingestLaborFile(data, "TEST.xlsx", "supercrew", period, {
      ...notesOptions,
      bytes: notesBytes(),
      filename: "TEST-notes.xlsx",
    });
    expect(result.duplicate).toBe(false);
    const dashboard = await loadLaborDashboard();
    expect(dashboard.imports).toHaveLength(1);
    expect(dashboard.notesImports).toHaveLength(1);
    expect(dashboard.overview.hours).toBe(1);
    const second = await ingestLaborFile(data, "TEST.xlsx", "supercrew", period, {
      ...notesOptions,
      bytes: notesBytes(),
      filename: "TEST-notes.xlsx",
    });
    expect(second.duplicate).toBe(true);
  });

  it("keeps unknown locations pending until classification and checks concurrent rule edits", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST.xlsx", "upload");
    const first = await loadLaborDashboard();
    expect(first.allocation.totals.pendingHours).toBe(1);
    const key = sourceJobKey("TEST job", "TEST address");
    const rules = {
      ...first.rules,
      locations: [
        {
          sourceKey: key,
          kind: "customer",
          job: { key, name: "TEST job", address: "TEST address", housecallJobId: null },
        },
      ],
    };
    await updateLaborRules(rules, first.rulesRevision);
    const reviewed = await loadLaborDashboard();
    expect(reviewed.allocation.totals.allocatedHours).toBe(1);
    expect(reviewed.jobs[0].reportedCostCents).toBeNull();
    await expect(updateLaborRules(rules, first.rulesRevision)).rejects.toThrow("Stale");
    expect(reviewed.entries[0].hours).toBe(1);
  });

  it("retains worker-day aliases and rejects scopes without a recorded worker-day", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST.xlsx", "upload");
    const dashboard = await loadLaborDashboard();
    const key = sourceJobKey("TEST job", "TEST address");
    const rules = {
      ...dashboard.rules,
      locations: [
        {
          sourceKey: key,
          kind: "customer",
          job: { key, name: "TEST job", address: "TEST address", housecallJobId: null },
        },
      ],
      jobAliases: [
        { alias: "Vicki", sourceKey: key, workerName: "TEST worker", date: "2026-09-24" },
      ],
    };
    await updateLaborRules(rules, dashboard.rulesRevision);
    const saved = await loadLaborDashboard();
    expect(saved.rules.jobAliases).toEqual(rules.jobAliases);
    for (const alias of [
      { alias: "Vicki", sourceKey: key, workerName: "TEST worker" },
      { alias: "Vicki", sourceKey: key, date: "2026-09-24" },
      { alias: "Vicki", sourceKey: key, workerName: "Other worker", date: "2026-09-24" },
      { alias: "Vicki", sourceKey: key, workerName: "TEST worker", date: "2026-09-25" },
    ]) {
      await expect(
        updateLaborRules({ ...rules, jobAliases: [alias] }, saved.rulesRevision),
      ).rejects.toThrow();
    }
    expect((await loadLaborDashboard()).rulesRevision).toBe(saved.rulesRevision);
  });

  it("rejects a forged Housecall identity and aliases to unreviewed destinations", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST.xlsx", "upload");
    const dashboard = await loadLaborDashboard();
    const key = sourceJobKey("TEST job", "TEST address");
    await expect(
      updateLaborRules(
        {
          locations: [
            {
              sourceKey: key,
              kind: "customer",
              job: { key, name: "TEST job", address: "TEST address", housecallJobId: "forged" },
            },
          ],
          jobAliases: [],
        },
        0,
      ),
    ).rejects.toThrow("identity");
    await expect(
      updateLaborRules(
        { ...dashboard.rules, jobAliases: [{ alias: "Somewhere", sourceKey: key }] },
        0,
      ),
    ).rejects.toThrow("reviewed customer");
  });

  it("records explicit daily confirmation without changing the source and hides unrelated note bodies", async () => {
    const candidate: LaborNote = {
      id: "TEST-note",
      date: "2026-09-24",
      rawDate: "2026-09-24T04:00:00.000Z",
      workerName: "TEST worker",
      notetaker: "TEST editor",
      text: "TEST job",
      project: "",
      punchInfo: "",
      punchDuration: "",
      sourceRow: 2,
      kind: "daily_candidate",
    };
    const original = notesBytes([
      candidate,
      {
        ...candidate,
        id: "TEST-other",
        kind: "other",
        text: "TEST unrelated private note",
        sourceRow: 3,
      },
    ]);
    const imported = await ingestLaborNotesFile(
      original,
      "TEST-notes.xlsx",
      "upload",
      period,
      notesOptions,
    );
    expect((await loadLaborDashboard()).notes).toHaveLength(1);
    await verifyLaborNote(candidate.id, true);
    expect((await loadLaborDashboard()).notes[0].dailyVerified).toBe(true);
    const retained = await originalLaborFile(imported.import.id);
    if (!retained) throw new Error("Expected retained Notes original");
    expect(new Uint8Array(retained.bytes)).toEqual(original);
    await verifyLaborNote(candidate.id, false);
    expect((await loadLaborDashboard()).notes[0].dailyVerified).toBe(false);
    await expect(verifyLaborNote("TEST-other", true)).rejects.toThrow("candidate");
  });

  it("preserves incomplete evidence and does not claim coverage between nonoverlapping periods", async () => {
    await ingestLaborNotesFile(
      notesBytes(),
      "TEST-before.xlsx",
      "upload",
      { from: "2026-09-24", to: "2026-09-24" },
      notesOptions,
    );
    await ingestLaborNotesFile(
      notesBytes(),
      "TEST-after.xlsx",
      "upload",
      { from: "2026-09-26", to: "2026-09-26" },
      { ...notesOptions, complete: false },
    );
    const dashboard = await loadLaborDashboard();
    expect(dashboard.notesCoverage).toHaveLength(2);
    expect(
      dashboard.notesCoverage.some(
        (scope) => scope.from <= "2026-09-25" && scope.to >= "2026-09-25",
      ),
    ).toBe(false);
    expect(dashboard.notesCoverage.find((scope) => scope.from === "2026-09-26")?.complete).toBe(
      false,
    );
  });

  it("cannot enable daily allocation by confirming only the note type when work dates are unverified", async () => {
    const candidate: LaborNote = {
      id: "TEST-unverified-date",
      date: "2026-09-24",
      rawDate: "2026-09-24T04:00:00.000",
      workerName: "TEST worker",
      notetaker: "TEST editor",
      text: "TEST job",
      project: "",
      punchInfo: "",
      punchDuration: "",
      sourceRow: 2,
      kind: "daily_candidate",
    };
    await ingestLaborNotesFile(notesBytes([candidate]), "TEST-notes.xlsx", "upload", period, {
      ...notesOptions,
      datesVerified: false,
    });
    await expect(verifyLaborNote(candidate.id, true)).rejects.toThrow("work dates");
    expect((await loadLaborDashboard()).notes[0].dailyVerified).toBe(false);
  });

  it("does not let an older paired export replace newer active hour-comment evidence", async () => {
    const candidate: LaborNote = {
      id: "TEST-new-note",
      date: "2026-09-24",
      rawDate: "2026-09-24T04:00:00.000",
      workerName: "TEST worker",
      notetaker: "TEST editor",
      text: "TEST NEW job",
      project: "",
      punchInfo: "",
      punchDuration: "",
      sourceRow: 2,
      kind: "daily_candidate",
    };
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 2)], "2026-10-01 2:00:00 PM")),
      "TEST-new.xlsx",
      "supercrew",
      period,
      { ...notesOptions, bytes: notesBytes([candidate]), filename: "TEST-new-notes.xlsx" },
    );
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 1)], "2026-09-29 2:00:00 PM")),
      "TEST-old.xlsx",
      "supercrew",
      period,
      {
        ...notesOptions,
        bytes: notesBytes([{ ...candidate, id: "TEST-old-note", text: "TEST OLD job" }]),
        filename: "TEST-old-notes.xlsx",
      },
    );
    const dashboard = await loadLaborDashboard();
    expect(dashboard.overview.hours).toBe(2);
    expect(dashboard.notes.map((note) => note.text)).toEqual(["TEST NEW job"]);
    expect(dashboard.notesImports).toHaveLength(2);
  });

  it("keeps unchanged Notes bytes linked to a changed active Timesheet generation", async () => {
    const candidate: LaborNote = {
      id: "TEST-same-note",
      date: "2026-09-24",
      rawDate: "2026-09-24T04:00:00.000",
      workerName: "TEST worker",
      notetaker: "TEST editor",
      text: "TEST job",
      project: "",
      punchInfo: "",
      punchDuration: "",
      sourceRow: 2,
      kind: "daily_candidate",
    };
    const pair = { ...notesOptions, bytes: notesBytes([candidate]), filename: "TEST-notes.xlsx" };
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 1)], "2026-09-29 2:00:00 PM")),
      "TEST-old.xlsx",
      "supercrew",
      period,
      pair,
    );
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 2)], "2026-10-01 2:00:00 PM")),
      "TEST-new.xlsx",
      "supercrew",
      period,
      pair,
    );
    const dashboard = await loadLaborDashboard();
    expect(dashboard.notes).toHaveLength(1);
    expect(dashboard.notesImports).toHaveLength(2);
    expect(dashboard.notes[0].importId).toBe(dashboard.notesImports[0].id);
  });

  it("lets an explicit revocation override worker-verified daily scope", async () => {
    const candidate: LaborNote = {
      id: "TEST-filtered-daily",
      date: "2026-09-24",
      rawDate: "2026-09-24T04:00:00.000",
      workerName: "TEST worker",
      notetaker: "TEST editor",
      text: "TEST job",
      project: "",
      punchInfo: "",
      punchDuration: "",
      sourceRow: 2,
      kind: "daily_candidate",
      dailyVerified: true,
    };
    await ingestLaborNotesFile(notesBytes([candidate]), "TEST-daily.xlsx", "supercrew", period, {
      ...notesOptions,
      scope: "daily_timesheet",
    });
    expect((await loadLaborDashboard()).notes[0].dailyVerified).toBe(true);
    await verifyLaborNote(candidate.id, false);
    expect((await loadLaborDashboard()).notes[0]).toMatchObject({
      dailyVerified: false,
      dailyRejected: true,
    });
  });
});

describe("reviewed hourly rates and weekly overtime", () => {
  it("saves estimates without changing source costs or excluding inactive history", async () => {
    const original = bytes(report([row("2026-09-24", 8)]));
    const imported = await ingestLaborFile(original, "TEST.xlsx", "upload");
    const before = await loadLaborDashboard();
    const settings = {
      workerRates: [{ workerName: "TEST worker", hourlyRateCents: 2100, active: false }],
      overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
    };
    const saved = await updateLaborPaySettings(settings, before.payRevision);
    expect(saved.payRevision).toBe(1);
    const after = await loadLaborDashboard();
    expect(after.entries).toEqual(before.entries);
    expect(after.rules).toEqual(before.rules);
    expect(after.rulesRevision).toBe(before.rulesRevision);
    expect(after.overview.reportedCostCents).toBe(0);
    expect(after.paySettings).toEqual(settings);
    expect(after.payroll.workerWeeks[0]).toMatchObject({
      active: false,
      paidHours: 7.5,
      estimatedPayCents: 15750,
      complete: false,
    });
    const savedOriginal = await originalLaborFile(imported.import.id);
    if (!savedOriginal) throw new Error("The original workbook is missing");
    expect(new Uint8Array(savedOriginal.bytes)).toEqual(original);
    await expect(updateLaborPaySettings(settings, before.payRevision)).rejects.toThrow("Stale");
  });

  it("keeps one saved pay profile when imported worker name formatting changes", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST-first.xlsx", "upload");
    await updateLaborPaySettings(
      {
        workerRates: [{ workerName: "TEST worker", hourlyRateCents: 2400, active: false }],
        overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
      },
      0,
    );
    await ingestLaborFile(
      bytes(
        report([row("2026-09-24", 1), { ...row("2026-09-25", 1), workerName: "test   worker" }]),
      ),
      "TEST-name-format.xlsx",
      "upload",
    );
    const dashboard = await loadLaborDashboard();
    expect(dashboard.paySettings.workerRates).toEqual([
      { workerName: "TEST worker", hourlyRateCents: 2400, active: false },
    ]);
    expect(dashboard.payroll.workerWeeks).toHaveLength(1);
    expect(dashboard.payroll.workerWeeks[0]).toMatchObject({
      workerName: "TEST worker",
      paidHours: 2,
      estimatedPayCents: 4800,
      active: false,
    });
  });

  it("rejects invalid identities, duplicate profiles and fractional cents without saving", async () => {
    await ingestLaborFile(bytes(report([row("2026-09-24", 1)])), "TEST.xlsx", "upload");
    const worker = { workerName: "TEST worker", hourlyRateCents: 2885, active: true };
    const overtime = { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 };
    for (const settings of [
      { workerRates: [{ ...worker, workerName: "Unknown" }], overtime },
      { workerRates: [{ ...worker, hourlyRateCents: 28.85 }], overtime },
      { workerRates: [{ ...worker, hourlyRateCents: -1 }], overtime },
      { workerRates: [worker, worker], overtime },
      { workerRates: [worker], overtime: { ...overtime, multiplier: 0 } },
      { workerRates: [worker], overtime: { ...overtime, weekStartsOn: 7 } },
    ]) {
      await expect(updateLaborPaySettings(settings, 0)).rejects.toThrow();
    }
    expect((await loadLaborDashboard()).payRevision).toBe(0);
  });

  it("keeps unspecified rates unknown and proves full workweek coverage through no-work dates", async () => {
    await ingestLaborFile(
      bytes(report([row("2026-09-24", 1)], "2026-10-01 2:53:33 PM")),
      "TEST.xlsx",
      "upload",
    );
    const data = await loadLaborDashboard();
    expect(data.paySettings.workerRates[0].hourlyRateCents).toBeNull();
    expect(data.payroll.workerWeeks[0]).toMatchObject({
      weekStart: "2026-09-24",
      weekEnd: "2026-09-30",
      complete: true,
      estimatedPayCents: null,
    });
    expect(data.payroll.totals.unpricedHours).toBe(1);
    expect(data.payroll.totals.knownEstimatedPayCents).toBe(0);
  });
});
