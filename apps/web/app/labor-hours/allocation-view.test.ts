import type { LaborEntryAllocation, LaborWorkerDayAllocation } from "@svl/domain";
import { describe, expect, it } from "vitest";
import {
  allocatedJobRows,
  allocatedWorkerDays,
  EMPTY_ALLOCATION_FILTERS,
  filterAllocationEntries,
  filterWorkerDays,
  laborNoteMatchesWorker,
} from "./allocation-view";

const allocation = (fields: Partial<LaborEntryAllocation>): LaborEntryAllocation => ({
  sourceEntryId: "entry",
  sourceRow: 13,
  date: "2026-09-24",
  workerName: "Worker A",
  sourceJobKey: "supplier",
  sourceKind: "travel",
  sourceHours: 2,
  status: "allocated",
  job: { key: "customer-a", name: "Customer A", address: "10 Main St", housecallJobId: null },
  allocatedHours: 2,
  excludedHours: 0,
  pendingHours: 0,
  reason: "next_customer_job",
  reviewReasons: [],
  noteIds: [],
  ...fields,
});

describe("allocation display accounting", () => {
  it("filters both confirmed names and combines job/day counts without rewriting source decisions", () => {
    const aliases = [{ alias: "TEST old name", workerName: "TEST Canonical" }];
    const rows = [
      allocation({ sourceEntryId: "old", workerName: "TEST old name" }),
      allocation({ sourceEntryId: "new", workerName: "TEST Canonical" }),
      allocation({ sourceEntryId: "other", workerName: "TEST Other" }),
    ];
    const original = structuredClone(rows);
    const selected = filterAllocationEntries(
      rows,
      { ...EMPTY_ALLOCATION_FILTERS, worker: "TEST Canonical" },
      aliases,
    );
    expect(selected.map((row) => row.sourceEntryId)).toEqual(["old", "new"]);
    expect(allocatedJobRows(selected, aliases)[0].workers).toEqual(new Set(["TEST Canonical"]));
    expect(allocatedWorkerDays(selected, aliases)).toMatchObject([
      { workerName: "TEST Canonical", hours: 4, entryCount: 2 },
    ]);
    expect(rows).toEqual(original);
  });

  it("matches daily comments through reviewed note aliases and confirmed worker identities", () => {
    const aliases = [{ alias: "TEST old name", workerName: "TEST Canonical" }];
    const noteAliases = [{ alias: "TEST nickname", workerName: "TEST old name" }];
    for (const name of ["TEST old name", "TEST Canonical", "TEST nickname"])
      expect(laborNoteMatchesWorker(name, "TEST Canonical", noteAliases, aliases)).toBe(true);
    expect(laborNoteMatchesWorker("TEST Other", "TEST Canonical", noteAliases, aliases)).toBe(
      false,
    );
    expect(laborNoteMatchesWorker("TEST Other", "", noteAliases, aliases)).toBe(true);
  });

  it("groups by the allocated destination, preserves source travel, and leaves pending/excluded intervals out", () => {
    const rows = [
      allocation({ sourceEntryId: "travel" }),
      allocation({
        sourceEntryId: "stop",
        sourceKind: "work",
        allocatedHours: 0.25,
        sourceHours: 0.25,
      }),
      allocation({
        sourceEntryId: "pending",
        status: "pending",
        job: null,
        allocatedHours: 0,
        pendingHours: 2,
      }),
      allocation({
        sourceEntryId: "shop",
        status: "excluded",
        job: null,
        allocatedHours: 0,
        excludedHours: 1,
      }),
    ];
    const jobs = allocatedJobRows(rows);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].job.key).toBe("customer-a");
    expect(jobs[0].hours).toBe(2.25);
    expect(jobs[0].entryCount).toBe(2);
    expect(allocatedWorkerDays(rows)[0].sourceTravelHours).toBe(2);
  });

  it("keeps full worker-day lunch accounting independent of an entry decision filter", () => {
    const day: LaborWorkerDayAllocation = {
      key: "day",
      date: "2026-09-24",
      workerName: "Worker A",
      grossHours: 8,
      sourceBreakHours: -0.5,
      sourceNetHours: 7.5,
      lunchAdjustmentHours: -0.5,
      breakDifferenceHours: 0,
      netHours: 7.5,
      allocatedHours: 6,
      excludedHours: 2,
      pendingHours: 0,
      reviewReasons: [],
    };
    const filters = {
      ...EMPTY_ALLOCATION_FILTERS,
      status: "pending",
      from: "2026-09-24",
      to: "2026-09-24",
    };
    expect(filterWorkerDays([day], filters)[0].netHours).toBe(7.5);
    expect(filterWorkerDays([day], filters)[0].allocatedHours).toBe(6);
    expect(filterAllocationEntries([allocation({})], filters)).toHaveLength(0);
  });
});
