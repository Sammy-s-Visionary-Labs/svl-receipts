import type { SupabaseClient } from "@supabase/supabase-js";
import { laborCatalogJobDisplayName } from "@svl/domain";
import type { JobActivity, JobReceiptActivity, JobsDashboardData } from "./contract";
import { type LocalReceipt, loadLaborDashboard, loadLocalReceipts } from "./store";

type ReceiptRow = { id: string; status: string; submitted_at: string | null; created_at: string };
type LineRow = {
  receipt_id: string;
  job_id: string | null;
  qty: number | string;
  unit_cost_cents: number;
};
type CatalogRow = {
  id: string;
  label: string;
  customer: string | null;
  job_number?: string | null;
  service_address: unknown;
};

export function catalogAddress(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const address = value as Record<string, unknown>;
  return [address.street, address.street_line_1, address.city, address.state, address.zip]
    .filter((v) => typeof v === "string" && v)
    .join(", ");
}

function receiptTotals(job: JobActivity): void {
  job.receiptCount = job.receipts.length;
  const amounts = job.receipts.map((receipt) => receipt.amountCents);
  const sum = amounts.reduce<number>((total, amount) => total + (amount ?? 0), 0);
  job.receiptTotalCents =
    amounts.length &&
    amounts.every((amount) => amount !== null && Number.isSafeInteger(amount)) &&
    Number.isSafeInteger(sum)
      ? sum
      : null;
}

function upsertActivity(activities: JobReceiptActivity[], activity: JobReceiptActivity): void {
  const existing = activities.findIndex((value) => value.id === activity.id);
  if (existing < 0) activities.push(activity);
  else activities[existing] = activity;
}

function sourceReceiptJob(receipt: LocalReceipt): JobActivity {
  const key = receipt.jobKey as string;
  let sourceName = key;
  let sourceAddress = "";
  try {
    const source: unknown = JSON.parse(key);
    if (
      Array.isArray(source) &&
      source.length === 2 &&
      source.every((value) => typeof value === "string")
    ) {
      sourceName = source[0];
      sourceAddress = source[1];
    }
  } catch {
    /* A legacy development key is an opaque source destination. */
  }
  return {
    key,
    name: receipt.jobName || sourceName,
    address: receipt.jobAddress || sourceAddress,
    housecallJobId: null,
    hours: 0,
    travelHours: 0,
    reportedCostCents: 0,
    entryCount: 0,
    workerCount: 0,
    receiptCount: 0,
    receiptTotalCents: null,
    receipts: [],
    allocationStatus: "source_only",
  };
}

/** Preserve source receipt destinations even when there are no hours for that job. */
export function addLocalReceiptActivities(jobs: JobActivity[], receipts: LocalReceipt[]) {
  const result = jobs.map((job) => ({ ...job, receipts: [...job.receipts] }));
  const unassignedReceipts: JobReceiptActivity[] = [];
  for (const receipt of receipts) {
    const { jobKey: _jobKey, jobName: _jobName, jobAddress: _jobAddress, ...source } = receipt;
    const activity = { ...source, href: null };
    if (!receipt.jobKey) {
      upsertActivity(unassignedReceipts, activity);
      continue;
    }
    let job = result.find((value) => value.key === receipt.jobKey);
    if (!job) {
      job = sourceReceiptJob(receipt);
      result.push(job);
    }
    upsertActivity(job.receipts, activity);
  }
  for (const job of result) receiptTotals(job);
  return { jobs: result.sort((a, b) => a.name.localeCompare(b.name)), unassignedReceipts };
}

/** Match PostgreSQL's positive decimal rounding rather than binary floating-point multiplication. */
function lineCostCents(line: LineRow): number | null {
  const quantity = String(line.qty).trim();
  if (quantity.length > 30) return null;
  const decimal = /^(\d+)(?:\.(\d{1,6}))?$/.exec(quantity);
  if (!decimal || !Number.isSafeInteger(line.unit_cost_cents) || line.unit_cost_cents < 0)
    return null;
  const fraction = decimal[2] ?? "";
  const units = BigInt(`${decimal[1]}${fraction}`);
  if (units <= BigInt(0)) return null;
  const scale = BigInt(10) ** BigInt(fraction.length);
  const rounded = (units * BigInt(line.unit_cost_cents) + scale / BigInt(2)) / scale;
  const amount = Number(rounded);
  return Number.isSafeInteger(amount) ? amount : null;
}

function linesTotal(lines: LineRow[]): number | null {
  if (!lines.length) return null;
  const amounts = lines.map(lineCostCents);
  if (amounts.some((amount) => amount === null)) return null;
  const total = amounts.reduce<number>((sum, amount) => sum + (amount ?? 0), 0);
  return Number.isSafeInteger(total) ? total : null;
}

