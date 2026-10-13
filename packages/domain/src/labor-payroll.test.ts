import { describe, expect, it } from "vitest";
import type { LaborWorkerDayAllocation } from "./labor-allocation";
import { estimateLaborPay, type LaborPaySettings } from "./labor-payroll";

const coverage = [
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
];
const settings: LaborPaySettings = {
  workerRates: [{ workerName: "TJ Test", hourlyRateCents: 2885, active: true }],
  overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
};
const day = (
  date: string,
  grossHours: number,
  lunchAdjustmentHours = 0,
  overrides: Partial<LaborWorkerDayAllocation> = {},
): LaborWorkerDayAllocation => ({
  key: `TEST-${date}`,
  date,
  workerName: "Test, TJ",
  grossHours,
  sourceBreakHours: lunchAdjustmentHours,
  sourceNetHours: grossHours + lunchAdjustmentHours,
  lunchAdjustmentHours,
  breakDifferenceHours: 0,
  netHours: Math.round((grossHours + lunchAdjustmentHours) * 100) / 100,
  allocatedHours: 0,
  excludedHours: grossHours / 2,
  pendingHours: grossHours / 2,
  reviewReasons: [],
  ...overrides,
});
const estimate = (
  workerDays: LaborWorkerDayAllocation[],
  options: {
    settings?: LaborPaySettings;
    completeDates?: string[];
  } = {},
) => estimateLaborPay({ workerDays, settings, completeDates: coverage, ...options });

