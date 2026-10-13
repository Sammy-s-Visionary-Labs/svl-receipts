import { describe, expect, it } from "vitest";
import { type LaborEntry, sourceJobKey } from "./labor";
import { allocateLaborHours, type LaborAllocationRules } from "./labor-allocation";
import { estimateLaborJobCosts, type LaborJobCostInput } from "./labor-job-cost";
import { estimateLaborPay, type LaborPaySettings } from "./labor-payroll";

const dates = [
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
];
const settings: LaborPaySettings = {
  workerRates: [{ workerName: "TEST Worker", hourlyRateCents: 2885, active: true }],
  overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
};
const rules: LaborAllocationRules = {
  locations: ["TEST Job A", "TEST Job B", "TEST Shop", "TEST Excluded"].map((name) => ({
    sourceKey: sourceJobKey(name, "TEST Address"),
    kind: name === "TEST Shop" ? "shop" : name === "TEST Excluded" ? "excluded" : "customer",
    job: name.includes("Job")
      ? { key: name, name, address: "TEST Address", housecallJobId: name }
      : null,
  })),
  jobAliases: [],
};
const row = (
  id: string,
  hours: number,
  clockIn: string,
  clockOut: string,
  overrides: Partial<LaborEntry> = {},
): LaborEntry => ({
  id,
  hours,
  clockIn,
  clockOut,
  kind: "work",
  date: "2026-10-01",
  workerName: "TEST Worker",
  jobName: "TEST Job A",
  jobAddress: "TEST Address",
  clockInMethod: "Manual",
  clockOutMethod: "Manual",
  timeEntryType: "Work",
  crew: "TEST Crew",
  role: "TEST Role",
  jobCode: null,
  employeeId: "TEST-EMPLOYEE",
  travel: false,
  laborCostCents: 999,
  billableCostCents: 0,
  sourceRow: 2,
  ...overrides,
});
function input(
  entries: LaborEntry[],
  options: { settings?: LaborPaySettings; completeDates?: string[] } = {},
): LaborJobCostInput {
  const paySettings = options.settings ?? settings;
  const completeDates = options.completeDates ?? dates;
  const allocation = allocateLaborHours({ entries, rules, completeDates });
  return {
    entries,
    allocation,
    settings: paySettings,
    payroll: estimateLaborPay({
      workerDays: allocation.workerDays,
      settings: paySettings,
      completeDates,
    }),
  };
}
const sum = (values: readonly (number | null)[]) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0);
const costs = (value: LaborJobCostInput) => estimateLaborJobCosts(value);

