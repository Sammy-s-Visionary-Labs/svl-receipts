import type { LaborDashboardData } from "@/lib/labor/contract";

export type DisplayEntry = LaborDashboardData["entries"][number];
export type LaborFilters = {
  search: string;
  worker: string;
  job: string;
  from: string;
  to: string;
};
export const EMPTY_LABOR_FILTERS: LaborFilters = {
  search: "",
  worker: "",
  job: "",
  from: "",
  to: "",
};

export function filterLaborEntries(entries: DisplayEntry[], filters: LaborFilters) {
  const query = filters.search.trim().toLocaleLowerCase();
  return entries.filter((entry) => {
    if (filters.worker && entry.workerName !== filters.worker) return false;
    if (filters.job && entry.jobKey !== filters.job) return false;
    if (filters.from && entry.date < filters.from) return false;
    if (filters.to && entry.date > filters.to) return false;
    return (
      !query ||
      [entry.workerName, entry.jobName, entry.jobAddress, entry.crew, entry.role].some((value) =>
        value.toLocaleLowerCase().includes(query),
      )
    );
  });
}

export function summarizeEntries(entries: DisplayEntry[], groupBy: "worker" | "job" | "day") {
  const groups = new Map<
    string,
    {
      key: string;
      name: string;
      address: string;
      hours: number;
      travelHours: number;
      reportedCostCents: number;
      entryCount: number;
      workers: Set<string>;
      jobs: Set<string>;
    }
  >();
  for (const entry of entries) {
    const key =
      groupBy === "worker"
        ? entry.workerName
        : groupBy === "job"
          ? entry.jobKey
          : `${entry.date}\u0000${entry.workerName}`;
    const name =
      groupBy === "worker" ? entry.workerName : groupBy === "job" ? entry.jobName : entry.date;
    const group = groups.get(key) ?? {
      key,
      name,
      address: groupBy === "job" ? entry.jobAddress : "",
      hours: 0,
      travelHours: 0,
      reportedCostCents: 0,
      entryCount: 0,
      workers: new Set<string>(),
      jobs: new Set<string>(),
    };
    group.hours += entry.hours;
    if (entry.travel) group.travelHours += entry.hours;
    group.reportedCostCents += entry.laborCostCents;
    group.entryCount++;
    group.workers.add(entry.workerName);
    group.jobs.add(entry.jobKey);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) =>
    groupBy === "day"
      ? b.name.localeCompare(a.name) || [...a.workers][0].localeCompare([...b.workers][0])
      : b.hours - a.hours || a.name.localeCompare(b.name),
  );
}

export function hours(value: number) {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function sourceMoney(value: number | null) {
  return value === null
    ? "Unavailable"
    : (value / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
      });
}

export function shortDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
}

export function localTime(value: string | null, timeZone = "America/New_York") {
  if (!value) return "Not yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unavailable"
    : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone,
        timeZoneName: "short",
      });
}

export async function readApi<T>(response: Response): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    const message = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(message ?? "The request could not be completed. Try again.");
  }
  return body as T;
}
