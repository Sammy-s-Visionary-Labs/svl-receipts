import { describe, expect, it } from "vitest";
import { type LaborEntry, sourceJobKey } from "./labor";
import { allocateLaborHours, type LaborAllocationRules } from "./labor-allocation";
import { estimateLaborJobCosts } from "./labor-job-cost";
import { linkLaborAllocation } from "./labor-job-mapping";
import { estimateLaborPay, type LaborPaySettings } from "./labor-payroll";
import {
  canonicalLaborWorkerName,
  createLaborWorkerIdentityResolver,
} from "./labor-worker-identity";

const aliases = [{ alias: "TEST Alex", workerName: "TEST Alex Rivera" }];
const dates = Array.from({ length: 7 }, (_, index) => `2026-10-0${index + 1}`);
const rules: LaborAllocationRules = {
  locations: [
    {
      sourceKey: sourceJobKey("TEST Job", "TEST Address"),
      kind: "customer",
      job: { key: "TEST-JOB", name: "TEST Job", address: "TEST Address", housecallJobId: null },
    },
  ],
  jobAliases: [],
};
const settings: LaborPaySettings = {
  workerAliases: aliases,
  workerRates: [{ workerName: "TEST Alex Rivera", hourlyRateCents: 2000, active: true }],
  overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
};
function row(
  id: string,
  date: string,
  workerName: string,
  hours: number,
  clockIn = "08:00",
  clockOut = "16:00",
): LaborEntry {
  return {
    id,
    date,
    workerName,
    hours,
    clockIn,
    clockOut,
    kind: "work",
    jobName: "TEST Job",
    jobAddress: "TEST Address",
    clockInMethod: "Manual",
    clockOutMethod: "Manual",
    timeEntryType: "Work",
    crew: "TEST Crew",
    role: "TEST Role",
    jobCode: null,
    employeeId: workerName === "TEST Alex" ? "TEST-OLD-ID" : "TEST-NEW-ID",
    travel: false,
    laborCostCents: 123,
    billableCostCents: 0,
    sourceRow: Number(id.slice(1)) + 2,
  };
}
const entries = [
  row("S1", "2026-10-01", "TEST Alex", 3, "08:00", "11:00"),
  row("S2", "2026-10-01", "Rivera, TEST Alex", 5, "11:00", "16:00"),
  ...dates
    .slice(1, 6)
    .map((date, index) =>
      row(`S${index + 3}`, date, index < 2 ? "TEST Alex" : "Rivera, TEST Alex", 8),
    ),
];
function calculate(source = entries, paySettings = settings) {
  const allocation = allocateLaborHours({
    entries: source,
    rules,
    workerAliases: paySettings.workerAliases,
    completeDates: dates,
  });
  const payroll = estimateLaborPay({
    workerDays: allocation.workerDays,
    settings: paySettings,
    completeDates: dates,
  });
  return {
    allocation,
    payroll,
    costs: estimateLaborJobCosts({ entries: source, allocation, payroll, settings: paySettings }),
  };
}

describe("reviewed canonical worker identity", () => {
  it("matches exact normalized aliases and canonical names without inferring other workers", () => {
    expect(canonicalLaborWorkerName(" TEST Alex ", aliases)).toBe("TEST Alex Rivera");
    expect(canonicalLaborWorkerName("Rivera, TEST Alex", aliases)).toBe("TEST Alex Rivera");
    expect(canonicalLaborWorkerName("TEST Alex Rivers", aliases)).toBe("TEST Alex Rivers");
    expect(canonicalLaborWorkerName("Alex", aliases)).toBe("Alex");
  });

  it("rejects duplicate aliases, conflicting canonical labels, chains and cycles", () => {
    for (const mappings of [
      [...aliases, ...aliases],
      [...aliases, { alias: "TEST Other", workerName: "Rivera, TEST Alex" }],
      [...aliases, { alias: "TEST Alex Rivera", workerName: "TEST Final" }],
      [...aliases, { alias: "TEST Alex Rivera", workerName: "TEST Alex" }],
    ])
      expect(() => createLaborWorkerIdentityResolver(mappings)).toThrow(/identit/);
  });

  it("combines same-day lunch, the chronological overtime week, rate and jobs while preserving source evidence", () => {
    const original = JSON.stringify(entries);
    const { allocation, payroll, costs } = calculate();
    expect(allocation.workerDays).toHaveLength(6);
    expect(allocation.workerDays.find((day) => day.date === dates[0])).toMatchObject({
      workerName: "TEST Alex Rivera",
      grossHours: 8,
      lunchAdjustmentHours: -0.5,
      netHours: 7.5,
    });
    expect(payroll.workerWeeks).toHaveLength(1);
    expect(payroll.workerWeeks[0]).toMatchObject({
      workerName: "TEST Alex Rivera",
      paidHours: 45,
      regularHours: 40,
      overtimeHours: 5,
      hourlyRateCents: 2000,
      estimatedPayCents: 95000,
      complete: true,
    });
    expect(costs.workerWeeks).toHaveLength(1);
    expect(costs.workerWeeks[0]).toMatchObject({
      calculable: true,
      approvable: true,
      estimatedPayCents: 95000,
    });
    expect(costs.entries.find((entry) => entry.sourceEntryId === "S7")).toMatchObject({
      regularHourHundredths: 250,
      overtimeHourHundredths: 500,
    });
    expect(costs.entries.reduce((sum, entry) => sum + (entry.estimatedCostCents ?? 0), 0)).toBe(
      95000,
    );
    expect(allocation.jobs[0]?.workerCount).toBe(1);
    expect(linkLaborAllocation(allocation, [], [], aliases).jobs[0]?.workerCount).toBe(1);
    expect(allocation.entries.map((entry) => entry.workerName)).toEqual(
      entries.map((entry) => entry.workerName),
    );
    expect(costs.workerWeeks[0]?.sourceEntryIds).toEqual(entries.map((entry) => entry.id));
    expect(JSON.stringify(entries)).toBe(original);
  });

  it("retains chronology overlap protection across source aliases", () => {
    const source = entries.map((entry) =>
      entry.id === "S2" ? { ...entry, clockIn: "10:00" } : entry,
    );
    expect(calculate(source).costs.workerWeeks[0]?.blockers).toContain(
      "overlapping_source_intervals",
    );
  });

  it("binds the explicit reviewed identity configuration into the cost fingerprint", () => {
    const before = calculate().costs.workerWeeks[0]?.fingerprintContext;
    const after = calculate(entries, {
      ...settings,
      workerAliases: [...aliases, { alias: "TEST Extra Source", workerName: "TEST Alex Rivera" }],
    }).costs.workerWeeks[0]?.fingerprintContext;
    expect(after).not.toBe(before);
  });
});
