/** Source facts from a Supercrew export. Costing and destination allocation are separate decisions. */
export interface LaborEntry {
  id: string;
  kind: "work" | "travel" | "unpaid_break";
  date: string;
  workerName: string;
  jobName: string;
  jobAddress: string;
  clockIn: string;
  clockOut: string;
  clockInMethod: string;
  clockOutMethod: string;
  timeEntryType: string;
  crew: string;
  role: string;
  jobCode: string | null;
  employeeId: string | null;
  hours: number;
  travel: boolean;
  laborCostCents: number;
  billableCostCents: number;
  sourceRow: number;
}

export interface LaborTotals {
  /** Includes travel. Travel must not be added again. */
  hours: number;
  travelHours: number;
  laborCostCents: number;
  billableCostCents: number;
}

export interface LaborReportedTotals extends Omit<LaborTotals, "travelHours"> {
  /** Null when the workbook does not supply an independent travel control. */
  travelHours: number | null;
}

export interface LaborReport {
  entries: LaborEntry[];
  /** Source-local display timestamp. The export does not specify a timezone. */
  generatedAt: string;
  period: { from: string; to: string };
  filters: { jobs: string; workers: string; timeEntryType: string; budgetStatus: string };
  reportedTotals: LaborReportedTotals;
  computedTotals: LaborTotals;
  /** Distinct published controls; independently rounded summaries must not replace detail facts. */
  reconciliationControls?: { sheet: string; totals: LaborReportedTotals }[];
  warnings: string[];
  formatVersion: string;
}

export interface LaborJobGroup {
  key: string;
  name: string;
  address: string;
  hours: number;
  travelHours: number;
  reportedCostCents: number;
  entryCount: number;
  workerCount: number;
}

export interface LaborWorkerGroup {
  key: string;
  name: string;
  hours: number;
  travelHours: number;
  reportedCostCents: number;
  entryCount: number;
  jobCount: number;
}

/** Lossless source grouping only. This key is not a Housecall destination or authorization. */
export function sourceJobKey(name: string, address: string): string {
  return JSON.stringify([name, address]);
}

export function sourceWorkerKey(entry: Pick<LaborEntry, "employeeId" | "workerName">): string {
  return JSON.stringify([entry.employeeId, entry.workerName]);
}

export function laborTotals(entries: readonly LaborEntry[]): LaborTotals {
  let hundredths = 0;
  let travelHundredths = 0;
  let laborCostCents = 0;
  let billableCostCents = 0;
  for (const entry of entries) {
    // The supported report exposes hundredths of an hour, not exact elapsed seconds.
    const quantity = Math.round(entry.hours * 100);
    hundredths += quantity;
    if (entry.travel) travelHundredths += quantity;
    laborCostCents += entry.laborCostCents;
    billableCostCents += entry.billableCostCents;
  }
  return {
    hours: hundredths / 100,
    travelHours: travelHundredths / 100,
    laborCostCents,
    billableCostCents,
  };
}

export function groupLaborEntries(entries: readonly LaborEntry[]): {
  jobs: LaborJobGroup[];
  workers: LaborWorkerGroup[];
} {
  const jobEntries = new Map<string, LaborEntry[]>();
  const workerEntries = new Map<string, LaborEntry[]>();
  for (const entry of entries) {
    const jobKey = sourceJobKey(entry.jobName, entry.jobAddress);
    const workerKey = sourceWorkerKey(entry);
    const jobs = jobEntries.get(jobKey) ?? [];
    jobs.push(entry);
    jobEntries.set(jobKey, jobs);
    const workers = workerEntries.get(workerKey) ?? [];
    workers.push(entry);
    workerEntries.set(workerKey, workers);
  }
  const jobs = [...jobEntries].map(([key, group]) => {
    const first = group[0] as LaborEntry;
    const totals = laborTotals(group);
    return {
      key,
      name: first.jobName,
      address: first.jobAddress,
      hours: totals.hours,
      travelHours: totals.travelHours,
      reportedCostCents: totals.laborCostCents,
      entryCount: group.length,
      workerCount: new Set(group.map(sourceWorkerKey)).size,
    };
  });
  const workers = [...workerEntries].map(([key, group]) => {
    const first = group[0] as LaborEntry;
    const totals = laborTotals(group);
    return {
      key,
      name: first.workerName,
      hours: totals.hours,
      travelHours: totals.travelHours,
      reportedCostCents: totals.laborCostCents,
      entryCount: group.length,
      jobCount: new Set(group.map((entry) => sourceJobKey(entry.jobName, entry.jobAddress))).size,
    };
  });
  jobs.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  workers.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  return { jobs, workers };
}
