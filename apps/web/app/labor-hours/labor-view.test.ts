import { describe, expect, it } from "vitest";
import {
  type DisplayEntry,
  EMPTY_LABOR_FILTERS,
  filterLaborEntries,
  sourceMoney,
  summarizeEntries,
} from "./labor-view";

const entry = (fields: Partial<DisplayEntry>): DisplayEntry => ({
  id: "entry-1",
  kind: "work",
  importId: "report-1",
  jobKey: "job-1",
  date: "2026-09-24",
  workerName: "Taylor",
  jobName: "Main Street",
  jobAddress: "10 Main St",
  clockIn: "08:00",
  clockOut: "09:00",
  clockInMethod: "Manual",
  clockOutMethod: "Manual",
  timeEntryType: "Work",
  crew: "Crew A",
  role: "Installer",
  jobCode: null,
  employeeId: null,
  hours: 1,
  travel: false,
  laborCostCents: 0,
  billableCostCents: 0,
  sourceRow: 13,
  ...fields,
});

describe("labor review filters and summaries", () => {
  const entries = [
    entry({ id: "work", hours: 7.5, laborCostCents: 15000 }),
    entry({ id: "travel", hours: 0.5, travel: true, timeEntryType: "Travel" }),
    entry({
      id: "other",
      workerName: "Morgan",
      jobKey: "job-2",
      jobName: "SVL",
      date: "2026-09-25",
      hours: 2,
    }),
  ];

  it("keeps travel in total hours while showing it separately", () => {
    const groups = summarizeEntries(entries, "worker");
    expect(groups[0].name).toBe("Taylor");
    expect(groups[0].hours).toBe(8);
    expect(groups[0].travelHours).toBe(0.5);
    expect(groups[0].entryCount).toBe(2);
    expect(groups[0].reportedCostCents).toBe(15000);
    expect(groups[0].jobs.size).toBe(1);
  });

  it("combines worker, job, inclusive work dates and case-insensitive source search", () => {
    expect(
      filterLaborEntries(entries, {
        ...EMPTY_LABOR_FILTERS,
        worker: "Taylor",
        job: "job-1",
        from: "2026-09-24",
        to: "2026-09-24",
        search: "MAIN st",
      }).map((item) => item.id),
    ).toEqual(["work", "travel"]);
    expect(filterLaborEntries(entries, { ...EMPTY_LABOR_FILTERS, from: "2026-09-25" })[0].id).toBe(
      "other",
    );
  });

  it("preserves separate worker/day groups and does not turn missing receipt amounts into zero", () => {
    const sameDay = [...entries, entry({ id: "morgan", workerName: "Morgan", hours: 3 })];
    expect(summarizeEntries(sameDay, "day")).toHaveLength(3);
    expect(sourceMoney(null)).toBe("Unavailable");
    expect(sourceMoney(0)).toBe("$0.00");
  });

  it("preserves signed unpaid-break adjustments in source totals without assigning them to a customer job", () => {
    const breakEntry = entry({
      id: "break",
      kind: "unpaid_break",
      jobKey: "breaks",
      jobName: "Unpaid Break",
      hours: -0.5,
      clockIn: "",
      clockOut: "",
    });
    const workers = summarizeEntries([...entries, breakEntry], "worker");
    expect(workers.find((item) => item.name === "Taylor")?.hours).toBe(7.5);
    const job = summarizeEntries([breakEntry], "job")[0];
    expect(job.name).toBe("Unpaid Break");
    expect(job.hours).toBe(-0.5);
    expect(job.travelHours).toBe(0);
  });
});
