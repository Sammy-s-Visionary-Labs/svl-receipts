import { createHousecallClient, HousecallError, type HousecallJob } from "@svl/integrations";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { housecallConfiguration } from "./config";

export { HOUSECALL_JOB_STALE_MS } from "./catalog-policy";
export function jobCatalogRow(job: HousecallJob) {
  return {
    id: job.id,
    label:
      job.description ||
      `${job.customerName || "Housecall job"}${job.invoiceNumber ? ` #${job.invoiceNumber}` : ""}`,
    customer: job.customerName || null,
    customer_id: job.customerId,
    job_number: job.invoiceNumber,
    status: job.workStatus,
    scheduled_at:
      job.scheduledStart && Number.isFinite(Date.parse(job.scheduledStart))
        ? job.scheduledStart
        : null,
    active: job.active && !job.deleted && !job.canceled && !job.locked,
    unavailable: job.deleted || job.canceled || job.locked,
    assigned_employee_ids: job.assignedEmployeeIds,
    service_address: job.address,
    provider_updated_at:
      job.updatedAt && Number.isFinite(Date.parse(job.updatedAt)) ? job.updatedAt : null,
  };
}

type SyncState = {
  lease_token: string;
  last_success_at: string | null;
  last_full_sync_at: string | null;
};
export async function syncHousecallJobs(input?: {
  full?: boolean;
  client?: Pick<ReturnType<typeof createHousecallClient>, "listJobs">;
  db?: ReturnType<typeof createServiceRoleClient>;
  deadlineAt?: number;
}) {
  if (!housecallConfiguration().readsEnabled) return { skipped: "reads_disabled", count: 0 };
  const db = input?.db ?? createServiceRoleClient();
  const client =
    input?.client ??
    createHousecallClient({ apiKey: process.env.HOUSECALL_API_KEY ?? "", timeoutMs: 15_000 });
  const { data, error } = await db.rpc("claim_housecall_job_sync", { p_lease_seconds: 180 });
  if (error) throw error;
  if (!data) return { skipped: "sync_in_progress", count: 0 };
  const state = data as SyncState;
  const startedAt = new Date().toISOString();
  const deadlineAt = input?.deadlineAt ?? Date.now() + 140_000;
  // No updated_since or snapshot cursor exists. Read all pages even on an
  // incremental update so jobs without timestamps cannot hide behind a cutoff.
  const full =
    input?.full === true ||
    !state.last_success_at ||
    !state.last_full_sync_at ||
    Date.now() - Date.parse(state.last_full_sync_at) > 7 * 24 * 60 * 60 * 1000;
  const cutoff =
    !full && state.last_success_at ? Date.parse(state.last_success_at) - 5 * 60_000 : null;
  const jobs = new Map<string, HousecallJob>();
  try {
    let complete = false;
    let expectedTotal: number | null = null;
    let expectedPages: number | null = null;
    for (let page = 1; page <= 100; page++) {
      if (Date.now() + 20_000 > deadlineAt) throw new Error("sync_deadline");
      const result = await client.listJobs({
        page,
        pageSize: 100,
        sortBy: "updated_at",
        sortDirection: "desc",
      });
      if (
        (expectedTotal !== null && result.totalItems !== expectedTotal) ||
        (expectedPages !== null && result.totalPages !== expectedPages) ||
        result.page !== page ||
        (result.jobs.length === 0 && result.totalItems > 0)
      )
        throw new Error("sync_unstable_pages");
      expectedTotal = result.totalItems;
      expectedPages = result.totalPages;
      for (const job of result.jobs) {
        if (jobs.has(job.id)) throw new Error("sync_unstable_pages");
        jobs.set(job.id, job);
      }
      if (page >= result.totalPages) {
        if (jobs.size !== result.totalItems) throw new Error("sync_unstable_pages");
        complete = true;
        break;
      }
    }
    if (!complete) throw new Error("sync_page_limit");
    const changed = [...jobs.values()].filter(
      (job) =>
        cutoff === null ||
        !job.updatedAt ||
        !Number.isFinite(Date.parse(job.updatedAt)) ||
        Date.parse(job.updatedAt) >= cutoff,
    );
    const { error: finishError } = await db.rpc("finish_housecall_job_sync", {
      p_lease_token: state.lease_token,
      p_started_at: startedAt,
      p_jobs: changed.map(jobCatalogRow),
      p_full: full,
      p_observed_job_ids: [...jobs.keys()],
    });
    if (finishError) throw finishError;
    return { count: changed.length, scanned: jobs.size, full, syncedAt: startedAt };
  } catch (cause) {
    const reason =
      cause instanceof HousecallError
        ? ((
            {
              authentication: "provider_authentication_failed",
              rate_limited: "provider_rate_limited",
              timeout: "provider_timeout",
              invalid_response: "provider_invalid_response",
            } as Record<string, string>
          )[cause.code] ?? "sync_failed")
        : cause instanceof Error
          ? cause.message
          : "sync_failed";
    await db.rpc("fail_housecall_job_sync", { p_lease_token: state.lease_token, p_reason: reason });
    throw cause;
  }
}
