import {
  createLaborWorkerIdentityResolver,
  type LaborEntryAllocation,
  type LaborWorkerAlias,
  type LaborWorkerDayAllocation,
  normalizeLaborWorkerName,
} from "@svl/domain";

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
  workerAliases: readonly LaborWorkerAlias[] = [],
) {
  const canonicalWorker = createLaborWorkerIdentityResolver(workerAliases);
  return entries.filter(
    (entry) =>
      (!filters.worker || canonicalWorker(entry.workerName) === canonicalWorker(filters.worker)) &&
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

export function allocatedJobRows(
  entries: readonly LaborEntryAllocation[],
  workerAliases: readonly LaborWorkerAlias[] = [],
) {
  const canonicalWorker = createLaborWorkerIdentityResolver(workerAliases);
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
    group.workers.add(canonicalWorker(entry.workerName));
    groups.set(entry.job.key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, hours: group.hours / 100 }))
    .sort((a, b) => b.hours - a.hours || a.job.name.localeCompare(b.job.name));
}

export function allocatedWorkerDays(
  entries: readonly LaborEntryAllocation[],
  workerAliases: readonly LaborWorkerAlias[] = [],
) {
  const canonicalWorker = createLaborWorkerIdentityResolver(workerAliases);
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
    const workerName = canonicalWorker(entry.workerName);
    const key = JSON.stringify([entry.date, workerName]);
    const group = groups.get(key) ?? {
      key,
      date: entry.date,
      workerName,
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

export function laborNoteMatchesWorker(
  noteWorkerName: string,
  selectedWorker: string,
  noteAliases: readonly LaborWorkerAlias[] = [],
  workerAliases: readonly LaborWorkerAlias[] = [],
) {
  if (!selectedWorker) return true;
  const canonicalWorker = createLaborWorkerIdentityResolver(workerAliases);
  const selected = normalizeLaborWorkerName(canonicalWorker(selectedWorker));
  const note = normalizeLaborWorkerName(noteWorkerName);
  return (
    normalizeLaborWorkerName(canonicalWorker(noteWorkerName)) === selected ||
    noteAliases.some(
      (alias) =>
        normalizeLaborWorkerName(alias.alias) === note &&
        normalizeLaborWorkerName(canonicalWorker(alias.workerName)) === selected,
    )
  );
}
