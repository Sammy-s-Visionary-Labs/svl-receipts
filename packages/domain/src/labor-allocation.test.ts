import { describe, expect, it } from "vitest";
import { type LaborEntry, sourceJobKey } from "./labor";
import {
  allocateLaborHours,
  type LaborAllocationInput,
  type LaborAllocationJob,
  type LaborAllocationRules,
  type LaborNote,
  normalizeLaborWorkerName,
} from "./labor-allocation";

const date = "2026-09-24";
const location = (name: string) => sourceJobKey(name, "TEST Address");
const destination = (name: string): LaborAllocationJob => ({
  key: location(name),
  name,
  address: "TEST Address",
  housecallJobId: null,
});
const rules: LaborAllocationRules = {
  locations: [
    { sourceKey: location("TEST SVL"), kind: "shop", job: null },
    { sourceKey: location("TEST Supplier"), kind: "supplier", job: null },
    { sourceKey: location("TEST Breakfast"), kind: "excluded", job: null },
    { sourceKey: location("TEST Job A"), kind: "customer", job: destination("TEST Job A") },
    { sourceKey: location("TEST Job B"), kind: "customer", job: destination("TEST Job B") },
  ],
  jobAliases: [{ alias: "Other-TEST Job A", sourceKey: location("TEST Job A") }],
};
const minutes = (clock: string) => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
const row = (
  id: string,
  jobName: string,
  clockIn: string,
  clockOut: string,
  overrides: Partial<LaborEntry> = {},
): LaborEntry => ({
  id: `TEST-${id}`,
  kind: "work",
  date,
  workerName: "Cousino, Michael",
  jobName,
  jobAddress: "TEST Address",
  clockIn,
  clockOut,
  clockInMethod: "AutoClock",
  clockOutMethod: "AutoClock",
  timeEntryType: "",
  crew: "",
  role: "",
  jobCode: null,
  employeeId: null,
  hours: Math.round(((minutes(clockOut) - minutes(clockIn)) / 60) * 100) / 100,
  travel: false,
  laborCostCents: 1234,
  billableCostCents: 0,
  sourceRow: 13,
  ...overrides,
});
const travel = (
  id: string,
  jobName: string,
  clockIn: string,
  clockOut: string,
  overrides: Partial<LaborEntry> = {},
) =>
  row(id, jobName, clockIn, clockOut, {
    kind: "travel",
    travel: true,
    clockInMethod: "Travel Time",
    clockOutMethod: "Travel Time",
    ...overrides,
  });
const sourceBreak = (hours = -0.5, id = "BREAK") =>
  row(id, "Unpaid Break", "", "", {
    kind: "unpaid_break",
    jobAddress: "",
    clockInMethod: "Unpaid Break",
    clockOutMethod: "Unpaid Break",
    hours,
    laborCostCents: -1400,
  });
const note = (overrides: Partial<LaborNote> = {}): LaborNote => ({
  id: "TEST-NOTE",
  date,
  rawDate: "2026-09-24 04:00:00",
  workerName: "Michael Cousino",
  notetaker: "TEST Different Editor",
  text: "Other-TEST Job A",
  project: "",
  punchInfo: "",
  punchDuration: "",
  sourceRow: 2,
  kind: "daily_candidate",
  ...overrides,
});
const calculate = (entries: LaborEntry[], options: Partial<LaborAllocationInput> = {}) =>
  allocateLaborHours({ entries, rules, completeDates: [date], ...options });
const dailyCoverage = {
  from: date,
  to: date,
  complete: true,
  dailyOnly: true,
  datesVerified: true,
};

