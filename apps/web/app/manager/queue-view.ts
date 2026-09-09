import { RECEIPT_STATUSES } from "@svl/domain";
import {
  DEFAULT_QUEUE_FILTERS,
  HOUSECALL_STATUSES,
  QUEUE_AGES,
  QUEUE_CONFIDENCES,
  QUEUE_DUPLICATES,
  QUEUE_SORTS,
  QUEUE_TABS,
  type QueueFilters,
  type QueueTab,
} from "@/lib/manager/queue-contract";

export const TAB_LABELS: Record<QueueTab, string> = {
  history: "All history",
  "needs-review": "Needs review",
  processing: "Processing",
  "partial-success": "Partial success",
  failed: "Failed",
  completed: "Completed",
  "rejected-duplicate": "Rejected / Duplicate",
};
export const TAB_DESCRIPTIONS: Record<QueueTab, string> = {
  history: "Approved, declined, duplicate, failed, partial, and exported receipts.",
  "needs-review": "Start with the oldest receipts awaiting a manager’s attention.",
  processing: "Receipts moving through upload, extraction, or export.",
  "partial-success": "Receipts with an incomplete Housecall export.",
  failed: "Receipts that need attention after a processing or readability failure.",
  completed: "Receipts whose Housecall export is complete.",
  "rejected-duplicate": "Receipts marked as rejected or duplicate.",
};
export const STATUS_LABELS: Record<string, string> = {
  upload_pending: "Upload pending",
  submitted: "Submitted",
  processing: "Processing",
  needs_review: "Needs review",
  approved: "Approved",
  exporting: "Exporting",
  exported: "Exported",
  partial_success: "Partial success",
  rejected_unreadable: "Unreadable",
  rejected: "Rejected",
  duplicate: "Duplicate",
  failed: "Failed",
  not_started: "Not started",
  pending: "Pending",
  in_progress: "In progress",
  succeeded: "Complete",
  cancelled: "Cancelled",
};

function choice<T extends string>(value: string | null, values: readonly T[], fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** Read only supported, bounded queue state from browser navigation. The API validates it again. */
export function filtersFromSearch(params: Pick<URLSearchParams, "get">): QueueFilters {
  const defaults = DEFAULT_QUEUE_FILTERS;
  return {
    tab: choice(params.get("tab"), QUEUE_TABS, defaults.tab),
    sort: choice(params.get("sort"), QUEUE_SORTS, defaults.sort),
    status: choice(
      params.get("status"),
      ["all", ...RECEIPT_STATUSES.filter((status) => status !== "upload_pending")],
      defaults.status,
    ),
    age: choice(params.get("age"), QUEUE_AGES, defaults.age),
    submitter: (params.get("submitter") ?? "").slice(0, 36),
    vendor: (params.get("vendor") ?? "").slice(0, 120),
    confidence: choice(params.get("confidence"), QUEUE_CONFIDENCES, defaults.confidence),
    duplicate: choice(params.get("duplicate"), QUEUE_DUPLICATES, defaults.duplicate),
    housecall: choice(params.get("housecall"), ["all", ...HOUSECALL_STATUSES], defaults.housecall),
    search: (params.get("search") ?? "").slice(0, 120),
    from: (params.get("from") ?? "").slice(0, 10),
    to: (params.get("to") ?? "").slice(0, 10),
    limit:
      /^\d{1,2}$/.test(params.get("limit") ?? "") &&
      Number(params.get("limit")) >= 1 &&
      Number(params.get("limit")) <= 50
        ? Number(params.get("limit"))
        : defaults.limit,
  };
}

export function queueSearch(filters: QueueFilters, cursor: string | null = null): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== DEFAULT_QUEUE_FILTERS[key as keyof QueueFilters]) params.set(key, String(value));
  }
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

export function activeFilterCount(filters: QueueFilters): number {
  const keys = [
    "status",
    "age",
    "submitter",
    "vendor",
    "confidence",
    "duplicate",
    "housecall",
    "from",
    "to",
  ] as const;
  return keys.filter((key) => filters[key] !== DEFAULT_QUEUE_FILTERS[key]).length;
}

export function money(cents: number | null): string {
  return cents === null || !Number.isFinite(cents)
    ? "Total unavailable"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

export function receiptAge(submittedAt: string, asOf: number): string {
  const timestamp = new Date(submittedAt).getTime();
  if (!Number.isFinite(timestamp)) return "Age unavailable";
  const minutes = Math.max(0, Math.floor((asOf - timestamp) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

export function confidenceLabel(confidence: number | null): string {
  if (confidence === null || !Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return "Unavailable";
  return confidence < 0.8 ? "Low confidence" : "High confidence";
}

export function warningLabel(warning: string): string {
  const labels: Record<string, string> = {
    duplicate: "Marked as duplicate",
    duplicate_marked: "Marked as duplicate",
    low_confidence: "Low extraction confidence",
    missing_extraction: "Extraction unavailable",
    extraction_unavailable: "Extraction unavailable",
    missing_job_suggestion: "Job suggestion unavailable",
    job_suggestion_unavailable: "Job suggestion unavailable",
    partial_success: "Housecall export incomplete",
    export_failed: "Housecall export failed",
    unreadable: "Receipt was not readable",
    rejected_unreadable: "Receipt was not readable",
  };
  return (
    labels[warning] ?? warning.replaceAll("_", " ").replace(/^./, (char) => char.toUpperCase())
  );
}
