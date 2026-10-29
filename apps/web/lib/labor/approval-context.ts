import { createHash } from "node:crypto";
import {
  buildLaborApprovalSnapshot,
  canonicalLaborApprovalSnapshot,
  canonicalLaborWorkerName,
  type LaborApprovalSnapshot,
  laborCatalogJobDisplayName,
  laborCatalogJobIsStale,
} from "@svl/domain";
import { AuthHttpError } from "@/lib/auth/guards";
import type { LaborApprovalPreview } from "./approval-contract";
import { laborUsesSupabase } from "./config";
import { readSupabaseLaborState } from "./persistence";
import { loadLaborDashboard } from "./store";

export type LaborApprovalScope = {
  housecallJobId: string;
  fromDate: string;
  toDate: string;
  workerNames?: string[];
};

export function laborApprovalScope(input: Record<string, unknown>): LaborApprovalScope {
  const date = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  if (
    typeof input.housecallJobId !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(input.housecallJobId) ||
    !date(input.fromDate) ||
    !date(input.toDate) ||
    input.fromDate > input.toDate ||
    Date.parse(input.toDate) - Date.parse(input.fromDate) > 366 * 86_400_000
  )
    throw new Error("Choose a Housecall job and a valid review period of at most 367 days.");
  if (
    input.workerNames !== undefined &&
    (!Array.isArray(input.workerNames) ||
      input.workerNames.length > 100 ||
      input.workerNames.some(
        (name) => typeof name !== "string" || !name.trim() || name.length > 200,
      ) ||
      new Set(input.workerNames).size !== input.workerNames.length)
  )
    throw new Error("Choose valid workers to include in this job approval.");
  return {
    housecallJobId: input.housecallJobId,
    fromDate: input.fromDate,
    toDate: input.toDate,
    ...(input.workerNames !== undefined
      ? { workerNames: [...(input.workerNames as string[])].sort() }
      : {}),
  };
}

export function laborApprovalSnapshotHash(snapshot: LaborApprovalSnapshot): string {
  return createHash("sha256").update(canonicalLaborApprovalSnapshot(snapshot)).digest("hex");
}

export async function loadLaborApprovalContext() {
  const shared = laborUsesSupabase();
  const before = shared ? await readSupabaseLaborState() : null;
  const dashboard = await loadLaborDashboard();
  const after = shared ? await readSupabaseLaborState() : null;
  if (shared && (!before || !after || before.revision !== after.revision))
    throw new AuthHttpError(
      409,
      "stale_review",
      "Hours changed while loading. Refresh the review.",
    );
  const hashes = new Map<string, string>();
  for (const row of (after?.state.imports ?? []) as Record<string, unknown>[])
    if (typeof row.id === "string" && typeof row.hash === "string") hashes.set(row.id, row.hash);
  return {
    dashboard,
    storageRevision: after?.revision ?? null,
    sourceEntries: dashboard.entries.map((row) => ({
      ...row,
      importHash: hashes.get(row.importId) ?? "",
    })),
  };
}

