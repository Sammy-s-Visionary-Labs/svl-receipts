import type { LaborEntryAllocation, LaborWorkerDayAllocation } from "@svl/domain";

export type AllocationFilters = { worker: string; from: string; to: string; status: string };
export const EMPTY_ALLOCATION_FILTERS: AllocationFilters = {
  worker: "",
  from: "",
  to: "",
  status: "",
};

export function filterAllocationEntries(
  entries: readonly LaborEntryAllocation[],
  filters: AllocationFilters,
) {
  return entries.filter(
    (entry) =>
      (!filters.worker || entry.workerName === filters.worker) &&
      (!filters.from || entry.date >= filters.from) &&
      (!filters.to || entry.date <= filters.to) &&
      (!filters.status || entry.status === filters.status),
  );
}

export function filterWorkerDays(
  days: readonly LaborWorkerDayAllocation[],
  filters: AllocationFilters,
) {
  // A decision filter never changes a worker's complete-day gross/lunch/net basis.
  return days.filter(
    (day) =>
      (!filters.worker || day.workerName === filters.worker) &&
      (!filters.from || day.date >= filters.from) &&
      (!filters.to || day.date <= filters.to),
  );
}

export function allocatedJobRows(entries: readonly LaborEntryAllocation[]) {
  const groups = new Map<
    string,
    {
      job: NonNullable<LaborEntryAllocation["job"]>;
      hours: number;
      entryCount: number;
      workers: Set<string>;
    }
  >();
  for (const entry of entries) {
    if (entry.status !== "allocated" || !entry.job) continue;
    const group = groups.get(entry.job.key) ?? {
      job: entry.job,
      hours: 0,
      entryCount: 0,
      workers: new Set<string>(),
    };
    group.hours += Math.round(entry.allocatedHours * 100);
    group.entryCount++;
    group.workers.add(entry.workerName);
    groups.set(entry.job.key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, hours: group.hours / 100 }))
    .sort((a, b) => b.hours - a.hours || a.job.name.localeCompare(b.job.name));
}

export function allocatedWorkerDays(entries: readonly LaborEntryAllocation[]) {
  const groups = new Map<
    string,
    {
      key: string;
      date: string;
      workerName: string;
      hours: number;
      entryCount: number;
      sourceTravelHours: number;
    }
  >();
  for (const entry of entries) {
    if (entry.status !== "allocated") continue;
    const key = JSON.stringify([entry.date, entry.workerName]);
    const group = groups.get(key) ?? {
      key,
      date: entry.date,
      workerName: entry.workerName,
      hours: 0,
      entryCount: 0,
      sourceTravelHours: 0,
    };
    group.hours += Math.round(entry.allocatedHours * 100);
    if (entry.sourceKind === "travel")
      group.sourceTravelHours += Math.round(entry.allocatedHours * 100);
    group.entryCount++;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      hours: group.hours / 100,
      sourceTravelHours: group.sourceTravelHours / 100,
    }))
    .sort((a, b) => b.date.localeCompare(a.date) || a.workerName.localeCompare(b.workerName));
}

export function allocationReason(value: string) {
  return value.replaceAll("_", " ");
}
