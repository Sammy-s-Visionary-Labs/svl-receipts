import type { LaborEntry } from "./labor";
import {
  type LaborAllocationReport,
  type LaborWorkerDayAllocation,
  normalizeLaborWorkerName,
} from "./labor-allocation";
import type { LaborJobMapping, LaborMappingCatalogJob } from "./labor-job-mapping";
import { canonicalLaborWorkerName, type LaborWorkerAlias } from "./labor-worker-identity";

export type LaborApprovalSourceEntry = LaborEntry & { importId: string; importHash: string };
export type LaborApprovalCostEstimate = {
  policyVersion: string;
  paidHourHundredths: number;
  regularHourHundredths: number;
  overtimeHourHundredths: number;
  totalCostCents: number;
  workers: {
    workerName: string;
    sourceHourHundredths: number;
    paidHourHundredths: number;
    regularHourHundredths: number;
    overtimeHourHundredths: number;
    totalCostCents: number;
  }[];
  workerWeeks: { key: string; fingerprintContext: string }[];
};
export type LaborApprovalProviderIntent = {
  version: 1;
  destination: "job_input_materials";
  costTreatment: "approved_total_cost";
  preparedWrite: {
    kind: "job_cost";
    jobId: string;
    method: "PUT";
    path: string;
    reference: string;
    body: {
      job_input_materials: {
        name: string;
        description: string;
        part_number: string;
        quantity: number;
        unit_cost: number;
      }[];
    };
    requestHash: string;
  };
};
export type LaborApprovalInterval = {
  sourceEntryId: string;
  sourceImportId: string;
  sourceFileSha256: string;
  sourceRow: number;
  workerName: string;
  normalizedWorkerName: string;
  /** Reviewed identity for rollups; workerName remains the immutable source spelling. */
  canonicalWorkerName?: string;
  employeeId: string | null;
  date: string;
  clockIn: string;
  clockOut: string;
  startMinute: number;
  endMinute: number;
  hourHundredths: number;
  sourceKind: "work" | "travel";
  sourceJobKey: string;
  destinationSourceKey: string;
  reason: string;
  reviewReasons: string[];
  noteIds: string[];
  jobMapping: LaborJobMapping;
};
export type LaborApprovalSnapshot = {
  version: 1;
  housecallJobId: string;
  customerId: string;
  jobName: string;
  jobNumber: string | null;
  jobAddress: string | null;
  customerName: string | null;
  fromDate: string;
  toDate: string;
  allocationRulesVersion: string;
  hourBasis: "allocated_source_hours_before_day_lunch";
  totalHourHundredths: number;
  travelHourHundredths: number;
  entries: LaborApprovalInterval[];
  workerDays: LaborWorkerDayAllocation[];
  unresolved: { entryCount: number; hourHundredths: number };
  disclosures: {
    lunchRedistributed: boolean;
    wageCostsIncluded: boolean;
    provisionalWorkerDates: { workerName: string; date: string }[];
  };
  /** Attached by the trusted provider planner before approval; included in the final hash. */
  providerIntent?: LaborApprovalProviderIntent;
  costEstimate?: LaborApprovalCostEstimate;
  approvedWorkerNames?: string[];
  workerAliases?: readonly LaborWorkerAlias[];
};
export type LaborApprovalSnapshotInput = {
  housecallJobId: string;
  fromDate: string;
  toDate: string;
  catalogJob: LaborMappingCatalogJob;
  allocation: LaborAllocationReport;
  sourceEntries: readonly LaborApprovalSourceEntry[];
  workerAliases?: readonly LaborWorkerAlias[];
};

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const LABOR_APPROVAL_POINT_CLOCK_WARNING =
  "Positive source Hours have same-minute exported clocks; original Hours and clock strings were preserved.";
const dateValid = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
  new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const hundredths = (value: number) => {
  const amount = Math.round(value * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(value * 100 - amount) > 0.000001)
    throw new Error("Approval hours require exact hundredths");
  return amount;
};
const minutes = (clock: string) => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  if (!match) throw new Error("Approval requires known same-day clock boundaries");
  return Number(match[1]) * 60 + Number(match[2]);
};

