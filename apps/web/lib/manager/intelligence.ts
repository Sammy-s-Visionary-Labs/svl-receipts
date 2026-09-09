import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type DuplicateReceipt,
  type JobCatalogEntry,
  type JobHint,
  type ParsedReceiptV1,
  type ReceiptCategory,
  rankJobCandidates,
  scoreDuplicateReceipts,
  suggestReceiptCategory,
} from "@svl/domain";
import { housecallCatalogJobIsStale } from "../housecall/catalog-policy";
import { textValue } from "./detail";

type Row = Record<string, unknown>;
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
export const categoryRow = (r: Row): ReceiptCategory => ({
  id: textValue(r.id),
  label: textValue(r.label),
  active: r.active === true,
  keywords: strings(r.keywords),
  version: Number(r.version) || 1,
});
function duplicateRow(row: Row): DuplicateReceipt {
  return {
    id: textValue(row.id),
    accessScope: "workspace",
    deleted: !!row.content_deleted_at,
    purging: !!row.purge_claimed_at,
    pageHashes: strings(row.page_hashes),
    vendor: textValue(row.vendor) || null,
    purchaseDate: textValue(row.purchase_date) || null,
    totalCents: numeric(row.receipt_total_cents),
    invoiceNumber: textValue(row.invoice_number) || null,
    ticketNumber: textValue(row.ticket_number) || null,
  };
}
export function readIntelligenceConfig(env: Record<string, string | undefined> = process.env) {
  const value = (key: string, fallback: number, max: number, integer = false) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const result = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (
      !Number.isFinite(result) ||
      result < 0 ||
      result > max ||
      (integer && !Number.isSafeInteger(result))
    )
      throw new Error(`invalid_intelligence_config:${key}`);
    return result;
  };
  return {
    duplicate: {
      threshold: value("RECEIPT_DUPLICATE_THRESHOLD", 45, 100),
      amountToleranceCents: value("RECEIPT_DUPLICATE_AMOUNT_TOLERANCE_CENTS", 0, 2147483647, true),
    },
    jobs: {
      maxGpsAccuracyMeters: value("RECEIPT_JOB_MAX_GPS_ACCURACY_METERS", 100, 10000),
      maxDistanceKm: value("RECEIPT_JOB_MAX_DISTANCE_KM", 10, 1000),
      minScore: value("RECEIPT_JOB_MIN_SCORE", 8, 3000),
    },
  };
}
/** Called by the lease-owning worker before one atomic result transaction. No network calls to Housecall. */
export async function buildReceiptIntelligence(
  supabase: SupabaseClient,
  receiptId: string,
  parsed: ParsedReceiptV1,
) {
  const config = readIntelligenceConfig();
  const [duplicateResult, categoryResult] = await Promise.all([
    supabase.rpc("extraction_duplicate_inputs", {
      p_receipt_id: receiptId,
      p_vendor: parsed.vendor,
      p_purchase_date: parsed.purchase_date,
      p_total_cents: parsed.receipt_total_cents,
      p_invoice_number: parsed.invoice_number,
      p_ticket_number: parsed.ticket_number,
      p_total_tolerance_cents: config.duplicate.amountToleranceCents,
    }),
    supabase
      .from("receipt_categories")
      .select("id,label,active,keywords,version")
      .order("id")
      .limit(500),
  ]);
  if (duplicateResult.error) throw duplicateResult.error;
  if (categoryResult.error) throw categoryResult.error;
  const catalog: JobCatalogEntry[] = [];
  const catalogReadAt = Date.now();
  // Page through the saved catalog; a truncated catalog must never silently produce a confident match.
  for (let offset = 0; ; offset += 1000) {
    if (offset >= 50000) throw new Error("job_catalog_exceeds_supported_limit");
    const { data, error } = await supabase
      .from("manager_job_catalog")
      .select(
        "id,label,customer,job_number,status,scheduled_at,active,po_references,service_address,lat,lng,assigned_worker_ids,vendor_history,source,synced_at,unavailable",
      )
      .order("id")
      .range(offset, offset + 999);
    if (error) throw error;
    for (const row of data ?? []) {
      // A saved name/reference match cannot revive a missing or unverified provider job.
      if (row.unavailable === true || housecallCatalogJobIsStale(row, catalogReadAt)) continue;
      catalog.push({
        id: row.id,
        label: row.label,
        customer: row.customer,
        number: row.job_number,
        status: row.status,
        scheduledAt: row.scheduled_at,
        active: row.active,
        poReferences: strings(row.po_references),
        serviceAddress: row.service_address,
        lat: numeric(row.lat),
        lng: numeric(row.lng),
        assignedWorkerIds: strings(row.assigned_worker_ids),
        vendorHistory: strings(row.vendor_history),
      });
    }
    if ((data?.length ?? 0) < 1000) break;
  }
  const rows: Row[] = duplicateResult.data ?? [];
  const current = rows.find((r) => r.id === receiptId);
  if (!current || current.content_deleted_at || current.purge_claimed_at)
    throw new Error("receipt_content_unavailable");
  const receipt = {
    ...duplicateRow(current),
    vendor: parsed.vendor,
    purchaseDate: parsed.purchase_date,
    totalCents: parsed.receipt_total_cents,
    invoiceNumber: parsed.invoice_number,
    ticketNumber: parsed.ticket_number,
  };
  const hints: JobHint[] = parsed.job_hints.map((hint) => ({
    text: hint.text,
    pageIndex: hint.page_index,
  }));
  for (const line of parsed.lines)
    if (line.job_hint)
      hints.push({
        text: line.job_hint,
        sourceIndex: line.source_index,
        pageIndex: line.page_index,
      });
  const gps =
    typeof current.gps_lat === "number" &&
    typeof current.gps_lng === "number" &&
    typeof current.gps_accuracy_meters === "number"
      ? { lat: current.gps_lat, lng: current.gps_lng, accuracyMeters: current.gps_accuracy_meters }
      : null;
  const context = {
    hints,
    purchaseDate: parsed.purchase_date,
    uploaderId: textValue(current.owner_user_id),
    uploaderJobIds: strings(current.uploader_job_ids),
    vendor: parsed.vendor,
    gps,
  };
  const receiptRanking = rankJobCandidates(context, catalog, config.jobs);
  const jobCandidates = [
    ...receiptRanking.candidates,
    ...parsed.lines.flatMap((line) =>
      line.job_hint
        ? rankJobCandidates({ ...context, sourceIndex: line.source_index }, catalog, config.jobs)
            .candidates
        : [],
    ),
  ].map(({ housecallJobId, ...candidate }) => ({ ...candidate, jobId: housecallJobId }));
  return {
    categorySuggestion: suggestReceiptCategory(
      [parsed.vendor, ...parsed.lines.map((line) => line.description)].filter(Boolean).join(" "),
      (categoryResult.data ?? []).map(categoryRow),
    ),
    jobCandidates,
    duplicateCandidates: scoreDuplicateReceipts(
      receipt,
      rows.filter((row) => row.id !== receiptId).map(duplicateRow),
      config.duplicate,
    ),
  };
}
