import { createHash } from "node:crypto";
import { isReceiptStatus } from "@svl/domain";
import {
  DEFAULT_QUEUE_FILTERS,
  HOUSECALL_STATUSES,
  QUEUE_AGES,
  QUEUE_CONFIDENCES,
  QUEUE_DUPLICATES,
  QUEUE_SORTS,
  QUEUE_TABS,
  type QueueFilters,
  type QueueReceipt,
} from "./queue-contract";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/;
export class InvalidQueueRequest extends Error {}
type QueueCursor = { v: 1; id: string; submittedAt: string; asOf: string; filter: string };

function invalid(): never {
  throw new InvalidQueueRequest("Queue filters or cursor are invalid");
}
function choice<T extends string>(value: string, options: readonly T[]): T {
  return options.includes(value as T) ? (value as T) : invalid();
}
function date(value: string): string {
  if (!value) return value;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000-") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    invalid();
  return value;
}
function isStamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    STAMP.test(value) &&
    !value.startsWith("0000-") &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 19) === value.slice(0, 19)
  );
}
function fingerprint(filters: QueueFilters) {
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}
export function parseQueueRequest(url: URL, now = new Date()) {
  const p = url.searchParams;
  const allowed = [...Object.keys(DEFAULT_QUEUE_FILTERS), "cursor"];
  for (const key of p.keys()) if (!allowed.includes(key) || p.getAll(key).length > 1) invalid();
  const get = (key: keyof QueueFilters) => p.get(key) ?? String(DEFAULT_QUEUE_FILTERS[key]);
  const status = get("status");
  if (status !== "all" && (!isReceiptStatus(status) || status === "upload_pending")) invalid();
  const submitter = get("submitter").trim().toLowerCase();
  if (submitter && !UUID.test(submitter)) invalid();
  const vendor = get("vendor").trim();
  const search = get("search").trim();
  if (
    vendor.length > 120 ||
    search.length > 120 ||
    [...(vendor + search)].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    invalid();
  if (!/^\d{1,2}$/.test(get("limit"))) invalid();
  const limit = Number(get("limit"));
  if (limit < 1 || limit > 50) invalid();
  const from = date(get("from"));
  const to = date(get("to"));
  if (from && to && from > to) invalid();
  const filters: QueueFilters = {
    tab: choice(get("tab"), QUEUE_TABS),
    sort: choice(get("sort"), QUEUE_SORTS),
    status: status as QueueFilters["status"],
    age: choice(get("age"), QUEUE_AGES),
    submitter,
    vendor,
    confidence: choice(get("confidence"), QUEUE_CONFIDENCES),
    duplicate: choice(get("duplicate"), QUEUE_DUPLICATES),
    housecall: choice(get("housecall"), ["all", ...HOUSECALL_STATUSES]),
    search,
    from,
    to,
    limit,
  };
  let cursor: QueueCursor | null = null;
  const encoded = p.get("cursor");
  if (encoded !== null) {
    if (!encoded || encoded.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(encoded)) invalid();
    try {
      cursor = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      invalid();
    }
    if (
      cursor?.v !== 1 ||
      typeof cursor.id !== "string" ||
      !UUID.test(cursor.id) ||
      !isStamp(cursor.submittedAt) ||
      !isStamp(cursor.asOf) ||
      cursor.filter !== fingerprint(filters)
    )
      invalid();
  }
  const asOf = cursor?.asOf ?? now.toISOString();
  return { filters, cursor, asOf };
}
export function encodeQueueCursor(row: QueueReceipt, filters: QueueFilters, asOf: string): string {
  // Preserve PostgreSQL microseconds verbatim. Date.toISOString would lose rows at a boundary.
  return Buffer.from(
    JSON.stringify({
      v: 1,
      id: row.id,
      submittedAt: row.submittedAt,
      asOf,
      filter: fingerprint(filters),
    }),
  ).toString("base64url");
}
export function queueRpcParameters(parsed: ReturnType<typeof parseQueueRequest>) {
  const { filters: f, cursor, asOf } = parsed;
  return {
    p_tab: f.tab,
    p_sort: f.sort,
    p_status: f.status,
    p_age: f.age,
    p_submitter: f.submitter || null,
    p_vendor: f.vendor,
    p_confidence: f.confidence,
    p_duplicate: f.duplicate,
    p_housecall: f.housecall,
    p_search: f.search,
    p_from: f.from || null,
    p_to: f.to || null,
    p_limit: f.limit + 1,
    p_as_of: asOf,
    p_cursor_at: cursor?.submittedAt ?? null,
    p_cursor_id: cursor?.id ?? null,
  };
}
const nullableText = (value: unknown) => (typeof value === "string" ? value : null);
export function normalizeQueueRow(value: Record<string, unknown>): QueueReceipt {
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !isStamp(value.submittedAt) ||
    typeof value.status !== "string" ||
    !isReceiptStatus(value.status) ||
    typeof value.submitterId !== "string" ||
    !UUID.test(value.submitterId) ||
    typeof value.housecallStatus !== "string" ||
    !HOUSECALL_STATUSES.includes(value.housecallStatus as never)
  )
    throw new Error("Invalid manager queue response");
  const job = value.suggestedJob as Record<string, unknown> | null;
  return {
    id: value.id,
    status: value.status,
    submittedAt: value.submittedAt,
    submitter: { id: value.submitterId, label: `Worker ${value.submitterId.slice(0, 8)}` },
    vendor: nullableText(value.vendor),
    reference: nullableText(value.reference),
    referenceTotalCents:
      typeof value.referenceTotalCents === "number" &&
      Number.isSafeInteger(value.referenceTotalCents) &&
      value.referenceTotalCents >= 0
        ? value.referenceTotalCents
        : null,
    pageCount:
      typeof value.pageCount === "number" &&
      Number.isInteger(value.pageCount) &&
      value.pageCount >= 0 &&
      value.pageCount <= 5
        ? value.pageCount
        : 0,
    thumbnailUrl:
      value.hasThumbnail === true ? `/api/manager/receipts/${value.id}/thumbnail` : null,
    suggestedJob:
      job && typeof job.id === "string"
        ? { id: job.id, label: nullableText(job.label), source: nullableText(job.source) }
        : null,
    confidence:
      typeof value.confidence === "number" && value.confidence >= 0 && value.confidence <= 1
        ? value.confidence
        : null,
    duplicate: value.duplicate === "marked" ? "marked" : "unmarked",
    warnings: Array.isArray(value.warnings)
      ? value.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
    housecallStatus: value.housecallStatus as QueueReceipt["housecallStatus"],
    extractionId: nullableText(value.extractionId),
    latestReviewDecision: nullableText(value.latestReviewDecision),
  };
}
