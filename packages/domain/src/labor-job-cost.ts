import type { LaborEntry } from "./labor";
import {
  type LaborAllocationReport,
  type LaborEntryAllocation,
  type LaborWorkerDayAllocation,
  normalizeLaborWorkerName,
} from "./labor-allocation";
import {
  estimateLaborPay,
  type LaborPayReport,
  type LaborPaySettings,
  type LaborWorkerWeekPay,
} from "./labor-payroll";
import { createLaborWorkerIdentityResolver } from "./labor-worker-identity";

export const LABOR_JOB_COST_POLICY_VERSION =
  "proportional-day-lunch-chronological-week-overtime-v2";

export type LaborJobCostInput = {
  entries: readonly LaborEntry[];
  allocation: LaborAllocationReport;
  settings: LaborPaySettings;
  payroll: LaborPayReport;
};
export type LaborJobCostEntry = {
  sourceEntryId: string;
  workerName: string;
  date: string;
  workerWeekKey: string;
  sourceHours: number;
  sourceHourHundredths: number;
  paidHourHundredths: number;
  regularHourHundredths: number | null;
  overtimeHourHundredths: number | null;
  regularPayCents: number | null;
  overtimePayCents: number | null;
  estimatedCostCents: number | null;
  allocationStatus: LaborEntryAllocation["status"] | null;
  jobKey: string | null;
  housecallJobId: string | null;
  warnings: string[];
  blockers: string[];
};
export type LaborJobCostWorkerWeek = {
  key: string;
  workerName: string;
  weekStart: string;
  weekEnd: string;
  hourlyRateCents: number | null;
  overtimeMultiplier: number;
  complete: boolean;
  grossHourHundredths: number;
  lunchAdjustmentHourHundredths: number;
  paidHourHundredths: number;
  regularHourHundredths: number;
  overtimeHourHundredths: number;
  regularPayCents: number | null;
  overtimePayCents: number | null;
  estimatedPayCents: number | null;
  sourceEntryIds: string[];
  calculable: boolean;
  approvable: boolean;
  warnings: string[];
  blockers: string[];
  /** Canonical context, not a cryptographic hash; the trusted snapshot hashes/freezes it. */
  fingerprintContext: string;
};
export type LaborJobCostReport = {
  policyVersion: string;
  entries: LaborJobCostEntry[];
  workerWeeks: LaborJobCostWorkerWeek[];
  warnings: string[];
  blockers: string[];
};