/** Freeze only reviewed, linked intervals. This grants no provider-write authority. */
export function buildLaborApprovalSnapshot(
  input: LaborApprovalSnapshotInput,
): LaborApprovalSnapshot {
  const { housecallJobId, fromDate, toDate, catalogJob, allocation } = input;
  const aliases = input.workerAliases ?? [];
  const identity = (name: string) =>
    normalizeLaborWorkerName(canonicalLaborWorkerName(name, aliases));
  if (!dateValid(fromDate) || !dateValid(toDate) || fromDate > toDate)
    throw new Error("Approval requires an explicit valid work-date range");
  if (
    !identifier(housecallJobId) ||
    catalogJob.id !== housecallJobId ||
    !identifier(catalogJob.customerId) ||
    catalogJob.unavailable
  )
    throw new Error("Approval requires an available confirmed Housecall customer job");
  const sources = new Map(input.sourceEntries.map((entry) => [entry.id, entry]));
  if (sources.size !== input.sourceEntries.length)
    throw new Error("Approval source identifiers must be unique");
  const selected = allocation.entries.filter(
    (entry) =>
      entry.status === "allocated" &&
      entry.job?.housecallJobId === housecallJobId &&
      entry.allocatedHours !== 0 &&
      entry.date >= fromDate &&
      entry.date <= toDate,
  );
  if (!selected.length) throw new Error("No reviewed linked hours exist for this job and period");
  const seen = new Set<string>();
  const entries = selected.map((entry): LaborApprovalInterval => {
    const source = sources.get(entry.sourceEntryId);
    const mapping = entry.jobMapping;
    if (
      !source ||
      seen.has(entry.sourceEntryId) ||
      source.kind === "unpaid_break" ||
      source.date !== entry.date ||
      source.workerName !== entry.workerName ||
      source.sourceRow !== entry.sourceRow ||
      source.kind !== entry.sourceKind ||
      source.hours !== entry.allocatedHours ||
      source.hours !== entry.sourceHours ||
      source.hours <= 0 ||
      !uuid.test(source.importId) ||
      !/^[a-f0-9]{64}$/.test(source.importHash) ||
      !Number.isSafeInteger(source.sourceRow) ||
      source.sourceRow < 1 ||
      !identifier(source.workerName) ||
      !mapping ||
      mapping.housecallJobId !== housecallJobId ||
      mapping.sourceKey !== entry.destinationSourceKey ||
      !dateValid(mapping.fromDate) ||
      !dateValid(mapping.toDate) ||
      entry.date < mapping.fromDate ||
      entry.date > mapping.toDate
    )
      throw new Error("Approval interval does not match immutable reviewed source provenance");
    seen.add(entry.sourceEntryId);
    const startMinute = minutes(source.clockIn);
    const endMinute = minutes(source.clockOut);
    const hourHundredths = hundredths(source.hours);
    const point = endMinute === startMinute;
    if (endMinute < startMinute || (point && hourHundredths > 2))
      throw new Error("Approval requires positive same-day clock boundaries");
    return {
      sourceEntryId: entry.sourceEntryId,
      sourceImportId: source.importId,
      sourceFileSha256: source.importHash,
      sourceRow: source.sourceRow,
      workerName: source.workerName,
      normalizedWorkerName: normalizeLaborWorkerName(source.workerName),
      ...(aliases.length
        ? { canonicalWorkerName: canonicalLaborWorkerName(source.workerName, aliases) }
        : {}),
      employeeId: source.employeeId,
      date: source.date,
      clockIn: source.clockIn,
      clockOut: source.clockOut,
      startMinute,
      endMinute,
      hourHundredths,
      sourceKind: source.kind,
      sourceJobKey: entry.sourceJobKey,
      destinationSourceKey: entry.destinationSourceKey,
      reason: entry.reason,
      reviewReasons: [
        ...new Set([
          ...entry.reviewReasons,
          ...(point ? [LABOR_APPROVAL_POINT_CLOCK_WARNING] : []),
        ]),
      ].sort(),
      noteIds: [...new Set(entry.noteIds)].sort(),
      jobMapping: { ...mapping },
    };
  });
  entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.normalizedWorkerName.localeCompare(b.normalizedWorkerName) ||
      a.startMinute - b.startMinute ||
      a.endMinute - b.endMinute ||
      a.sourceEntryId.localeCompare(b.sourceEntryId),
  );
  for (let position = 0; position < entries.length; position++) {
    const row = entries[position] as LaborApprovalInterval;
    if (
      entries.slice(0, position).some(
        (previous) =>
          previous.date === row.date &&
          (identity(previous.workerName) === identity(row.workerName) ||
            (!!previous.employeeId && previous.employeeId === row.employeeId)) &&
          // Distinct sub-minute source rows can share one exported minute.
          // A point only intersects a positive span strictly inside its bounds.
          (previous.startMinute === previous.endMinute
            ? row.startMinute < previous.startMinute && previous.startMinute < row.endMinute
            : row.startMinute === row.endMinute
              ? previous.startMinute < row.startMinute && row.startMinute < previous.endMinute
              : previous.startMinute < row.endMinute && row.startMinute < previous.endMinute),
      )
    )
      throw new Error("Approval contains overlapping source intervals for one worker");
  }
  const wantedDays = new Set(entries.map((entry) => `${identity(entry.workerName)}:${entry.date}`));
  const workerDays = allocation.workerDays
    .filter((day) => wantedDays.has(`${identity(day.workerName)}:${day.date}`))
    .map((day) => ({ ...day, reviewReasons: [...day.reviewReasons].sort() }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.workerName.localeCompare(b.workerName));
  if (workerDays.length !== wantedDays.size)
    throw new Error("Approval requires one complete worker-day record per source owner and date");
  if (workerDays.some((day) => day.reviewReasons.some((reason) => reason.includes("provisional"))))
    throw new Error("Approval requires completed source dates; this worker day is provisional");
  for (const day of workerDays) {
    for (const value of [
      day.grossHours,
      day.sourceBreakHours,
      day.sourceNetHours,
      day.lunchAdjustmentHours,
      day.breakDifferenceHours,
      day.netHours,
      day.allocatedHours,
      day.excludedHours,
      day.pendingHours,
    ])
      hundredths(value);
  }
  const unresolved = allocation.entries.filter(
    (entry) => entry.status === "pending" && entry.date >= fromDate && entry.date <= toDate,
  );
  const total = (field: "hourHundredths", subset = entries) => {
    const value = subset.reduce((sum, row) => sum + row[field], 0);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Approval hours exceed the supported range");
    return value;
  };
  return structuredClone({
    version: 1,
    ...(aliases.length ? { workerAliases: aliases.map((alias) => ({ ...alias })) } : {}),
    housecallJobId,
    customerId: catalogJob.customerId,
    jobName: catalogJob.label,
    jobNumber: catalogJob.number,
    jobAddress: catalogJob.address,
    customerName: catalogJob.customer,
    fromDate,
    toDate,
    allocationRulesVersion: allocation.rulesVersion,
    hourBasis: "allocated_source_hours_before_day_lunch",
    totalHourHundredths: total("hourHundredths"),
    travelHourHundredths: entries
      .filter((row) => row.sourceKind === "travel")
      .reduce((sum, row) => sum + row.hourHundredths, 0),
    entries,
    workerDays,
    unresolved: {
      entryCount: unresolved.length,
      hourHundredths: unresolved.reduce((sum, row) => sum + hundredths(row.pendingHours), 0),
    },
    disclosures: {
      lunchRedistributed: false,
      wageCostsIncluded: false,
      provisionalWorkerDates: workerDays
        .filter((day) => day.reviewReasons.some((reason) => reason.includes("provisional")))
        .map((day) => ({ workerName: day.workerName, date: day.date })),
    },
  });
}

/** Stable, browser-safe hash input; the trusted server computes SHA-256 over these UTF-8 bytes. */
export function canonicalLaborApprovalSnapshot(snapshot: LaborApprovalSnapshot): string {
  function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("Approval snapshot must contain only JSON values");
    return result;
  }
  return canonical(snapshot);
}
