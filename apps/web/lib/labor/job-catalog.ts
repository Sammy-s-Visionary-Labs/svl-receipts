import { createHash } from "node:crypto";
import type { LaborJobCatalog, LaborMappingCatalogJob } from "@svl/domain";
import { createServiceRoleClient } from "@/lib/supabase/service";

const FIELDS =
  "id,label,customer,customer_id,job_number,service_address,status,scheduled_at,active,unavailable,synced_at,provider_updated_at,source";

function nullable(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("Invalid Housecall catalog field.");
  return value;
}

function catalogJob(value: unknown): LaborMappingCatalogJob {
  if (!value || typeof value !== "object") throw new Error("Invalid Housecall catalog row.");
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.label !== "string" ||
    row.source !== "housecall" ||
    typeof row.active !== "boolean" ||
    typeof row.unavailable !== "boolean"
  )
    throw new Error("Invalid Housecall catalog identity.");
  return {
    id: row.id,
    label: row.label,
    customerId: nullable(row.customer_id),
    customer: nullable(row.customer),
    number: nullable(row.job_number),
    address: nullable(row.service_address),
    status: nullable(row.status),
    scheduledAt: nullable(row.scheduled_at),
    active: row.active,
    unavailable: row.unavailable,
    syncedAt: nullable(row.synced_at),
    providerUpdatedAt: nullable(row.provider_updated_at),
  };
}

export function laborJobCatalogFingerprint(jobs: readonly LaborMappingCatalogJob[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...jobs].sort((a, b) => a.id.localeCompare(b.id))))
    .digest("hex");
}

/** Server-only catalog read. Call after the route's manager authorization check. */
export async function loadLaborJobCatalog(): Promise<LaborJobCatalog> {
  const jobs: LaborMappingCatalogJob[] = [];
  let lastSuccessfulSyncAt: string | null = null;
  try {
    const db = createServiceRoleClient();
    const sync = async () => {
      const { data, error } = await db
        .from("housecall_sync_state")
        .select("last_success_at,last_full_sync_at,customer_scope")
        .eq("id", true)
        .maybeSingle();
      if (
        error ||
        !data ||
        !data.last_success_at ||
        !data.last_full_sync_at ||
        !Number.isFinite(Date.parse(data.last_success_at)) ||
        !Number.isFinite(Date.parse(data.last_full_sync_at)) ||
        (data.customer_scope != null &&
          (!Array.isArray(data.customer_scope) || data.customer_scope.length > 0))
      )
        throw new Error("A complete Housecall catalog sync is required.");
      return data;
    };
    const before = await sync();
    lastSuccessfulSyncAt = before.last_success_at;
    const ids = new Set<string>();
    let complete = false;
    for (let offset = 0; offset < 50000; offset += 500) {
      const { data, error } = await db
        .from("manager_job_catalog")
        .select(FIELDS)
        .eq("source", "housecall")
        .order("id")
        .range(offset, offset + 499);
      if (error || !Array.isArray(data))
        throw new Error("The complete Housecall catalog could not be read.");
      for (const row of data) {
        const job = catalogJob(row);
        if (ids.has(job.id)) throw new Error("The Housecall catalog changed during pagination.");
        ids.add(job.id);
        jobs.push(job);
      }
      if (data.length < 500) {
        complete = true;
        break;
      }
    }
    if (!complete || !jobs.length)
      throw new Error("The complete Housecall catalog is unavailable.");
    const after = await sync();
    if (JSON.stringify(before) !== JSON.stringify(after))
      throw new Error("The Housecall catalog changed during this read.");
    return {
      jobs,
      complete: true,
      lastSuccessfulSyncAt,
      fingerprint: laborJobCatalogFingerprint(jobs),
      warnings: [],
    };
  } catch {
    return {
      jobs,
      complete: false,
      lastSuccessfulSyncAt,
      fingerprint: null,
      warnings: [
        "The complete Housecall job catalog is unavailable. New job links require a complete catalog and current job details.",
      ],
    };
  }
}