const hh = (value: number) => {
  const amount = Math.round(value * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(value * 100 - amount) > 0.000001)
    throw new Error("Job costing requires finite source and payroll hours in exact hundredths.");
  return amount;
};
const safeSum = (values: readonly number[]) => {
  const sum = values.reduce((total, value) => total + BigInt(value), BigInt(0));
  if (sum < BigInt(Number.MIN_SAFE_INTEGER) || sum > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Job costing exceeds the supported integer range.");
  return Number(sum);
};
function calendar(value: string) {
  const date = new Date(`${value}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    throw new Error("Job costing requires valid source work dates.");
  return date;
}
function addDays(value: string, days: number) {
  const date = calendar(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const startOfWeek = (date: string, startsOn: number) =>
  addDays(date, -((calendar(date).getUTCDay() - startsOn + 7) % 7));
function minutes(clock: string) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}
const minuteRoundedPoint = (entry: LaborEntry) => {
  const start = minutes(entry.clockIn);
  return (
    start !== null && start === minutes(entry.clockOut) && entry.hours > 0 && hh(entry.hours) <= 2
  );
};
const ordered = (left: LaborEntry, right: LaborEntry) =>
  left.date.localeCompare(right.date) ||
  (minutes(left.clockIn) ?? 1440) - (minutes(right.clockIn) ?? 1440) ||
  Number(!minuteRoundedPoint(left)) - Number(!minuteRoundedPoint(right)) ||
  left.sourceRow - right.sourceRow ||
  left.id.localeCompare(right.id);

/** Allocate integer units without rounding each interval or losing a penny/hour hundredth. */
function distribute(total: number, weights: readonly number[]): number[] {
  if (
    !Number.isSafeInteger(total) ||
    total < 0 ||
    weights.some((weight) => !Number.isSafeInteger(weight) || weight < 0)
  )
    throw new Error("Job cost apportionment requires nonnegative integer totals and weights.");
  const denominator = weights.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  if (denominator === BigInt(0)) {
    if (total !== 0) throw new Error("Job cost apportionment has no contributing intervals.");
    return weights.map(() => 0);
  }
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(total) * BigInt(weight);
    return { index, floor: Number(numerator / denominator), remainder: numerator % denominator };
  });
  const result = parts.map((part) => part.floor);
  const remainder = total - safeSum(result);
  parts.sort((left, right) =>
    left.remainder === right.remainder
      ? left.index - right.index
      : left.remainder > right.remainder
        ? -1
        : 1,
  );
  for (let index = 0; index < remainder; index++) {
    const part = parts[index];
    if (!part) throw new Error("Job cost apportionment remainder exceeds its interval count.");
    result[part.index] = (result[part.index] ?? 0) + 1;
  }
  return result;
}

function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}

type Group = {
  key: string;
  owner: string;
  start: string;
  sources: LaborEntry[];
  days: LaborWorkerDayAllocation[];
  expected?: LaborWorkerWeekPay;
  payroll?: LaborWorkerWeekPay;
  blockers: Set<string>;
  warnings: Set<string>;
  chronologyBlocked: boolean;
  controlsBlocked: boolean;
};

/** Redistribute estimates only. The original quantities, costs, allocation and payroll stay intact. */
export function estimateLaborJobCosts(input: LaborJobCostInput): LaborJobCostReport {
  const canonicalWorker = createLaborWorkerIdentityResolver(input.settings.workerAliases);
  const workerKey = (name: string) => normalizeLaborWorkerName(canonicalWorker(name));
  const dayKey = (name: string, date: string) => JSON.stringify([workerKey(name), date]);
  const weekKey = dayKey;
  const reviewedOwners = new Set(
    (input.settings.workerAliases ?? []).map((item) => workerKey(item.workerName)),
  );
  const expected = estimateLaborPay({
    workerDays: input.allocation.workerDays,
    settings: input.settings,
  });
  const startsOn = input.settings.overtime.weekStartsOn;
  const groups = new Map<string, Group>();
  const ensure = (name: string, start: string) => {
    const key = weekKey(name, start);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        owner: workerKey(name),
        start,
        sources: [],
        days: [],
        blockers: new Set(),
        warnings: new Set(),
        chronologyBlocked: false,
        controlsBlocked: false,
      };
      groups.set(key, group);
    }
    return group;
  };
  const sourceIds = new Set<string>();
  for (const entry of input.entries) {
    if (!entry.id || sourceIds.has(entry.id))
      throw new Error("Job cost source identifiers must be unique.");
    if (!entry.workerName.trim()) throw new Error("Job costing requires an exact source worker.");
    hh(entry.hours);
    sourceIds.add(entry.id);
    ensure(entry.workerName, startOfWeek(entry.date, startsOn)).sources.push(entry);
  }
  const decisions = new Map<string, LaborEntryAllocation>();
  for (const entry of input.allocation.entries) {
    if (decisions.has(entry.sourceEntryId))
      throw new Error("Job cost allocation identifiers must be unique.");
    decisions.set(entry.sourceEntryId, entry);
  }
  for (const day of input.allocation.workerDays)
    ensure(day.workerName, startOfWeek(day.date, startsOn)).days.push(day);
  for (const week of expected.workerWeeks) ensure(week.workerName, week.weekStart).expected = week;
  for (const week of input.payroll.workerWeeks) {
    const group = ensure(week.workerName, week.weekStart);
    if (group.payroll) throw new Error("Job cost payroll worker weeks must be unique.");
    group.payroll = week;
  }
  const employeeOwners = new Map<string, Set<string>>();
  for (const group of groups.values())
    for (const source of group.sources) {
      if (!source.employeeId) continue;
      const owners = employeeOwners.get(source.employeeId) ?? new Set<string>();
      owners.add(group.owner);
      employeeOwners.set(source.employeeId, owners);
    }
  const entries: LaborJobCostEntry[] = [];
  const workerWeeks: LaborJobCostWorkerWeek[] = [];
  for (const group of groups.values()) {
    const control = group.payroll;
    const expectedWeek = group.expected;
    const positive = group.sources
      .filter((entry) => entry.kind !== "unpaid_break" && entry.hours > 0)
      .sort(ordered);
    const blockControls = (reason: string) => {
      group.controlsBlocked = true;
      group.blockers.add(reason);
    };
    const blockChronology = (reason: string) => {
      group.chronologyBlocked = true;
      group.blockers.add(reason);
    };
    if (!control || !expectedWeek) blockControls("missing_worker_week_control");
    else {
      const fields = [
        "weekEnd",
        "grossHours",
        "lunchAdjustmentHours",
        "paidHours",
        "regularHours",
        "overtimeHours",
        "hourlyRateCents",
        "regularPayCents",
        "overtimePayCents",
        "estimatedPayCents",
        "active",
      ] as const;
      if (fields.some((field) => control[field] !== expectedWeek[field]))
        blockControls("payroll_control_mismatch");
    }
    if (!control?.complete) group.blockers.add("incomplete_worker_week");
    if (control?.hourlyRateCents === null || !control) group.blockers.add("missing_hourly_rate");
    const employeeIds = new Set(group.sources.map((source) => source.employeeId).filter(Boolean));
    if (
      (employeeIds.size > 1 && !reviewedOwners.has(group.owner)) ||
      group.sources.some(
        (source) => !!source.employeeId && (employeeOwners.get(source.employeeId)?.size ?? 0) > 1,
      )
    )
      blockControls("ambiguous_worker_identity");
    if (
      group.sources.some(
        (entry) =>
          (entry.kind !== "unpaid_break" && entry.hours < 0) ||
          (entry.kind === "unpaid_break" && entry.hours > 0),
      )
    )
      blockControls("invalid_source_adjustment");
    const records = positive.map((source): LaborJobCostEntry => {
      const decision = decisions.get(source.id);
      if (
        !decision ||
        decision.date !== source.date ||
        workerKey(decision.workerName) !== group.owner ||
        decision.workerName !== source.workerName ||
        decision.sourceHours !== source.hours ||
        decision.sourceRow !== source.sourceRow ||
        decision.sourceKind !== source.kind
      )
        blockControls("source_allocation_mismatch");
      return {
        sourceEntryId: source.id,
        workerName: canonicalWorker(control?.workerName ?? source.workerName),
        date: source.date,
        workerWeekKey: group.key,
        sourceHours: source.hours,
        sourceHourHundredths: hh(source.hours),
        paidHourHundredths: 0,
        regularHourHundredths: null,
        overtimeHourHundredths: null,
        regularPayCents: null,
        overtimePayCents: null,
        estimatedCostCents: null,
        allocationStatus: decision?.status ?? null,
        jobKey: decision?.job?.key ?? null,
        housecallJobId: decision?.job?.housecallJobId ?? null,
        warnings: [...(decision?.reviewReasons ?? [])],
        blockers: [],
      };
    });
    const recordById = new Map(records.map((record) => [record.sourceEntryId, record]));
    const days = new Map(group.days.map((day) => [dayKey(day.workerName, day.date), day]));
    const workDates = new Set([
      ...positive.map((entry) => entry.date),
      ...group.days.map((day) => day.date),
    ]);
    for (const date of workDates) {
      const dayRows = positive.filter((source) => source.date === date);
      const day = days.get(dayKey(group.owner, date));
      if (!day) {
        blockControls("missing_worker_day_control");
        continue;
      }
      const weights = dayRows.map((source) => hh(source.hours));
      const gross = safeSum(weights);
      const paid = hh(day.netHours);
      if (gross !== hh(day.grossHours) || paid > gross) blockControls("source_day_gross_mismatch");
      if (!gross && paid) {
        blockControls("missing_paid_source_intervals");
        continue;
      }
      const distributed = distribute(paid, weights);
      dayRows.forEach((row, index) => {
        const record = recordById.get(row.id);
        if (record) record.paidHourHundredths = distributed[index] ?? 0;
      });
      for (const reason of day.reviewReasons) {
        group.warnings.add(reason);
        if (reason.includes("provisional")) blockControls("provisional_worker_day");
      }
      let maximumEnd = -1;
      for (const source of dayRows) {
        const start = minutes(source.clockIn);
        const end = minutes(source.clockOut);
        const point = minuteRoundedPoint(source);
        if (start === null || end === null || end < start || (end === start && !point)) {
          blockChronology("unknown_same_day_clock_boundaries");
          continue;
        }
        if (point) {
          group.warnings.add("minute_rounded_short_interval");
          recordById.get(source.id)?.warnings.push("minute_rounded_short_interval");
          // Points at an interval's boundary are permitted; strictly interior points overlap it.
          if (start < maximumEnd) blockChronology("overlapping_source_intervals");
          continue;
        }
        if (start < maximumEnd) blockChronology("overlapping_source_intervals");
        maximumEnd = Math.max(maximumEnd, end);
        if (Math.abs(source.hours * 60 - (end - start)) > 5 + 0.000001) {
          group.warnings.add("clock_duration_differs_from_source_hours");
          recordById.get(source.id)?.warnings.push("clock_duration_differs_from_source_hours");
        }
      }
    }
    const paid = safeSum(records.map((record) => record.paidHourHundredths));
    if (control && paid !== hh(control.paidHours)) blockControls("worker_week_paid_hours_mismatch");
    const chronologyKnown = !group.chronologyBlocked && !group.controlsBlocked && !!control;
    if (chronologyKnown) {
      let regularLeft = hh(control.regularHours);
      for (const record of records) {
        record.regularHourHundredths = Math.min(regularLeft, record.paidHourHundredths);
        record.overtimeHourHundredths = record.paidHourHundredths - record.regularHourHundredths;
        regularLeft -= record.regularHourHundredths;
      }
      if (
        regularLeft !== 0 ||
        safeSum(records.map((record) => record.overtimeHourHundredths ?? 0)) !==
          hh(control.overtimeHours)
      )
        blockControls("worker_week_overtime_control_mismatch");
    }
    const calculable =
      !group.chronologyBlocked &&
      !group.controlsBlocked &&
      !!control &&
      control.hourlyRateCents !== null &&
      control.regularPayCents !== null &&
      control.overtimePayCents !== null;
    if (calculable) {
      const regular = distribute(
        control.regularPayCents,
        records.map((record) => record.regularHourHundredths ?? 0),
      );
      const overtime = distribute(
        control.overtimePayCents,
        records.map((record) => record.overtimeHourHundredths ?? 0),
      );
      records.forEach((record, index) => {
        record.regularPayCents = regular[index] ?? 0;
        record.overtimePayCents = overtime[index] ?? 0;
        record.estimatedCostCents = safeSum([record.regularPayCents, record.overtimePayCents]);
      });
    }
    if (group.controlsBlocked || group.chronologyBlocked)
      for (const record of records) {
        record.regularHourHundredths = null;
        record.overtimeHourHundredths = null;
      }
    const warnings = [
      ...new Set([...group.warnings, ...records.flatMap((record) => record.warnings)]),
    ].sort();
    const blockers = [...group.blockers].sort();
    for (const record of records) {
      record.warnings = [...new Set([...record.warnings, ...warnings])].sort();
      record.blockers = [...blockers];
    }
    const rate =
      input.settings.workerRates.find((row) => workerKey(row.workerName) === group.owner) ?? null;
    workerWeeks.push({
      key: group.key,
      workerName:
        control?.workerName ?? group.days[0]?.workerName ?? positive[0]?.workerName ?? group.owner,
      weekStart: group.start,
      weekEnd: addDays(group.start, 6),
      hourlyRateCents: control?.hourlyRateCents ?? null,
      overtimeMultiplier: input.settings.overtime.multiplier,
      complete: control?.complete ?? false,
      grossHourHundredths: hh(control?.grossHours ?? 0),
      lunchAdjustmentHourHundredths: hh(control?.lunchAdjustmentHours ?? 0),
      paidHourHundredths: hh(control?.paidHours ?? 0),
      regularHourHundredths: hh(control?.regularHours ?? 0),
      overtimeHourHundredths: hh(control?.overtimeHours ?? 0),
      regularPayCents: control?.regularPayCents ?? null,
      overtimePayCents: control?.overtimePayCents ?? null,
      estimatedPayCents: control?.estimatedPayCents ?? null,
      sourceEntryIds: group.sources.map((source) => source.id).sort(),
      calculable,
      approvable: calculable && blockers.length === 0,
      warnings,
      blockers,
      fingerprintContext: canonicalJson({
        policyVersion: LABOR_JOB_COST_POLICY_VERSION,
        allocationRulesVersion: input.allocation.rulesVersion,
        workerWeekKey: group.key,
        overtime: input.settings.overtime,
        workerAliases: input.settings.workerAliases ?? [],
        rate,
        payroll: control ?? null,
        sources: [...group.sources].sort((a, b) => a.id.localeCompare(b.id)),
        workerDays: [...group.days].sort((a, b) => a.date.localeCompare(b.date)),
        decisions: group.sources
          .map((source) => decisions.get(source.id) ?? null)
          .sort((a, b) => (a?.sourceEntryId ?? "").localeCompare(b?.sourceEntryId ?? "")),
      }),
    });
    entries.push(...records);
  }
  entries.sort(
    (a, b) =>
      a.workerWeekKey.localeCompare(b.workerWeekKey) ||
      a.date.localeCompare(b.date) ||
      a.sourceEntryId.localeCompare(b.sourceEntryId),
  );
  workerWeeks.sort(
    (a, b) => b.weekStart.localeCompare(a.weekStart) || a.workerName.localeCompare(b.workerName),
  );
  return {
    policyVersion: LABOR_JOB_COST_POLICY_VERSION,
    entries,
    workerWeeks,
    warnings: [...new Set(workerWeeks.flatMap((week) => week.warnings))].sort(),
    blockers: [...new Set(workerWeeks.flatMap((week) => week.blockers))].sort(),
  };
}
