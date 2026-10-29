import {
  createLaborWorkerIdentityResolver,
  type LaborEntryAllocation,
  type LaborWorkerAlias,
} from "@svl/domain";
import type { JobActivity, JobReceiptActivity } from "@/lib/labor/contract";

type JobActivityFilters = { from: string; to: string; worker: string };

function inDateRange(date: string, { from, to }: JobActivityFilters) {
  return (!from || date >= from) && (!to || date <= to);
}

function receiptInDateRange(receipt: JobReceiptActivity, filters: JobActivityFilters) {
  if (!filters.from && !filters.to) return true;
  const submitted = new Date(receipt.submittedAt);
  if (Number.isNaN(submitted.getTime())) return false;
  return inDateRange(
    submitted.toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
    filters,
  );
}

const sumHours = (entries: readonly LaborEntryAllocation[]) =>
  entries.reduce((sum, entry) => sum + Math.round(entry.allocatedHours * 100), 0) / 100;

/** One filtered view for the overview, job groups, and activity tables. */
export function filterJobActivity(
  jobs: readonly JobActivity[],
  entries: readonly LaborEntryAllocation[],
  unassignedReceipts: readonly JobReceiptActivity[],
  filters: JobActivityFilters,
  workerAliases: readonly LaborWorkerAlias[] = [],
) {
  const canonicalWorker = createLaborWorkerIdentityResolver(workerAliases);
  const allocations = entries.filter(
    (entry) =>
      (!filters.worker || canonicalWorker(entry.workerName) === canonicalWorker(filters.worker)) &&
      inDateRange(entry.date, filters),
  );
  const entriesByJob = new Map<string, LaborEntryAllocation[]>();
  for (const entry of allocations) {
    if (entry.status !== "allocated" || !entry.job) continue;
    const rows = entriesByJob.get(entry.job.key) ?? [];
    rows.push(entry);
    entriesByJob.set(entry.job.key, rows);
  }
  const filteredJobs = jobs
    .map((job): JobActivity => {
      const rows = entriesByJob.get(job.key) ?? [];
      const receipts = job.receipts.filter((receipt) => receiptInDateRange(receipt, filters));
      return {
        ...job,
        hours: sumHours(rows),
        travelHours: sumHours(rows.filter((entry) => entry.sourceKind === "travel")),
        entryCount: rows.length,
        workerCount: new Set(rows.map((entry) => canonicalWorker(entry.workerName))).size,
        receipts,
        receiptCount: receipts.length,
        receiptTotalCents:
          receipts.length > 0 && receipts.every((receipt) => receipt.amountCents !== null)
            ? receipts.reduce((sum, receipt) => sum + (receipt.amountCents ?? 0), 0)
            : null,
      };
    })
    .filter((job) => job.entryCount > 0 || job.receiptCount > 0);
  const filteredUnassigned = unassignedReceipts.filter((receipt) =>
    receiptInDateRange(receipt, filters),
  );
  return {
    jobs: filteredJobs,
    allocations,
    unassignedReceipts: filteredUnassigned,
    summary: {
      jobCount: filteredJobs.length,
      allocatedHours: filteredJobs.reduce((sum, job) => sum + Math.round(job.hours * 100), 0) / 100,
      assignedReceiptCount: filteredJobs.reduce((sum, job) => sum + job.receiptCount, 0),
      unassignedReceiptCount: filteredUnassigned.length,
    },
  };
}

/** Old source links remain useful only when their imported ranges share one destination. */
export function resolveJobSelection(
  jobs: readonly JobActivity[],
  entries: readonly LaborEntryAllocation[],
  key: string,
) {
  const direct = jobs.find((job) => job.key === key);
  if (direct) return { job: direct, ambiguous: false };
  const keys = new Set(
    entries
      .filter(
        (entry) => entry.status === "allocated" && entry.destinationSourceKey === key && entry.job,
      )
      .map((entry) => entry.job?.key),
  );
  if (keys.size !== 1) return { job: undefined, ambiguous: keys.size > 1 };
  return { job: jobs.find((job) => keys.has(job.key)), ambiguous: false };
}