export function laborApprovalPreview(
  context: Awaited<ReturnType<typeof loadLaborApprovalContext>>,
  scope: LaborApprovalScope,
): { preview: LaborApprovalPreview; snapshot: LaborApprovalSnapshot | null } {
  const { dashboard } = context;
  const aliases = dashboard.paySettings.workerAliases ?? [];
  const canonicalName = (name: string) => canonicalLaborWorkerName(name, aliases);
  const target = dashboard.jobCatalog.jobs.find((job) => job.id === scope.housecallJobId);
  const allJobRows = dashboard.allocation.entries.filter(
    (entry) =>
      entry.status === "allocated" &&
      entry.allocatedHours > 0 &&
      entry.job?.housecallJobId === scope.housecallJobId &&
      entry.date >= scope.fromDate &&
      entry.date <= scope.toDate,
  );
  const availableNames = new Set(allJobRows.map((entry) => canonicalName(entry.workerName)));
  if (scope.workerNames?.some((name) => !availableNames.has(name)))
    throw new AuthHttpError(
      409,
      "stale_review",
      "The selected worker list changed. Refresh the job review.",
    );
  const rows =
    scope.workerNames === undefined
      ? allJobRows
      : allJobRows.filter((entry) => scope.workerNames?.includes(canonicalName(entry.workerName)));
  const sourceById = new Map(context.sourceEntries.map((entry) => [entry.id, entry]));
  const blockers: string[] = [];
  if (context.storageRevision === null)
    blockers.push(
      "Shared approval storage is required; a local preview cannot approve business hours.",
    );
  if (!dashboard.jobCatalog.complete || !dashboard.jobCatalog.fingerprint)
    blockers.push("Refresh the complete Housecall catalog before approving.");
  if (!target?.customerId || target.unavailable || laborCatalogJobIsStale(target))
    blockers.push(
      "The Housecall job or customer is unavailable or stale. Refresh and review its identity.",
    );
  if (!rows.length)
    blockers.push("There are no linked allocated hours for this job in these dates.");
  let snapshot: LaborApprovalSnapshot | null = null;
  try {
    if (target && rows.length)
      snapshot = buildLaborApprovalSnapshot({
        ...scope,
        catalogJob: target,
        allocation: {
          ...dashboard.allocation,
          entries: dashboard.allocation.entries.filter(
            (entry) =>
              entry.job?.housecallJobId !== scope.housecallJobId ||
              entry.date < scope.fromDate ||
              entry.date > scope.toDate ||
              scope.workerNames === undefined ||
              scope.workerNames.includes(canonicalName(entry.workerName)),
          ),
        },
        sourceEntries: context.sourceEntries,
        workerAliases: aliases,
      });
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : "The selected hours cannot be frozen.");
  }
  const entries = rows.map((entry) => {
    const source = sourceById.get(entry.sourceEntryId);
    return {
      sourceEntryId: entry.sourceEntryId,
      workerName: canonicalName(entry.workerName),
      sourceWorkerName: entry.workerName,
      date: entry.date,
      sourceJobName: source?.jobName ?? "Unavailable",
      clockIn: source?.clockIn ?? "",
      clockOut: source?.clockOut ?? "",
      sourceHours: source?.hours ?? entry.sourceHours,
      hours: entry.allocatedHours,
      reason: entry.reason,
      originalUrl: source ? `/api/manager/labor/imports/${source.importId}/file` : "",
      sourceRow: entry.sourceRow,
    };
  });
  const sum = (values: number[]) =>
    values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;
  const workers = [...new Set(entries.map((entry) => entry.workerName))]
    .sort()
    .map((workerName) => {
      const workerRows = rows.filter((entry) => canonicalName(entry.workerName) === workerName);
      return {
        workerName,
        hours: sum(workerRows.map((entry) => entry.allocatedHours)),
        days: [...new Set(workerRows.map((entry) => entry.date))].sort().map((date) => {
          const day = workerRows.filter((entry) => entry.date === date);
          return {
            date,
            hours: sum(day.map((entry) => entry.allocatedHours)),
            travelHours: sum(
              day
                .filter((entry) => entry.sourceKind === "travel")
                .map((entry) => entry.allocatedHours),
            ),
            entryCount: day.length,
          };
        }),
      };
    });
  const unresolved = dashboard.allocation.entries.filter(
    (entry) =>
      entry.status === "pending" && entry.date >= scope.fromDate && entry.date <= scope.toDate,
  );
  return {
    snapshot,
    preview: {
      ...scope,
      jobName: target
        ? laborCatalogJobDisplayName(target)
        : (rows[0]?.job?.name ?? scope.housecallJobId),
      address: target?.address ?? rows[0]?.job?.address ?? "",
      snapshotHash: snapshot ? laborApprovalSnapshotHash(snapshot) : "",
      storageRevision: context.storageRevision,
      totalHours: sum(rows.map((entry) => entry.allocatedHours)),
      travelHours: sum(
        rows.filter((entry) => entry.sourceKind === "travel").map((entry) => entry.allocatedHours),
      ),
      entryCount: rows.length,
      availableWorkers: [...availableNames].sort().map((workerName) => ({
        workerName,
        hours: sum(
          allJobRows
            .filter((entry) => canonicalName(entry.workerName) === workerName)
            .map((entry) => entry.allocatedHours),
        ),
      })),
      workers,
      entries,
      lunchDisclosure:
        "Original allocated job hours remain before lunch. Estimated paid hours spread each day's lunch proportionally across all of the worker's positive time, including other jobs, excluded and pending time. Overtime follows clock order in the saved workweek.",
      warnings: [
        ...new Set([
          ...rows.flatMap((entry) => [...entry.reviewReasons]),
          ...(dashboard.allocation.entries.some(
            (entry) =>
              entry.status === "allocated" &&
              entry.job?.housecallJobId === scope.housecallJobId &&
              entry.date >= scope.fromDate &&
              entry.date <= scope.toDate &&
              entry.sourceHours === 0,
          )
            ? [
                "Zero-hour source rows remain in the original records and are not included in this approval.",
              ]
            : []),
        ]),
      ],
      blockers: [...new Set(blockers)],
      unresolved: {
        entryCount: unresolved.length,
        hours: sum(unresolved.map((entry) => entry.pendingHours)),
      },
      costEstimate: {
        policyDescription:
          "Daily lunch is spread proportionally across all positive time. Weekly overtime follows clock order after the saved threshold. Costs use current estimated rates; complete weeks and known clocks/rates are required for approval.",
        paidHours: 0,
        regularHours: null,
        overtimeHours: null,
        totalCostCents: null,
        unpricedHours: 0,
        workers: [],
      },
      housecallInput: null,
    },
  };
}
