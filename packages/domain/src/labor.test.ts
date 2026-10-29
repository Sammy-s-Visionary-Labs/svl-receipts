import { describe, expect, it } from "vitest";
import { groupLaborEntries, type LaborEntry, laborTotals, sourceJobKey } from "./labor";

const testEntry = (overrides: Partial<LaborEntry> = {}): LaborEntry => ({
  id: "TEST-LABOR-ENTRY",
  kind: "work",
  date: "2026-09-24",
  workerName: "TEST Worker",
  jobName: "TEST Customer Job",
  jobAddress: "TEST Address",
  clockIn: "08:00",
  clockOut: "09:00",
  clockInMethod: "AutoClock",
  clockOutMethod: "AutoClock",
  timeEntryType: "",
  crew: "",
  role: "TEST Role",
  jobCode: null,
  employeeId: null,
  hours: 1,
  travel: false,
  laborCostCents: 0,
  billableCostCents: 0,
  sourceRow: 13,
  ...overrides,
});

describe("source labor grouping", () => {
  it("includes travel once and retains source costs without inventing a rate", () => {
    const entries = [
      testEntry({ hours: 0.1 }),
      testEntry({ hours: 0.2, travel: true, laborCostCents: 123 }),
    ];
    expect(laborTotals(entries)).toEqual({
      hours: 0.3,
      travelHours: 0.2,
      laborCostCents: 123,
      billableCostCents: 0,
    });
    expect(groupLaborEntries(entries).jobs[0]).toMatchObject({
      hours: 0.3,
      travelHours: 0.2,
      reportedCostCents: 123,
      entryCount: 2,
      workerCount: 1,
    });
  });

  it("keeps a shop and customer destinations as their own source jobs", () => {
    const entries = [
      testEntry(),
      testEntry({ jobName: "TEST SVL Shop" }),
      testEntry({ workerName: "TEST Other Worker", jobAddress: "TEST Different Address" }),
    ];
    const groups = groupLaborEntries(entries);
    expect(groups.jobs).toHaveLength(3);
    expect(groups.workers).toHaveLength(2);
    expect(groups.workers.find((worker) => worker.name === "TEST Worker")?.jobCount).toBe(2);
    expect(sourceJobKey("A|B", "C")).not.toBe(sourceJobKey("A", "B|C"));
  });

  it("retains multiplicity and uses employee identifiers when supplied", () => {
    const entries = [testEntry(), testEntry(), testEntry({ employeeId: "TEST-ID-2" })];
    const groups = groupLaborEntries(entries);
    expect(groups.jobs[0]).toMatchObject({ hours: 3, entryCount: 3, workerCount: 2 });
    expect(groups.workers).toHaveLength(2);
  });
});
