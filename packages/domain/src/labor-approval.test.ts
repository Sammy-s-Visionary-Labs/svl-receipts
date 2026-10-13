import { describe, expect, it } from "vitest";
import { sourceJobKey } from "./labor";
import {
  allocateLaborHours,
  type LaborAllocationRules,
  type LaborEntryAllocation,
} from "./labor-allocation";
import {
  buildLaborApprovalSnapshot,
  canonicalLaborApprovalSnapshot,
  LABOR_APPROVAL_POINT_CLOCK_WARNING,
  type LaborApprovalSnapshotInput,
  type LaborApprovalSourceEntry,
} from "./labor-approval";
import { type LaborMappingCatalogJob, linkLaborAllocation } from "./labor-job-mapping";

const jobKey = sourceJobKey("TEST Customer", "TEST Address");
const shopKey = sourceJobKey("SVL", "TEST Shop");
const catalog: LaborMappingCatalogJob = {
  id: "job_test",
  customerId: "customer_test",
  customer: "TEST Customer",
  number: "1001",
  label: "TEST Job",
  address: "TEST Address",
  status: "scheduled",
  scheduledAt: null,
  active: true,
  unavailable: false,
  syncedAt: "2026-09-19T00:00:00Z",
  providerUpdatedAt: null,
};
const mapping = {
  sourceKey: jobKey,
  housecallJobId: catalog.id,
  fromDate: "2026-09-17",
  toDate: "2026-09-30",
  confirmedAt: "2026-09-19T00:00:00Z",
  confirmedBy: "00000000-0000-4000-8000-000000000001",
  method: "reviewed" as const,
};
function row(
  id: string,
  clockIn: string,
  clockOut: string,
  hours: number,
  kind: "work" | "travel",
  shop = false,
): LaborApprovalSourceEntry {
  return {
    id,
    clockIn,
    clockOut,
    hours,
    kind,
    workerName: "Worker, Test",
    employeeId: "employee_test",
    date: "2026-09-18",
    jobName: shop ? "SVL" : "TEST Customer",
    jobAddress: shop ? "TEST Shop" : "TEST Address",
    clockInMethod: "TEST",
    clockOutMethod: "TEST",
    timeEntryType: "TEST",
    crew: "TEST",
    role: "TEST",
    jobCode: null,
    travel: kind === "travel",
    laborCostCents: 99999,
    billableCostCents: 88888,
    sourceRow: Number(id.replace(/\D/g, "")) || 1,
    importId: "00000000-0000-4000-8000-000000000010",
    importHash: "a".repeat(64),
  };
}
function input(complete = true): LaborApprovalSnapshotInput {
  const sourceEntries = [
    row("row1", "07:00", "07:30", 0.5, "work", true),
    row("row2", "07:30", "08:00", 0.5, "travel"),
    row("row3", "08:00", "14:30", 6.5, "work"),
    row("row4", "14:30", "15:00", 0.5, "travel", true),
  ];
  const rules: LaborAllocationRules = {
    locations: [
      { sourceKey: shopKey, kind: "shop", job: null },
      {
        sourceKey: jobKey,
        kind: "customer",
        job: { key: jobKey, name: "TEST Customer", address: "TEST Address", housecallJobId: null },
      },
    ],
    jobAliases: [],
  };
  const allocation = linkLaborAllocation(
    allocateLaborHours({
      entries: sourceEntries,
      rules,
      completeDates: complete ? ["2026-09-18"] : [],
    }),
    [mapping],
    [catalog],
  );
  return {
    housecallJobId: catalog.id,
    fromDate: "2026-09-18",
    toDate: "2026-09-18",
    catalogJob: { ...catalog },
    allocation,
    sourceEntries,
  };
}
function append(value: LaborApprovalSnapshotInput, source: LaborApprovalSourceEntry) {
  const template = value.allocation.entries.find(
    (entry) => entry.sourceEntryId === "row3",
  ) as LaborEntryAllocation;
  value.sourceEntries = [...value.sourceEntries, source];
  value.allocation = {
    ...value.allocation,
    entries: [
      ...value.allocation.entries,
      {
        ...template,
        sourceEntryId: source.id,
        sourceRow: source.sourceRow,
        sourceHours: source.hours,
        allocatedHours: source.hours,
      },
    ],
    workerDays: value.allocation.workerDays.map((day) => ({
      ...day,
      grossHours: Math.round((day.grossHours + source.hours) * 100) / 100,
      sourceNetHours: Math.round((day.sourceNetHours + source.hours) * 100) / 100,
      netHours: Math.round((day.netHours + source.hours) * 100) / 100,
      allocatedHours: Math.round((day.allocatedHours + source.hours) * 100) / 100,
    })),
  };
}