describe("current-rate weekly labor pay estimates", () => {
  it("applies overtime to net paid hours after one daily lunch while retaining excluded and pending time", () => {
    const workerDays = coverage.slice(0, 5).map((date) => day(date, 8.5, -0.5));
    const original = JSON.stringify(workerDays);
    const atThreshold = estimate(workerDays);
    expect(atThreshold.workerWeeks[0]).toMatchObject({
      workerName: "TJ Test",
      weekStart: "2026-10-01",
      weekEnd: "2026-10-07",
      grossHours: 42.5,
      lunchAdjustmentHours: -2.5,
      paidHours: 40,
      regularHours: 40,
      overtimeHours: 0,
      regularPayCents: 115400,
      overtimePayCents: 0,
      estimatedPayCents: 115400,
      active: true,
      complete: true,
    });
    const overtime = estimate([...workerDays, day("2026-10-06", 1)]);
    expect(overtime.workerWeeks[0]).toMatchObject({
      paidHours: 41,
      regularHours: 40,
      overtimeHours: 1,
      regularPayCents: 115400,
      overtimePayCents: 4328,
      estimatedPayCents: 119728,
    });
    expect(overtime.totals).toEqual({
      paidHours: 41,
      regularHours: 40,
      overtimeHours: 1,
      knownEstimatedPayCents: 119728,
      unpricedHours: 0,
    });
    expect(JSON.stringify(workerDays)).toBe(original);
  });

  it("starts a fresh Thursday week without combining the preceding Wednesday hours", () => {
    const report = estimate([day("2026-09-30", 20), day("2026-10-01", 20)]);
    expect(
      report.workerWeeks.map((week) => [
        week.weekStart,
        week.weekEnd,
        week.paidHours,
        week.overtimeHours,
      ]),
    ).toEqual([
      ["2026-10-01", "2026-10-07", 20, 0],
      ["2026-09-24", "2026-09-30", 20, 0],
    ]);
    expect(report.totals.overtimeHours).toBe(0);
  });

  it("rounds fractional cents once per weekly regular component without depending on day splitting", () => {
    const whole = estimate([day("2026-10-01", 0.1)]);
    const split = estimate([day("2026-10-01", 0.05), day("2026-10-02", 0.05)]);
    expect(whole.workerWeeks[0]?.regularPayCents).toBe(289);
    expect(split.workerWeeks[0]?.regularPayCents).toBe(289);
    expect(split.workerWeeks[0]?.estimatedPayCents).toBe(289);
    expect(estimate([day("2026-10-01", 0.01)]).workerWeeks[0]?.regularPayCents).toBe(29);
  });

  it("uses exact 1.5 overtime and rounds the weekly overtime component only once", () => {
    const base = coverage.slice(0, 5).map((date) => day(date, 8.5, -0.5));
    const whole = estimate([...base, day("2026-10-06", 0.1)]);
    const split = estimate([...base, day("2026-10-06", 0.05), day("2026-10-07", 0.05)]);
    for (const report of [whole, split])
      expect(report.workerWeeks[0]).toMatchObject({
        paidHours: 40.1,
        regularHours: 40,
        overtimeHours: 0.1,
        regularPayCents: 115400,
        overtimePayCents: 433,
        estimatedPayCents: 115833,
      });
  });

  it("keeps unknown owner pay null and inactive historical pay while exposing only the known subtotal", () => {
    const report = estimate(
      [
        day("2026-10-01", 0.1),
        day("2026-10-01", 2, 0, { workerName: "Test, Owner" }),
        day("2026-10-01", 4, 0, { workerName: "Test, Former" }),
      ],
      {
        settings: {
          ...settings,
          workerRates: [
            ...settings.workerRates,
            { workerName: "Owner Test", hourlyRateCents: null, active: true },
            { workerName: "Former Test", hourlyRateCents: 2400, active: false },
          ],
        },
      },
    );
    expect(report.workerWeeks.find((week) => week.workerName === "Owner Test")).toMatchObject({
      paidHours: 2,
      hourlyRateCents: null,
      regularPayCents: null,
      overtimePayCents: null,
      estimatedPayCents: null,
      active: true,
      complete: true,
    });
    expect(report.workerWeeks.find((week) => week.workerName === "Former Test")).toMatchObject({
      paidHours: 4,
      estimatedPayCents: 9600,
      active: false,
    });
    expect(report.totals).toEqual({
      paidHours: 6.1,
      regularHours: 6.1,
      overtimeHours: 0,
      knownEstimatedPayCents: 9889,
      unpricedHours: 2,
    });
    expect(report.warnings.join(" ")).toContain("Owner Test");
  });

  it("matches normalized whole owners and never lends a rate to a similar name", () => {
    const report = estimate([
      day("2026-10-01", 1, 0, { workerName: " TEST,  TJ " }),
      day("2026-10-01", 1, 0, { workerName: "TJ Test Jr" }),
    ]);
    expect(
      report.workerWeeks.find((week) => week.workerName === "TJ Test")?.estimatedPayCents,
    ).toBe(2885);
    expect(
      report.workerWeeks.find((week) => week.workerName === "TJ Test Jr")?.estimatedPayCents,
    ).toBeNull();
    expect(report.totals.unpricedHours).toBe(1);
  });

  it("keeps an explicit zero rate distinct from an unknown rate", () => {
    const report = estimate([day("2026-10-01", 2)], {
      settings: {
        ...settings,
        workerRates: [{ workerName: "TJ Test", hourlyRateCents: 0, active: true }],
      },
    });
    expect(report.workerWeeks[0]).toMatchObject({ hourlyRateCents: 0, estimatedPayCents: 0 });
    expect(report.totals.unpricedHours).toBe(0);
    expect(report.warnings).toEqual([]);
  });

  it("uses all seven explicit coverage dates independently of work days and hourly rate", () => {
    const workerDays = [day("2026-10-01", 1)];
    expect(estimate(workerDays).workerWeeks[0]?.complete).toBe(true);
    expect(
      estimate(workerDays, { completeDates: coverage.filter((date) => date !== "2026-10-04") })
        .workerWeeks[0]?.complete,
    ).toBe(false);
    expect(estimateLaborPay({ workerDays, settings }).workerWeeks[0]?.complete).toBe(false);
    expect(
      estimate(workerDays, { settings: { ...settings, workerRates: [] } }).workerWeeks[0],
    ).toMatchObject({
      complete: true,
      estimatedPayCents: null,
    });
  });

  it("uses net hours without deducting a source break or redistributing job costs again", () => {
    const workerDay = day("2026-10-01", 6, -0.5, {
      sourceBreakHours: -1,
      sourceNetHours: 5,
      breakDifferenceHours: 0.5,
      allocatedHours: 4,
      excludedHours: 1,
      pendingHours: 1,
    });
    const original = JSON.stringify(workerDay);
    const report = estimate([workerDay]);
    expect(report.workerWeeks[0]).toMatchObject({
      grossHours: 6,
      lunchAdjustmentHours: -0.5,
      paidHours: 5.5,
      estimatedPayCents: 15868,
    });
    expect(JSON.stringify(workerDay)).toBe(original);
    expect(Object.isFrozen(report.workerWeeks[0])).toBe(true);
  });

  it("rejects duplicate normalized rate owners and duplicate source worker days", () => {
    expect(() =>
      estimate([], {
        settings: {
          ...settings,
          workerRates: [
            ...settings.workerRates,
            { workerName: " Test, TJ ", hourlyRateCents: 2885, active: false },
          ],
        },
      }),
    ).toThrow("Repeated normalized worker");
    expect(() =>
      estimate([
        day("2026-10-01", 1),
        day("2026-10-01", 1, 0, { key: "ANOTHER-ID", workerName: "TJ Test" }),
      ]),
    ).toThrow("Repeated worker-day");
  });

  it.each([-1, 24.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid hourly cents %s",
    (hourlyRateCents) => {
      expect(() =>
        estimate([], {
          settings: {
            ...settings,
            workerRates: [{ workerName: "TJ Test", hourlyRateCents, active: true }],
          },
        }),
      ).toThrow("integer cents or null");
    },
  );

  it.each([
    { thresholdHours: 0 },
    { thresholdHours: -1 },
    { thresholdHours: 40.001 },
    { multiplier: 0.5 },
    { multiplier: Number.NaN },
    { multiplier: 1.0000001 },
    { weekStartsOn: 7 },
    { weekStartsOn: 1.5 },
  ])("rejects invalid overtime settings %j", (overtime) => {
    expect(() =>
      estimate([], { settings: { ...settings, overtime: { ...settings.overtime, ...overtime } } }),
    ).toThrow();
  });

  it("rejects malformed dates, inconsistent net hours and currency overflow", () => {
    expect(() => estimate([day("2026-02-30", 1)])).toThrow("valid calendar dates");
    expect(() => estimate([day("2026-10-01", 6, -0.5, { netHours: 5 })])).toThrow(
      "single lunch adjustment",
    );
    expect(() =>
      estimate([day("2026-10-01", 2)], {
        settings: {
          ...settings,
          workerRates: [
            { workerName: "TJ Test", hourlyRateCents: Number.MAX_SAFE_INTEGER, active: true },
          ],
        },
      }),
    ).toThrow("currency range");
  });
});