export function addReceiptActivities(
  jobs: JobActivity[],
  receipts: ReceiptRow[],
  lines: LineRow[],
  catalog: CatalogRow[],
) {
  const result = jobs.map((job) => ({
    ...job,
    key: job.housecallJobId ? `housecall:${job.housecallJobId}` : job.key,
    allocationStatus: job.housecallJobId ? ("mapped" as const) : job.allocationStatus,
    receipts: [...job.receipts],
  }));
  const canonicalIds = result.map((job) => job.housecallJobId).filter((id): id is string => !!id);
  if (new Set(canonicalIds).size !== canonicalIds.length)
    throw new Error(
      "Allocated labor must be consolidated by Housecall job before receipts are attached.",
    );
  const unassignedReceipts: JobReceiptActivity[] = [];
  for (const receipt of receipts) {
    const receiptLines = lines.filter((line) => line.receipt_id === receipt.id);
    const assigned = [
      ...new Set(receiptLines.map((line) => line.job_id).filter((id): id is string => !!id)),
    ];
    const makeActivity = (amountCents: number | null): JobReceiptActivity => ({
      id: receipt.id,
      reference: receipt.id.slice(0, 8),
      vendor: null,
      submittedAt: receipt.submitted_at ?? receipt.created_at,
      status: receipt.status,
      amountCents,
      href: `/receipts/${encodeURIComponent(receipt.id)}`,
    });
    const unassignedLines = receiptLines.filter((line) => !line.job_id);
    if (!receiptLines.length || unassignedLines.length)
      upsertActivity(unassignedReceipts, makeActivity(linesTotal(unassignedLines)));
    for (const jobId of assigned) {
      let job = result.find((value) => value.housecallJobId === jobId);
      if (!job) {
        const source = catalog.find((value) => value.id === jobId);
        job = {
          key: `housecall:${jobId}`,
          name: source
            ? laborCatalogJobDisplayName({
                label: source.label,
                customer: source.customer,
                number: source.job_number ?? null,
              }) || `Job ${jobId}`
            : `Job ${jobId}`,
          address: catalogAddress(source?.service_address),
          housecallJobId: jobId,
          hours: 0,
          travelHours: 0,
          reportedCostCents: 0,
          entryCount: 0,
          workerCount: 0,
          receiptCount: 0,
          receiptTotalCents: null,
          receipts: [],
          allocationStatus: "mapped",
        };
        result.push(job);
      }
      const assignedLines = receiptLines.filter((line) => line.job_id === jobId);
      upsertActivity(job.receipts, makeActivity(linesTotal(assignedLines)));
    }
  }
  for (const job of result) receiptTotals(job);
  return { jobs: result.sort((a, b) => a.name.localeCompare(b.name)), unassignedReceipts };
}

async function paged<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; offset < 10000; offset += 500) {
    const { data, error } = await query(offset, offset + 499);
    if (error || !Array.isArray(data)) throw new Error("Job receipt query failed");
    all.push(...(data as T[]));
    if (data.length < 500) return all;
  }
  throw new Error("Job receipt query exceeded its limit; results were not truncated silently");
}

export async function loadJobsDashboard(db: SupabaseClient | null): Promise<JobsDashboardData> {
  const labor = await loadLaborDashboard();
  if (!db) {
    if (!labor.development)
      throw new Error("The authorized receipt database is required for job activity.");
    const local = await loadLocalReceipts();
    const activities = addLocalReceiptActivities(labor.jobs, local);
    return {
      development: labor.development,
      allocation: labor.allocation,
      workerAliases: labor.paySettings?.workerAliases,
      imports: labor.imports,
      ...activities,
      entries: labor.entries,
      receiptSource: local.length ? "local_development" : "not_configured",
      warnings: local.length
        ? []
        : [
            "No local development receipt database is connected. Production receipts are not loaded.",
            "Job hours follow the development allocation rules. Locations and ambiguous intervals needing review remain in Labor Hours.",
          ],
    };
  }
  const [receipts, lines, catalog] = await Promise.all([
    paged<ReceiptRow>((from, to) =>
      db
        .from("receipts")
        .select("id,status,submitted_at,created_at")
        .not("submitted_at", "is", null)
        .is("content_deleted_at", null)
        .is("purge_claimed_at", null)
        .neq("status", "upload_pending")
        .order("id")
        .range(from, to),
    ),
    paged<LineRow>((from, to) =>
      db
        .from("receipt_lines")
        .select("receipt_id,job_id,qty,unit_cost_cents")
        .order("id")
        .range(from, to),
    ),
    paged<CatalogRow>((from, to) =>
      db
        .from("manager_job_catalog")
        .select("id,label,customer,job_number,service_address")
        .order("id")
        .range(from, to),
    ),
  ]);
  const activities = addReceiptActivities(labor.jobs, receipts, lines, catalog);
  return {
    development: labor.development,
    allocation: labor.allocation,
    workerAliases: labor.paySettings?.workerAliases,
    imports: labor.imports,
    ...activities,
    entries: labor.entries,
    receiptSource: labor.development ? "development_database" : "supabase",
    warnings: [
      "Unlinked Supercrew source jobs remain separate from Housecall jobs. No name-only customer matching is applied.",
    ],
  };
}