describe("reviewed job-cost estimate policy", () => {
  it("shares one day lunch across customer, excluded and pending source intervals without deducting source breaks twice", () => {
    const value = input([
      row("A", 3, "08:00", "11:00"),
      row("B", 2, "11:00", "13:00", { jobName: "TEST Excluded" }),
      row("C", 1, "13:00", "14:00", { jobName: "TEST Unknown" }),
      row("BREAK", -0.5, "", "", { kind: "unpaid_break", jobName: "Unpaid Break" }),
    ]);
    const original = JSON.stringify(value);
    const report = costs(value);
    expect(
      report.entries.map((entry) => [
        entry.sourceEntryId,
        entry.sourceHourHundredths,
        entry.paidHourHundredths,
      ]),
    ).toEqual([
      ["A", 300, 275],
      ["B", 200, 183],
      ["C", 100, 92],
    ]);
    expect(sum(report.entries.map((entry) => entry.paidHourHundredths))).toBe(550);
    expect(report.entries.map((entry) => entry.allocationStatus)).toEqual([
      "allocated",
      "excluded",
      "pending",
    ]);
    expect(sum(report.entries.map((entry) => entry.estimatedCostCents))).toBe(
      value.payroll.totals.knownEstimatedPayCents,
    );
    expect(report.workerWeeks[0]?.approvable).toBe(true);
    expect(JSON.stringify(value)).toBe(original);
  });

  it("assigns overtime to chronological paid intervals after all other paid work in the week", () => {
    const entries = dates
      .slice(0, 4)
      .map((date, index) =>
        row(`SHOP-${index}`, 8.5, "08:00", "16:30", { date, jobName: "TEST Shop" }),
      );
    entries.push(
      row("LATE-A", 8.5, "08:00", "16:30", { date: "2026-10-05" }),
      row("LATE-B", 1, "16:30", "17:30", { date: "2026-10-05", jobName: "TEST Job B" }),
    );
    const value = input(entries.reverse());
    const report = costs(value);
    expect(report.entries.find((entry) => entry.sourceEntryId === "LATE-A")).toMatchObject({
      paidHourHundredths: 805,
      regularHourHundredths: 800,
      overtimeHourHundredths: 5,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "LATE-B")).toMatchObject({
      paidHourHundredths: 95,
      regularHourHundredths: 0,
      overtimeHourHundredths: 95,
    });
    expect(sum(report.entries.map((entry) => entry.regularHourHundredths))).toBe(4000);
    expect(sum(report.entries.map((entry) => entry.overtimeHourHundredths))).toBe(100);
    expect(sum(report.entries.map((entry) => entry.regularPayCents))).toBe(115400);
    expect(sum(report.entries.map((entry) => entry.overtimePayCents))).toBe(4328);
    expect(report.workerWeeks[0]).toMatchObject({
      hourlyRateCents: 2885,
      overtimeMultiplier: 1.5,
      approvable: true,
    });
  });

  it("resets Thursday overtime and rounds weekly component cents once with deterministic remainders", () => {
    const value = input(
      [
        row("Z-EARLY", 0.05, "08:00", "08:03"),
        row("A-LATE", 0.05, "08:03", "08:06"),
        row("PREVIOUS", 40, "00:00", "23:59", { date: "2026-09-30" }),
      ],
      {
        completeDates: [
          ...dates,
          "2026-09-24",
          "2026-09-25",
          "2026-09-26",
          "2026-09-27",
          "2026-09-28",
          "2026-09-29",
          "2026-09-30",
        ],
      },
    );
    const report = costs(value);
    expect(report.workerWeeks).toHaveLength(2);
    expect(report.entries.find((entry) => entry.sourceEntryId === "Z-EARLY")).toMatchObject({
      regularPayCents: 145,
      overtimeHourHundredths: 0,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "A-LATE")).toMatchObject({
      regularPayCents: 144,
      overtimeHourHundredths: 0,
    });
    expect(sum(report.entries.map((entry) => entry.estimatedCostCents))).toBe(
      value.payroll.totals.knownEstimatedPayCents,
    );
  });

  it("shows incomplete known-clock estimates but blocks approval until the full week is covered", () => {
    const report = costs(input([row("A", 1, "08:00", "09:00")], { completeDates: ["2026-10-01"] }));
    expect(report.entries[0]).toMatchObject({
      estimatedCostCents: 2885,
      regularHourHundredths: 100,
    });
    expect(report.workerWeeks[0]).toMatchObject({
      complete: false,
      calculable: true,
      approvable: false,
    });
    expect(report.entries[0]?.blockers).toContain("incomplete_worker_week");
  });

  it("keeps missing pay unknown and inactive historical pay priced without assuming a zero rate", () => {
    const unpriced = costs(
      input([row("A", 1, "08:00", "09:00")], { settings: { ...settings, workerRates: [] } }),
    );
    expect(unpriced.entries[0]).toMatchObject({
      paidHourHundredths: 100,
      regularHourHundredths: 100,
      estimatedCostCents: null,
    });
    expect(unpriced.workerWeeks[0]?.blockers).toContain("missing_hourly_rate");
    const inactive = costs(
      input([row("A", 1, "08:00", "09:00")], {
        settings: {
          ...settings,
          workerRates: [{ workerName: "TEST Worker", hourlyRateCents: 0, active: false }],
        },
      }),
    );
    expect(inactive.entries[0]?.estimatedCostCents).toBe(0);
    expect(inactive.workerWeeks[0]?.approvable).toBe(true);
  });

  it("blocks a selected job's whole worker week when non-job clocks are missing or cross midnight", () => {
    for (const [clockIn, clockOut] of [
      ["", "09:00"],
      ["23:00", "01:00"],
    ] as const) {
      const report = costs(
        input([
          row("NONJOB", 1, clockIn, clockOut, { jobName: "TEST Excluded" }),
          row("JOB", 1, "10:00", "11:00"),
        ]),
      );
      expect(report.workerWeeks[0]?.blockers).toContain("unknown_same_day_clock_boundaries");
      expect(report.entries.find((entry) => entry.sourceEntryId === "JOB")).toMatchObject({
        paidHourHundredths: 100,
        regularHourHundredths: null,
        overtimeHourHundredths: null,
        estimatedCostCents: null,
      });
    }
  });

  it("blocks actual one-minute overlaps even when allocation's clock tolerance treats them as reviewable", () => {
    const report = costs(
      input([
        row("NONJOB", 1, "08:00", "09:00", { jobName: "TEST Excluded" }),
        row("JOB", 1, "08:59", "10:00"),
      ]),
    );
    expect(report.workerWeeks[0]?.blockers).toContain("overlapping_source_intervals");
    expect(report.entries.every((entry) => entry.estimatedCostCents === null)).toBe(true);
  });

  it("retains minute-rounded short points before a following span and orders equal-minute points by source row then ID", () => {
    const value = input(
      [
        row("Z-POINT", 0.01, "08:00", "08:00", { sourceRow: 9 }),
        row("B-POINT", 0.02, "08:00", "08:00", { sourceRow: 5 }),
        row("A-POINT", 0.01, "08:00", "08:00", { sourceRow: 5 }),
        row("SPAN", 5.96, "08:00", "14:00", { sourceRow: 1 }),
      ],
      { settings: { ...settings, overtime: { ...settings.overtime, thresholdHours: 0.01 } } },
    );
    const original = JSON.stringify(value);
    const report = costs(value);
    expect(report.policyVersion).toBe("proportional-day-lunch-chronological-week-overtime-v2");
    expect(report.workerWeeks[0]?.approvable).toBe(true);
    expect(report.workerWeeks[0]?.warnings).toContain("minute_rounded_short_interval");
    expect(report.entries.find((entry) => entry.sourceEntryId === "A-POINT")).toMatchObject({
      sourceHourHundredths: 1,
      paidHourHundredths: 1,
      regularHourHundredths: 1,
      overtimeHourHundredths: 0,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "B-POINT")).toMatchObject({
      sourceHourHundredths: 2,
      paidHourHundredths: 2,
      regularHourHundredths: 0,
      overtimeHourHundredths: 2,
    });
    expect(
      report.entries.find((entry) => entry.sourceEntryId === "SPAN")?.regularHourHundredths,
    ).toBe(0);
    expect(sum(report.entries.map((entry) => entry.paidHourHundredths))).toBe(550);
    expect(sum(report.entries.map((entry) => entry.regularPayCents))).toBe(
      value.payroll.workerWeeks[0]?.regularPayCents,
    );
    expect(sum(report.entries.map((entry) => entry.overtimePayCents))).toBe(
      value.payroll.workerWeeks[0]?.overtimePayCents,
    );
    expect(JSON.stringify(value)).toBe(original);
  });

  it("allows points on span boundaries but blocks a short point strictly inside an existing positive span", () => {
    const boundary = input([
      row("BEFORE", 1, "08:00", "09:00"),
      row("POINT", 0.01, "09:00", "09:00"),
      row("AFTER", 1, "09:00", "10:00"),
    ]);
    expect(costs(boundary).workerWeeks[0]?.approvable).toBe(true);
    const interior = costs(
      input([row("SPAN", 1, "08:00", "09:00"), row("POINT", 0.01, "08:30", "08:30")]),
    );
    expect(interior.workerWeeks[0]?.blockers).toContain("overlapping_source_intervals");
    expect(interior.entries.every((entry) => entry.estimatedCostCents === null)).toBe(true);
  });

  it("keeps longer same-minute, missing and reversed point clocks blocked; zero rows stay only in provenance", () => {
    for (const entry of [
      row("BAD", 0.03, "08:00", "08:00"),
      row("BAD", 0.01, "", ""),
      row("BAD", 0.01, "08:01", "08:00"),
    ]) {
      expect(costs(input([entry])).workerWeeks[0]?.blockers).toContain(
        "unknown_same_day_clock_boundaries",
      );
    }
    const report = costs(
      input([row("POINT", 0.01, "08:00", "08:00"), row("ZERO", 0, "08:00", "08:00")]),
    );
    expect(report.entries.map((entry) => entry.sourceEntryId)).toEqual(["POINT"]);
    expect(report.workerWeeks[0]?.sourceEntryIds).toEqual(["POINT", "ZERO"]);
    expect(report.workerWeeks[0]?.fingerprintContext).toContain('"id":"ZERO"');
  });

  it("retains reported quantities rather than replacing them with elapsed clock duration", () => {
    const report = costs(input([row("A", 0.09, "08:00", "08:10"), row("B", 1, "08:10", "10:10")]));
    expect(report.entries.find((entry) => entry.sourceEntryId === "A")).toMatchObject({
      sourceHours: 0.09,
      sourceHourHundredths: 9,
      paidHourHundredths: 9,
    });
    expect(report.entries.find((entry) => entry.sourceEntryId === "B")?.warnings).toContain(
      "clock_duration_differs_from_source_hours",
    );
    expect(report.workerWeeks[0]?.approvable).toBe(true);
  });

  it("rejects stale payroll controls instead of borrowing pay from a different rate or source snapshot", () => {
    const value = input([row("A", 1, "08:00", "09:00")]);
    const report = costs({
      ...value,
      settings: {
        ...settings,
        workerRates: [{ workerName: "TEST Worker", hourlyRateCents: 3000, active: true }],
      },
    });
    expect(report.workerWeeks[0]?.blockers).toContain("payroll_control_mismatch");
    expect(report.entries[0]?.estimatedCostCents).toBeNull();
  });

  it("fingerprints all week contributions and rates while remaining independent of input ordering", () => {
    const a = row("JOB", 2, "08:00", "10:00");
    const b = row("NONJOB", 1, "10:00", "11:00", { jobName: "TEST Excluded", date: "2026-10-02" });
    const base = costs(input([a, b]));
    expect(costs(input([b, a])).workerWeeks[0]?.fingerprintContext).toBe(
      base.workerWeeks[0]?.fingerprintContext,
    );
    expect(
      costs(input([a, { ...b, hours: 2, clockOut: "12:00" }])).workerWeeks[0]?.fingerprintContext,
    ).not.toBe(base.workerWeeks[0]?.fingerprintContext);
    expect(
      costs(
        input([a, b], {
          settings: {
            ...settings,
            workerRates: [{ workerName: "TEST Worker", hourlyRateCents: 3000, active: true }],
          },
        }),
      ).workerWeeks[0]?.fingerprintContext,
    ).not.toBe(base.workerWeeks[0]?.fingerprintContext);
    expect(base.workerWeeks[0]?.sourceEntryIds).toEqual(["JOB", "NONJOB"]);
  });

  it("conserves every day hundredth and weekly regular/overtime cent across varied interval splits", () => {
    for (let seed = 1; seed <= 16; seed++) {
      const entries = dates.slice(0, 6).flatMap((date, index) => [
        row(`${date}-A`, 3 + seed / 100, "08:00", "12:00", { date }),
        row(`${date}-B`, 5.5 - seed / 100, "12:00", "18:00", {
          date,
          jobName: index % 2 ? "TEST Excluded" : "TEST Unknown",
        }),
      ]);
      const value = input(entries);
      const report = costs(value);
      for (const day of value.allocation.workerDays)
        expect(
          sum(
            report.entries
              .filter((entry) => entry.date === day.date)
              .map((entry) => entry.paidHourHundredths),
          ),
        ).toBe(Math.round(day.netHours * 100));
      expect(sum(report.entries.map((entry) => entry.regularPayCents))).toBe(
        value.payroll.workerWeeks[0]?.regularPayCents,
      );
      expect(sum(report.entries.map((entry) => entry.overtimePayCents))).toBe(
        value.payroll.workerWeeks[0]?.overtimePayCents,
      );
      expect(sum(report.entries.map((entry) => entry.estimatedCostCents))).toBe(
        value.payroll.totals.knownEstimatedPayCents,
      );
    }
  });

  it("fails closed on duplicate source identities and blocks conflicting employee identities", () => {
    const source = row("A", 1, "08:00", "09:00");
    const value = input([source]);
    expect(() => costs({ ...value, entries: [source, source] })).toThrow(/unique/);
    const report = costs(
      input([
        source,
        row("B", 1, "09:00", "10:00", { employeeId: "TEST-DIFFERENT", date: "2026-10-02" }),
      ]),
    );
    expect(report.workerWeeks[0]?.blockers).toContain("ambiguous_worker_identity");
  });
});