describe("Marcy development labor allocation", () => {
  it("assigns initial supplier and interjob shop/supplier chains to the next job, excluding only the initial and final SVL", () => {
    const entries = [
      row("INITIAL", "TEST SVL", "07:00", "07:30"),
      travel("TO-SELLER", "TEST Supplier", "07:30", "07:45"),
      row("SELLER", "TEST Supplier", "07:45", "08:00"),
      travel("TO-A", "TEST Job A", "08:00", "08:15"),
      row("A", "TEST Job A", "08:15", "10:15"),
      travel("TO-SVL", "TEST SVL", "10:15", "10:30"),
      row("MID-SVL", "TEST SVL", "10:30", "10:45"),
      travel("TO-SELLER-2", "TEST Supplier", "10:45", "11:00"),
      row("SELLER-2", "TEST Supplier", "11:00", "11:15"),
      travel("TO-B", "TEST Job B", "11:15", "11:30"),
      row("B", "TEST Job B", "11:30", "13:30"),
      travel("RETURN", "TEST SVL", "13:30", "13:45"),
      row("FINAL", "TEST SVL", "13:45", "15:00"),
      sourceBreak(),
    ];
    const original = JSON.stringify(entries);
    const report = calculate(entries);
    expect(report.jobs.map((job) => [job.job.name, job.hours])).toEqual([
      ["TEST Job A", 2.75],
      ["TEST Job B", 3.25],
    ]);
    expect(report.totals).toEqual({
      grossHours: 8,
      sourceBreakHours: -0.5,
      sourceNetHours: 7.5,
      lunchAdjustmentHours: -0.5,
      netHours: 7.5,
      allocatedHours: 6,
      excludedHours: 2,
      pendingHours: 0,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MID-SVL")?.job?.name).toBe(
      "TEST Job B",
    );
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-RETURN")?.reason).toBe(
      "final_return",
    );
    expect(report.jobs.every((job) => job.costCents === null)).toBe(true);
    expect(JSON.stringify(entries)).toBe(original);
    expect(Object.isFrozen(report.entries[0])).toBe(true);
  });

  it("excludes a reviewed breakfast stop and its travel while supplier chains still reach the next customer", () => {
    const entries = [
      row("INITIAL", "TEST SVL", "07:00", "07:30"),
      travel("TO-SELLER", "TEST Supplier", "07:30", "07:45"),
      row("SELLER", "TEST Supplier", "07:45", "08:00"),
      travel("TO-A", "TEST Job A", "08:00", "08:15"),
      row("A", "TEST Job A", "08:15", "11:15"),
      travel("TO-BREAKFAST", "TEST Breakfast", "11:15", "11:30"),
      row("BREAKFAST", "TEST Breakfast", "11:30", "12:00"),
      travel("TO-SELLER-2", "TEST Supplier", "12:00", "12:15"),
      row("SELLER-2", "TEST Supplier", "12:15", "12:30"),
      travel("TO-B", "TEST Job B", "12:30", "12:45"),
      row("B", "TEST Job B", "12:45", "14:45"),
      travel("RETURN", "TEST SVL", "14:45", "15:00"),
      row("FINAL", "TEST SVL", "15:00", "15:30"),
      sourceBreak(),
    ];
    const original = JSON.stringify(entries);
    const report = calculate(entries);
    expect(report.jobs.map((job) => [job.job.name, job.hours])).toEqual([
      ["TEST Job A", 3.75],
      ["TEST Job B", 2.75],
    ]);
    expect(report.totals).toMatchObject({
      grossHours: 8.5,
      allocatedHours: 6.5,
      excludedHours: 2,
      pendingHours: 0,
      lunchAdjustmentHours: -0.5,
      sourceNetHours: 8,
      netHours: 8,
    });
    for (const id of ["TEST-TO-BREAKFAST", "TEST-BREAKFAST"])
      expect(report.entries.find((entry) => entry.sourceEntryId === id)).toMatchObject({
        status: "excluded",
        reason: "excluded_location",
        job: null,
        allocatedHours: 0,
        pendingHours: 0,
      });
    expect(JSON.stringify(entries)).toBe(original);
  });

  it("does not turn excluded long travel into a customer anchor or block another verified travel correction", () => {
    const report = calculate(
      [
        row("SELLER", "TEST Supplier", "08:00", "08:15"),
        travel("BREAKFAST-TRAVEL", "TEST Breakfast", "08:15", "10:15"),
        row("BREAKFAST", "TEST Breakfast", "10:15", "10:30"),
        travel("MISSED", "TEST SVL", "10:30", "12:30"),
        row("B", "TEST Job B", "12:30", "13:30"),
      ],
      { notes: [note()], notesCoverage: dailyCoverage },
    );
    expect(report.jobs.map((job) => [job.job.name, job.hours])).toEqual([
      ["TEST Job A", 2.25],
      ["TEST Job B", 1],
    ]);
    expect(
      report.entries.find((entry) => entry.sourceEntryId === "TEST-BREAKFAST-TRAVEL"),
    ).toMatchObject({
      status: "excluded",
      reason: "excluded_location",
      excludedHours: 2,
      job: null,
      noteIds: [],
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MISSED")).toMatchObject({
      status: "allocated",
      reason: "daily_comment",
      allocatedHours: 2,
    });
    expect(report.totals).toMatchObject({
      grossHours: 5.5,
      allocatedHours: 3.25,
      excludedHours: 2.25,
      pendingHours: 0,
    });
  });

  it("retains complete-day gross hours and one lunch adjustment when reviewed excluded hours supply half the day", () => {
    const entries = [
      row("A", "TEST Job A", "08:00", "11:00"),
      row("BREAKFAST", "TEST Breakfast", "11:00", "14:00"),
      sourceBreak(),
    ];
    const report = calculate(entries, { completeDates: [] });
    expect(report.workerDays[0]).toMatchObject({
      grossHours: 6,
      sourceBreakHours: -0.5,
      sourceNetHours: 5.5,
      lunchAdjustmentHours: -0.5,
      netHours: 5.5,
      allocatedHours: 3,
      excludedHours: 3,
      pendingHours: 0,
    });
    expect(report.jobs[0]?.hours).toBe(3);
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-BREAKFAST")).toMatchObject({
      reason: "excluded_location",
      status: "excluded",
      sourceHours: 3,
    });
    expect(
      report.totals.allocatedHours + report.totals.excludedHours + report.totals.pendingHours,
    ).toBe(report.totals.grossHours);
    expect(report.entries.filter((entry) => entry.status === "day_adjustment")).toHaveLength(1);
  });

  it("keeps explicit exclusions and their clock warnings visible without suppressing other overlap review", () => {
    const report = calculate([
      row("A", "TEST Job A", "08:00", "10:00"),
      row("BREAKFAST", "TEST Breakfast", "09:30", "10:30", { hours: 0.75 }),
    ]);
    const excluded = report.entries.find((entry) => entry.sourceEntryId === "TEST-BREAKFAST");
    expect(excluded).toMatchObject({
      status: "excluded",
      reason: "excluded_location",
      excludedHours: 0.75,
      sourceHours: 0.75,
      pendingHours: 0,
      job: null,
    });
    expect(excluded?.reviewReasons.join(" ")).toContain("Clock duration differs");
    expect(excluded?.reviewReasons.join(" ")).toContain("Overlapping");
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-A")).toMatchObject({
      status: "pending",
      pendingHours: 2,
    });
    expect(report.totals).toMatchObject({ grossHours: 2.75, excludedHours: 0.75, pendingHours: 2 });
  });

  it("preserves opening shop and final-return exclusions around explicitly excluded stops", () => {
    const report = calculate([
      row("BEFORE", "TEST Breakfast", "07:45", "08:00"),
      row("INITIAL", "TEST SVL", "08:00", "08:30"),
      travel("TO-A", "TEST Job A", "08:30", "08:45"),
      row("A", "TEST Job A", "08:45", "09:45"),
      row("BREAKFAST", "TEST Breakfast", "09:45", "10:00"),
      travel("RETURN", "TEST SVL", "10:00", "10:15"),
      row("FINAL", "TEST SVL", "10:15", "10:45"),
      row("AFTER", "TEST Breakfast", "10:45", "11:00"),
    ]);
    expect(report.totals).toMatchObject({
      grossHours: 3.25,
      allocatedHours: 1.25,
      excludedHours: 2,
      pendingHours: 0,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-INITIAL")?.reason).toBe(
      "initial_shop",
    );
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-RETURN")?.reason).toBe(
      "final_return",
    );
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-FINAL")?.reason).toBe(
      "final_shop",
    );
    const withoutShop = calculate([
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("TO-STOP", "TEST Supplier", "09:00", "09:15"),
      row("STOP", "TEST Breakfast", "09:15", "09:30"),
    ]);
    expect(
      withoutShop.entries.find((entry) => entry.sourceEntryId === "TEST-TO-STOP"),
    ).toMatchObject({ status: "pending", pendingHours: 0.25 });
  });

  it("assigns a shop interlude back to the same returning job", () => {
    const report = calculate([
      row("A1", "TEST Job A", "08:00", "09:00"),
      travel("TO-SHOP", "TEST SVL", "09:00", "09:15"),
      row("SHOP", "TEST SVL", "09:15", "09:30"),
      travel("BACK", "TEST Job A", "09:30", "09:45"),
      row("A2", "TEST Job A", "09:45", "10:45"),
    ]);
    expect(report.jobs[0]?.hours).toBe(2.75);
    expect(report.totals.excludedHours).toBe(0);
  });

  it("does not assign a terminal supplier stop to a previous or next-day job", () => {
    const report = calculate([
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("SELLER", "TEST Supplier", "09:00", "09:15"),
      row("STOP", "TEST Supplier", "09:15", "09:45"),
      travel("SHOP", "TEST SVL", "09:45", "10:00"),
      row("FINAL", "TEST SVL", "10:00", "10:30"),
    ]);
    expect(report.totals).toMatchObject({ allocatedHours: 1, pendingHours: 1, excludedHours: 0.5 });
  });

  it("excludes an ordinary final return explicitly to the reviewed shop without a trailing shop work row", () => {
    const report = calculate([
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("RETURN", "TEST SVL", "09:00", "09:15"),
    ]);
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-RETURN")).toMatchObject({
      status: "excluded",
      reason: "final_return",
      excludedHours: 0.25,
      job: null,
      reviewReasons: [],
    });
    expect(report.totals).toMatchObject({
      grossHours: 1.25,
      allocatedHours: 1,
      excludedHours: 0.25,
      pendingHours: 0,
    });
  });

  it("keeps travel-only returns pending without complete-day and continuous customer-departure evidence", () => {
    const direct = [
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("RETURN", "TEST SVL", "09:00", "09:15"),
    ];
    const provisional = calculate(direct, { completeDates: [] });
    expect(
      provisional.entries.find((entry) => entry.sourceEntryId === "TEST-RETURN"),
    ).toMatchObject({
      status: "pending",
      excludedHours: 0,
      pendingHours: 0.25,
    });
    expect(
      provisional.entries
        .find((entry) => entry.sourceEntryId === "TEST-RETURN")
        ?.reviewReasons.join(" "),
    ).toContain("provisional");
    const scenarios = [
      [row("A", "TEST Job A", "08:00", "09:00"), travel("RETURN", "TEST SVL", "09:06", "09:21")],
      [
        row("A", "TEST Job A", "08:00", "09:00", { hours: 0.9 }),
        travel("RETURN", "TEST SVL", "09:00", "09:15"),
      ],
      [
        row("A", "TEST Job A", "08:00", "09:00"),
        row("STOP", "TEST Supplier", "09:00", "09:15"),
        travel("RETURN", "TEST SVL", "09:15", "09:30"),
      ],
      [
        row("A", "TEST Job A", "08:00", "09:00"),
        row("UNKNOWN", "TEST Unknown", "09:00", "09:15"),
        travel("RETURN", "TEST SVL", "09:15", "09:30"),
      ],
      [
        row("A", "TEST Job A", "08:00", "09:00"),
        travel("MISSED", "TEST Supplier", "09:00", "11:00"),
        travel("RETURN", "TEST SVL", "11:00", "11:15"),
      ],
      [
        row("A", "TEST Job A", "08:00", "09:00"),
        travel("RETURN", "TEST Supplier", "09:00", "09:15"),
      ],
    ];
    for (const entries of scenarios) {
      const report = calculate(entries);
      expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-RETURN")).toMatchObject({
        status: "pending",
        excludedHours: 0,
      });
    }
  });

  it("leaves final exclusions provisional unless that individual date is complete", () => {
    const entries = [
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("RETURN", "TEST SVL", "09:00", "09:15"),
      row("FINAL", "TEST SVL", "09:15", "09:45"),
    ];
    const report = calculate(entries, { completeDates: ["2026-09-23"] });
    expect(report.totals).toMatchObject({
      allocatedHours: 1,
      excludedHours: 0,
      pendingHours: 0.75,
    });
  });

  it("stops a travel assignment at an unclassified possible destination", () => {
    const report = calculate([
      travel("FIRST", "TEST Unknown", "08:00", "08:15"),
      row("UNKNOWN", "TEST Unknown", "08:15", "08:45"),
      travel("TO-B", "TEST Job B", "08:45", "09:00"),
      row("B", "TEST Job B", "09:00", "10:00"),
    ]);
    expect(report.totals).toMatchObject({ allocatedHours: 1.25, pendingHours: 0.75 });
    expect(report.entries[0]?.job).toBeNull();
  });

  it("uses the Employee's verified daily comment for one >=2h travel interval while preserving other jobs and source labels", () => {
    const source = travel("MISSED", "TEST SVL", "08:00", "10:00");
    const report = calculate([source, row("B", "TEST Job B", "10:00", "11:00")], {
      notes: [note()],
      notesCoverages: [dailyCoverage],
    });
    expect(report.jobs.map((job) => [job.job.name, job.hours])).toEqual([
      ["TEST Job A", 2],
      ["TEST Job B", 1],
    ]);
    expect(report.entries[0]).toMatchObject({
      sourceKind: "travel",
      reason: "daily_comment",
      sourceHours: 2,
      noteIds: ["TEST-NOTE"],
    });
    expect(source).toMatchObject({ jobName: "TEST SVL", kind: "travel", travel: true });
    expect(normalizeLaborWorkerName(" Cousino,   Michael ")).toBe(
      normalizeLaborWorkerName("Michael Cousino"),
    );
  });

  it("retains a useful exact job suggestion without trusting mixed notes or filling coverage gaps", () => {
    const entries = [travel("MISSED", "TEST SVL", "08:00", "10:00")];
    const mixed = calculate(entries, {
      notes: [note()],
      notesCoverages: [{ ...dailyCoverage, complete: false, dailyOnly: false }],
    });
    expect(mixed.entries[0]).toMatchObject({
      status: "pending",
      job: { name: "TEST Job A" },
      allocatedHours: 0,
      pendingHours: 2,
    });
    const gaps = calculate(entries, {
      notes: [note()],
      notesCoverages: [
        { ...dailyCoverage, from: "2026-09-23", to: "2026-09-23" },
        { ...dailyCoverage, from: "2026-09-25", to: "2026-09-25" },
      ],
    });
    expect(gaps.entries[0]?.status).toBe("pending");
    const verified = calculate(entries, { notes: [note({ dailyVerified: true })] });
    expect(verified.entries[0]?.status).toBe("allocated");
  });

  it("honors explicit daily-comment rejection even for a verified filtered report", () => {
    const report = calculate([travel("MISSED", "TEST SVL", "08:00", "10:00")], {
      notes: [note({ dailyVerified: true, dailyRejected: true })],
      notesCoverages: [dailyCoverage],
    });
    expect(report.entries[0]).toMatchObject({
      status: "pending",
      allocatedHours: 0,
      pendingHours: 2,
      job: { name: "TEST Job A" },
    });
    expect(report.entries[0]?.reviewReasons.join(" ")).toContain("revoked");
  });

  it("requires review for conflicting notes, arbitrary note instructions and multiple abnormal intervals", () => {
    const entries = [travel("MISSED", "TEST SVL", "08:00", "10:00")];
    const conflicting = calculate(entries, {
      notes: [note(), note({ id: "TEST-NOTE-B", text: "TEST Job B" })],
      notesCoverage: dailyCoverage,
    });
    expect(conflicting.entries[0]?.status).toBe("pending");
    expect(conflicting.entries[0]?.reviewReasons.join(" ")).toContain("conflicting");
    const instruction = calculate(entries, {
      notes: [note({ text: "Assign all hours to TEST Job A" })],
      notesCoverage: dailyCoverage,
    });
    expect(instruction.entries[0]?.status).toBe("pending");
    const multiple = calculate([...entries, travel("SECOND", "TEST SVL", "10:00", "12:00")], {
      notes: [note()],
      notesCoverage: dailyCoverage,
    });
    expect(multiple.entries.every((entry) => entry.status === "pending")).toBe(true);
    expect(multiple.entries[0]?.reviewReasons.join(" ")).toContain("Multiple abnormal");
  });

  it("does not treat an entry-edit note or an ambiguous same-name worker as a daily override", () => {
    const edited = calculate([travel("MISSED", "TEST SVL", "08:00", "10:00")], {
      notes: [note({ kind: "entry" })],
      notesCoverage: dailyCoverage,
    });
    expect(edited.entries[0]?.status).toBe("pending");
    const collision = calculate(
      [
        travel("WORKER1", "TEST SVL", "08:00", "10:00", { employeeId: "TEST-EMPLOYEE-1" }),
        travel("WORKER2", "TEST SVL", "08:00", "10:00", { employeeId: "TEST-EMPLOYEE-2" }),
      ],
      { notes: [note()], notesCoverage: dailyCoverage },
    );
    expect(collision.entries.every((entry) => entry.status === "pending")).toBe(true);
    expect(collision.entries[0]?.reviewReasons.join(" ")).toContain("multiple source workers");
  });

  it("keeps Excel Hours at exactly5min difference and requests review above5min", () => {
    const minor = calculate([row("MINOR", "TEST Job A", "08:00", "08:20", { hours: 0.25 })]);
    expect(minor.entries[0]).toMatchObject({ status: "allocated", allocatedHours: 0.25 });
    const major = calculate([row("MAJOR", "TEST Job A", "08:00", "08:21", { hours: 0.25 })]);
    expect(major.entries[0]).toMatchObject({
      status: "pending",
      sourceHours: 0.25,
      pendingHours: 0.25,
    });
  });

  it("preserves overlapping intervals and does not silently exclude a gapped final return", () => {
    const overlapping = calculate([
      row("A", "TEST Job A", "08:00", "09:00"),
      row("B", "TEST Job B", "08:30", "09:30"),
    ]);
    expect(overlapping.totals).toMatchObject({ grossHours: 2, pendingHours: 2, allocatedHours: 0 });
    const finalGap = calculate([
      row("A", "TEST Job A", "08:00", "09:00"),
      travel("RETURN", "TEST SVL", "09:15", "09:30"),
      row("FINAL", "TEST SVL", "09:30", "10:00"),
    ]);
    expect(finalGap.totals).toMatchObject({
      allocatedHours: 1,
      excludedHours: 0,
      pendingHours: 0.75,
    });
    expect(
      finalGap.entries
        .find((entry) => entry.sourceEntryId === "TEST-RETURN")
        ?.reviewReasons.join(" "),
    ).toContain("clock gap");
  });

  it("assigns the whole clear daily-comment interval even when it ends at the final shop", () => {
    const report = calculate(
      [travel("MISSED", "TEST SVL", "08:00", "10:00"), row("FINAL", "TEST SVL", "10:00", "10:30")],
      { notes: [note()], notesCoverage: dailyCoverage },
    );
    expect(report.entries[0]).toMatchObject({
      status: "allocated",
      reason: "daily_comment",
      allocatedHours: 2,
      job: { name: "TEST Job A" },
      reviewReasons: [],
    });
    expect(report.totals).toMatchObject({ allocatedHours: 2, pendingHours: 0, excludedHours: 0.5 });
  });

  it("limits a scoped alias to the normalized worker and exact work date", () => {
    const laterDate = "2026-09-25";
    const entries = [
      travel("MATCH", "TEST SVL", "08:00", "10:00"),
      travel("OTHER-WORKER", "TEST SVL", "08:00", "10:00", { workerName: "TEST Other Worker" }),
      travel("OTHER-DAY", "TEST SVL", "08:00", "10:00", { date: laterDate }),
    ];
    const scopedRules: LaborAllocationRules = {
      ...rules,
      workerAliases: [{ alias: "TEST MC", workerName: "Cousino, Michael" }],
      jobAliases: [
        { alias: "Vicki", sourceKey: location("TEST Job A"), workerName: "TEST MC", date },
      ],
    };
    const report = calculate(entries, {
      rules: scopedRules,
      notes: [
        note({ text: "Other-Vicki", dailyVerified: true }),
        note({
          id: "OTHER-WORKER-NOTE",
          workerName: "TEST Other Worker",
          text: "Vicki",
          dailyVerified: true,
        }),
        note({ id: "OTHER-DAY-NOTE", date: laterDate, text: "Vicki", dailyVerified: true }),
      ],
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MATCH")).toMatchObject({
      status: "allocated",
      allocatedHours: 2,
      job: { name: "TEST Job A" },
    });
    for (const id of ["TEST-OTHER-WORKER", "TEST-OTHER-DAY"])
      expect(report.entries.find((entry) => entry.sourceEntryId === id)).toMatchObject({
        status: "pending",
        pendingHours: 2,
        job: null,
      });
    const partialScope = calculate([entries[0] as LaborEntry], {
      rules: {
        ...rules,
        jobAliases: [
          { alias: "Vicki", sourceKey: location("TEST Job A"), workerName: "Michael Cousino" },
        ],
      },
      notes: [note({ text: "Vicki", dailyVerified: true })],
    });
    expect(partialScope.entries[0]?.status).toBe("pending");
  });

  it("preserves ambiguity when a scoped alias conflicts with a global alias", () => {
    const report = calculate([travel("MISSED", "TEST SVL", "08:00", "10:00")], {
      rules: {
        ...rules,
        jobAliases: [
          { alias: "Vicki", sourceKey: location("TEST Job A") },
          {
            alias: "Vicki",
            sourceKey: location("TEST Job B"),
            workerName: "Michael Cousino",
            date,
          },
        ],
      },
      notes: [note({ text: "Vicki", dailyVerified: true })],
    });
    expect(report.entries[0]).toMatchObject({ status: "pending", job: null, allocatedHours: 0 });
  });

  it("applies exact Davis to Johnson corrections only to matching source rows for the note owner and day", () => {
    const laterDate = "2026-09-25";
    const entries = [
      travel("DAVIS-TRAVEL", "TEST Job A", "08:00", "08:15"),
      row("DAVIS", "TEST Job A", "08:15", "09:15"),
      row("UNRELATED", "TEST Job B", "09:15", "10:15"),
      row("OTHER-WORKER", "TEST Job A", "08:00", "09:00", { workerName: "TEST Other Worker" }),
      row("OTHER-DAY", "TEST Job A", "08:00", "09:00", { date: laterDate }),
    ];
    const original = JSON.stringify(entries);
    const report = calculate(entries, {
      rules: {
        ...rules,
        jobAliases: [
          { alias: "Davis", sourceKey: location("TEST Job A") },
          { alias: "Johnson", sourceKey: location("TEST Job B") },
        ],
      },
      notes: [note({ text: "Other-Davis is Johnson Job" })],
      notesCoverage: dailyCoverage,
    });
    for (const id of ["TEST-DAVIS-TRAVEL", "TEST-DAVIS"])
      expect(report.entries.find((entry) => entry.sourceEntryId === id)).toMatchObject({
        status: "allocated",
        reason: "daily_comment",
        job: { name: "TEST Job B" },
        sourceJobKey: location("TEST Job A"),
        noteIds: ["TEST-NOTE"],
      });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-UNRELATED")).toMatchObject({
      status: "allocated",
      reason: "reviewed_customer",
      job: { name: "TEST Job B" },
      noteIds: [],
    });
    for (const id of ["TEST-OTHER-WORKER", "TEST-OTHER-DAY"])
      expect(report.entries.find((entry) => entry.sourceEntryId === id)).toMatchObject({
        status: "allocated",
        reason: "reviewed_customer",
        job: { name: "TEST Job A" },
        noteIds: [],
      });
    expect(report.totals.allocatedHours).toBe(4.25);
    expect(report.totals.grossHours).toBe(4.25);
    expect(JSON.stringify(entries)).toBe(original);
  });

  it("does not use a source-specific correction as a job-only override for unrelated abnormal travel", () => {
    const report = calculate(
      [
        travel("UNRELATED", "TEST SVL", "08:00", "10:00"),
        row("C", "TEST Job C", "10:00", "11:00"),
        row("A", "TEST Job A", "11:00", "12:00"),
      ],
      {
        rules: {
          ...rules,
          locations: [
            ...rules.locations,
            {
              sourceKey: location("TEST Job C"),
              kind: "customer",
              job: destination("TEST Job C"),
            },
          ],
        },
        notes: [note({ text: "TEST Job A = TEST Job B" })],
        notesCoverage: dailyCoverage,
      },
    );
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-UNRELATED")).toMatchObject({
      status: "allocated",
      reason: "next_customer",
      allocatedHours: 2,
      job: { name: "TEST Job C" },
      noteIds: [],
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-A")).toMatchObject({
      status: "allocated",
      reason: "daily_comment",
      allocatedHours: 1,
      job: { name: "TEST Job B" },
      noteIds: ["TEST-NOTE"],
    });
    expect(report.jobs.map((job) => [job.job.name, job.hours])).toEqual([
      ["TEST Job B", 1],
      ["TEST Job C", 3],
    ]);
    expect(report.totals).toMatchObject({ grossHours: 4, allocatedHours: 4, pendingHours: 0 });
  });

  it("retains conflicting and rejected source corrections without altering unrelated jobs", () => {
    const entries = [
      row("A", "TEST Job A", "08:00", "09:00"),
      row("B", "TEST Job B", "09:00", "10:00"),
    ];
    const conflicting = calculate(entries, {
      notes: [
        note({ text: "TEST Job A = TEST Job B" }),
        note({ id: "SECOND", text: "TEST Job A = TEST Job A" }),
      ],
      notesCoverage: dailyCoverage,
    });
    expect(conflicting.entries[0]).toMatchObject({ status: "pending", pendingHours: 1 });
    expect(conflicting.entries[0]?.reviewReasons.join(" ")).toContain("conflicting");
    expect(conflicting.entries[1]).toMatchObject({
      status: "allocated",
      allocatedHours: 1,
      job: { name: "TEST Job B" },
    });
    const rejected = calculate(entries, {
      notes: [note({ text: "TEST Job A = TEST Job B", dailyVerified: true, dailyRejected: true })],
      notesCoverage: dailyCoverage,
    });
    expect(rejected.entries[0]).toMatchObject({ status: "pending", job: { name: "TEST Job B" } });
    expect(rejected.entries[0]?.reviewReasons.join(" ")).toContain("revoked");
    expect(rejected.entries[1]?.status).toBe("allocated");
  });

  it("preserves rejected source-correction evidence on abnormal intervals instead of falling back", () => {
    const report = calculate(
      [travel("MISSED", "TEST Job A", "08:00", "10:00"), row("A", "TEST Job A", "10:00", "11:00")],
      {
        notes: [
          note({ text: "TEST Job A = TEST Job B", dailyVerified: true, dailyRejected: true }),
        ],
        notesCoverage: dailyCoverage,
      },
    );
    expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MISSED")).toMatchObject({
      status: "pending",
      pendingHours: 2,
      allocatedHours: 0,
      job: { name: "TEST Job B" },
      noteIds: ["TEST-NOTE"],
    });
    expect(
      report.entries
        .find((entry) => entry.sourceEntryId === "TEST-MISSED")
        ?.reviewReasons.join(" "),
    ).toContain("revoked");
    expect(report.totals).toMatchObject({ grossHours: 3, allocatedHours: 0, pendingHours: 3 });
  });

  it("permits several abnormal intervals only when an exact source correction identifies each one", () => {
    const report = calculate(
      [
        travel("FIRST", "TEST Job A", "08:00", "10:00"),
        travel("SECOND", "TEST Job A", "10:00", "12:00"),
      ],
      {
        notes: [note({ text: "TEST Job A = TEST Job B" })],
        notesCoverage: dailyCoverage,
      },
    );
    expect(
      report.entries.every(
        (entry) => entry.status === "allocated" && entry.job?.name === "TEST Job B",
      ),
    ).toBe(true);
    expect(report.totals).toMatchObject({ grossHours: 4, allocatedHours: 4, pendingHours: 0 });
  });

  it("uses the next reviewed customer for a continuous abnormal interval without a usable job comment", () => {
    const entries = [
      row("SELLER", "TEST Supplier", "07:45", "08:00"),
      travel("MISSED", "TEST Supplier", "08:00", "10:00"),
      row("SHOP", "TEST SVL", "10:00", "10:15"),
      travel("TO-B", "TEST Job B", "10:15", "10:30"),
      row("B", "TEST Job B", "10:30", "11:30"),
    ];
    for (const notes of [
      [],
      [note({ text: "Forgot to clock in at start; took lunch", dailyVerified: true })],
    ]) {
      const report = calculate(entries, { notes });
      expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MISSED")).toMatchObject({
        status: "allocated",
        reason: "next_customer",
        allocatedHours: 2,
        job: { name: "TEST Job B" },
        reviewReasons: [],
      });
      expect(report.totals).toMatchObject({
        grossHours: 3.75,
        allocatedHours: 3.75,
        pendingHours: 0,
      });
    }
  });

  it("keeps missing-comment abnormal travel pending across gaps, unknown destinations, overlaps or absent next customers", () => {
    const scenarios = [
      [travel("MISSED", "TEST SVL", "08:00", "10:00")],
      [travel("MISSED", "TEST SVL", "08:00", "10:00"), row("B", "TEST Job B", "10:06", "11:06")],
      [
        travel("MISSED", "TEST SVL", "08:00", "10:00"),
        row("UNKNOWN", "TEST Unknown", "10:00", "10:30"),
        row("B", "TEST Job B", "10:30", "11:30"),
      ],
      [travel("MISSED", "TEST SVL", "08:00", "10:00"), row("B", "TEST Job B", "09:45", "10:45")],
      [
        travel("MISSED", "TEST SVL", "08:00", "10:00", { hours: 2.1 }),
        row("B", "TEST Job B", "10:00", "11:00"),
      ],
      [
        travel("MISSED", "TEST SVL", "08:00", "10:00"),
        row("B", "TEST Job B", "10:00", "11:00", { date: "2026-09-25" }),
      ],
    ];
    for (const entries of scenarios) {
      const report = calculate(entries);
      expect(report.entries.find((entry) => entry.sourceEntryId === "TEST-MISSED")).toMatchObject({
        status: "pending",
        allocatedHours: 0,
      });
      expect(
        Math.round(
          (report.totals.allocatedHours +
            report.totals.excludedHours +
            report.totals.pendingHours) *
            100,
        ),
      ).toBe(Math.round(report.totals.grossHours * 100));
    }
    const tolerance = calculate([
      travel("MISSED", "TEST SVL", "08:00", "10:00"),
      row("B", "TEST Job B", "10:05", "11:05"),
    ]);
    expect(tolerance.entries[0]?.status).toBe("allocated");
  });

  it("does not bypass conflicting, unverified or rejected job evidence through the next-customer fallback", () => {
    const entries = [
      travel("MISSED", "TEST SVL", "08:00", "10:00"),
      row("B", "TEST Job B", "10:00", "11:00"),
    ];
    const cases: Partial<LaborAllocationInput>[] = [
      { notes: [note(), note({ id: "SECOND", text: "TEST Job B" })], notesCoverage: dailyCoverage },
      { notes: [note()] },
      { notes: [note({ dailyVerified: true, dailyRejected: true })], notesCoverage: dailyCoverage },
    ];
    for (const options of cases) {
      const report = calculate(entries, options);
      expect(report.entries[0]).toMatchObject({
        status: "pending",
        pendingHours: 2,
        allocatedHours: 0,
      });
      expect(report.entries[1]).toMatchObject({ status: "allocated", job: { name: "TEST Job B" } });
    }
  });

  it("applies one day-only lunch at6gross hours and reconciles signed source breaks without doubling", () => {
    const exactlySix = calculate([row("A", "TEST Job A", "08:00", "14:00"), sourceBreak()]);
    expect(exactlySix.workerDays[0]).toMatchObject({
      grossHours: 6,
      sourceBreakHours: -0.5,
      sourceNetHours: 5.5,
      lunchAdjustmentHours: -0.5,
      netHours: 5.5,
      breakDifferenceHours: 0,
    });
    expect(exactlySix.jobs[0]?.hours).toBe(6);
    const belowSix = calculate([
      row("A", "TEST Job A", "08:00", "14:00", { hours: 5.99 }),
      sourceBreak(),
    ]);
    expect(belowSix.workerDays[0]).toMatchObject({
      lunchAdjustmentHours: 0,
      netHours: 5.99,
      breakDifferenceHours: 0.5,
    });
    const sourceOverdeducted = calculate([
      row("A", "TEST Job A", "08:00", "14:00"),
      sourceBreak(),
      sourceBreak(-0.5, "BREAK2"),
    ]);
    expect(sourceOverdeducted.workerDays[0]).toMatchObject({
      sourceNetHours: 5,
      netHours: 5.5,
      lunchAdjustmentHours: -0.5,
      breakDifferenceHours: 0.5,
    });
    expect(
      sourceOverdeducted.entries.filter((entry) => entry.status === "day_adjustment"),
    ).toHaveLength(2);
  });

  it("does not subtract lunch from any individual job and retains conflicting lunch evidence", () => {
    const report = calculate(
      [row("A", "TEST Job A", "08:00", "11:00"), row("B", "TEST Job B", "11:00", "14:00")],
      { notes: [note({ kind: "other", text: "No lunch today" })] },
    );
    expect(report.jobs.map((job) => job.hours)).toEqual([3, 3]);
    expect(report.workerDays[0]?.netHours).toBe(5.5);
    expect(report.workerDays[0]?.reviewReasons.join(" ")).toContain(
      "conflicts with the lunch policy",
    );
  });
});