describe("frozen job-hour approvals", () => {
  it("freezes linked source hours before lunch while retaining complete day/payroll evidence", () => {
    const snapshot = buildLaborApprovalSnapshot(input());
    expect(snapshot.totalHourHundredths).toBe(700);
    expect(snapshot.travelHourHundredths).toBe(50);
    expect(snapshot.entries.map((entry) => entry.sourceEntryId)).toEqual(["row2", "row3"]);
    expect(snapshot.workerDays[0]).toMatchObject({
      grossHours: 8,
      lunchAdjustmentHours: -0.5,
      netHours: 7.5,
      excludedHours: 1,
    });
    expect(snapshot).toMatchObject({
      customerId: "customer_test",
      jobNumber: "1001",
      hourBasis: "allocated_source_hours_before_day_lunch",
      disclosures: { lunchRedistributed: false, wageCostsIncluded: false },
    });
    expect(canonicalLaborApprovalSnapshot(snapshot)).not.toContain("99999");
  });
  it("retains original source identity alongside corrected destination and mapping provenance", () => {
    const value = input();
    const changed = value.allocation.entries.map((entry) =>
      entry.sourceEntryId === "row3"
        ? {
            ...entry,
            sourceJobKey: sourceJobKey("TEST A", "TEST A address"),
            reason: "daily_comment",
            noteIds: ["note_test"],
          }
        : entry,
    );
    value.allocation = { ...value.allocation, entries: changed };
    const source = value.sourceEntries.find(
      (entry) => entry.id === "row3",
    ) as LaborApprovalSourceEntry;
    source.jobName = "TEST A";
    source.jobAddress = "TEST A address";
    const snapshot = buildLaborApprovalSnapshot(value);
    expect(snapshot.entries[1]).toMatchObject({
      sourceJobKey: sourceJobKey("TEST A", "TEST A address"),
      destinationSourceKey: jobKey,
      reason: "daily_comment",
      noteIds: ["note_test"],
      sourceFileSha256: "a".repeat(64),
      jobMapping: mapping,
    });
  });
  it("does not share mutable source, note or mapping references", () => {
    const value = input();
    const snapshot = buildLaborApprovalSnapshot(value);
    const before = canonicalLaborApprovalSnapshot(snapshot);
    (value.sourceEntries[1] as LaborApprovalSourceEntry).hours = 99;
    (value.allocation.entries[1]?.jobMapping as { confirmedAt: string }).confirmedAt = "changed";
    expect(canonicalLaborApprovalSnapshot(snapshot)).toBe(before);
  });
  it("canonicalizes property order and normalizes source ordering", () => {
    const value = input();
    const first = buildLaborApprovalSnapshot(value);
    value.sourceEntries = [...value.sourceEntries].reverse();
    value.allocation = { ...value.allocation, entries: [...value.allocation.entries].reverse() };
    const second = buildLaborApprovalSnapshot(value);
    expect(canonicalLaborApprovalSnapshot(second)).toBe(canonicalLaborApprovalSnapshot(first));
    expect(
      canonicalLaborApprovalSnapshot({
        ...first,
        entries: first.entries.map(
          (entry) => Object.fromEntries(Object.entries(entry).reverse()) as typeof entry,
        ),
      }),
    ).toBe(canonicalLaborApprovalSnapshot(first));
  });
  it("discloses unresolved period hours without adding them to approved hours", () => {
    const value = input();
    value.allocation = {
      ...value.allocation,
      entries: [
        ...value.allocation.entries,
        {
          ...(value.allocation.entries[0] as LaborEntryAllocation),
          sourceEntryId: "pending_test",
          status: "pending",
          sourceHours: 3,
          allocatedHours: 0,
          excludedHours: 0,
          pendingHours: 3,
        },
      ],
    };
    const snapshot = buildLaborApprovalSnapshot(value);
    expect(snapshot.totalHourHundredths).toBe(700);
    expect(snapshot.unresolved).toEqual({ entryCount: 1, hourHundredths: 300 });
  });
  it.each(["2026-02-30", "2026-09-31", "bad"])("rejects invalid calendar scope %s", (fromDate) => {
    expect(() => buildLaborApprovalSnapshot({ ...input(), fromDate })).toThrow(
      "valid work-date range",
    );
  });
  it("requires a linked current destination, customer and immutable original provenance", () => {
    const value = input();
    value.catalogJob = { ...value.catalogJob, customerId: null };
    expect(() => buildLaborApprovalSnapshot(value)).toThrow("confirmed Housecall customer");
    const missing = input();
    missing.sourceEntries = missing.sourceEntries.filter((entry) => entry.id !== "row2");
    expect(() => buildLaborApprovalSnapshot(missing)).toThrow("source provenance");
    const unlinked = input();
    unlinked.allocation = {
      ...unlinked.allocation,
      entries: unlinked.allocation.entries.map((entry) => ({ ...entry, jobMapping: undefined })),
    };
    expect(() => buildLaborApprovalSnapshot(unlinked)).toThrow("source provenance");
  });
  it("blocks provisional source days and unknown/overnight clocks", () => {
    expect(() => buildLaborApprovalSnapshot(input(false))).toThrow("completed source dates");
    for (const clockOut of ["", "07:00"]) {
      const value = input();
      (value.sourceEntries[1] as LaborApprovalSourceEntry).clockOut = clockOut;
      expect(() => buildLaborApprovalSnapshot(value)).toThrow("clock boundaries");
    }
  });
  it("freezes reviewed clock-duration warnings instead of silently changing source Hours", () => {
    const value = input();
    (value.sourceEntries[2] as LaborApprovalSourceEntry).clockOut = "14:40";
    value.allocation = {
      ...value.allocation,
      entries: value.allocation.entries.map((entry) =>
        entry.sourceEntryId === "row3"
          ? { ...entry, reviewReasons: ["TEST manager-reviewed duration difference"] }
          : entry,
      ),
    };
    const snapshot = buildLaborApprovalSnapshot(value);
    expect(snapshot.totalHourHundredths).toBe(700);
    expect(snapshot.entries[1]?.reviewReasons).toEqual([
      "TEST manager-reviewed duration difference",
    ]);
  });
  it("rejects real overlapping spans even if replacement entry IDs differ", () => {
    const value = input();
    const duplicate = {
      ...(value.sourceEntries[2] as LaborApprovalSourceEntry),
      id: "replacement_row3",
      sourceRow: 8,
    };
    value.sourceEntries = [...value.sourceEntries, duplicate];
    value.allocation = {
      ...value.allocation,
      entries: [
        ...value.allocation.entries,
        {
          ...(value.allocation.entries.find(
            (entry) => entry.sourceEntryId === "row3",
          ) as LaborEntryAllocation),
          sourceEntryId: duplicate.id,
          sourceRow: duplicate.sourceRow,
        },
      ],
    };
    expect(() => buildLaborApprovalSnapshot(value)).toThrow("overlapping source intervals");
  });
  it("omits zero-hour allocated rows without changing the retained source or positive approval", () => {
    const value = input();
    const zero = row("row_zero_5", "", "", 0, "work");
    append(value, zero);
    const before = JSON.stringify(value.sourceEntries);
    const snapshot = buildLaborApprovalSnapshot(value);
    expect(snapshot.entries.map((entry) => entry.sourceEntryId)).toEqual(["row2", "row3"]);
    expect(snapshot.totalHourHundredths).toBe(700);
    expect(JSON.stringify(value.sourceEntries)).toBe(before);
    expect(value.sourceEntries).toContain(zero);
  });
  it.each([0.01, 0.02])("preserves same-minute %s hour source rows as reviewed points", (hours) => {
    const value = input();
    append(value, row("row_point_5", "15:00", "15:00", hours, "work"));
    const snapshot = buildLaborApprovalSnapshot(value);
    const point = snapshot.entries.find((entry) => entry.sourceEntryId === "row_point_5");
    expect(point).toMatchObject({
      clockIn: "15:00",
      clockOut: "15:00",
      startMinute: 900,
      endMinute: 900,
      hourHundredths: Math.round(hours * 100),
      reviewReasons: [LABOR_APPROVAL_POINT_CLOCK_WARNING],
    });
    expect(snapshot.totalHourHundredths).toBe(700 + Math.round(hours * 100));
  });
  it("retains multiple distinct source points at one minute within one approval", () => {
    const value = input();
    append(value, row("row_point_5", "15:00", "15:00", 0.01, "work"));
    append(value, row("row_point_6", "15:00", "15:00", 0.01, "work"));
    const snapshot = buildLaborApprovalSnapshot(value);
    expect(
      snapshot.entries
        .filter((entry) => entry.startMinute === 900)
        .map((entry) => entry.sourceEntryId),
    ).toEqual(["row_point_5", "row_point_6"]);
    expect(snapshot.totalHourHundredths).toBe(702);
  });
  it.each(["07:30", "08:00", "14:30"])(
    "allows point rows exactly on a positive interval boundary %s",
    (clock) => {
      const value = input();
      append(value, row("row_point_5", clock, clock, 0.01, "work"));
      expect(buildLaborApprovalSnapshot(value).totalHourHundredths).toBe(701);
    },
  );
  it("blocks point rows strictly inside positive work, larger same-minute hours, missing and reverse clocks", () => {
    const inside = input();
    append(inside, row("row_point_5", "08:30", "08:30", 0.01, "work"));
    expect(() => buildLaborApprovalSnapshot(inside)).toThrow("overlapping source intervals");
    for (const source of [
      row("row_point_5", "15:00", "15:00", 0.03, "work"),
      row("row_point_5", "15:00", "14:59", 0.01, "work"),
      row("row_point_5", "", "15:00", 0.01, "work"),
    ]) {
      const value = input();
      append(value, source);
      expect(() => buildLaborApprovalSnapshot(value)).toThrow("clock boundaries");
    }
  });
});
