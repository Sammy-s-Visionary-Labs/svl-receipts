import type { ReceiptStatus } from "@svl/domain";

export const QUEUE_TABS = [
  "needs-review",
  "history",
  "processing",
  "partial-success",
  "failed",
  "completed",
  "rejected-duplicate",
] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];
export const QUEUE_SORTS = ["oldest", "newest"] as const;
export const QUEUE_AGES = ["all", "over-24h", "over-7d", "over-30d"] as const;
export const QUEUE_CONFIDENCES = ["all", "low", "high", "unknown"] as const;
export const QUEUE_DUPLICATES = ["all", "marked", "unmarked"] as const;
export const HOUSECALL_STATUSES = [
  "not_started",
  "pending",
  "in_progress",
  "partial_success",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type HousecallStatus = (typeof HOUSECALL_STATUSES)[number];

/** Query parameters have these names; cursor is a separate opaque parameter. */
export type QueueFilters = {
  tab: QueueTab;
  sort: (typeof QUEUE_SORTS)[number];
  status: ReceiptStatus | "all";
  age: (typeof QUEUE_AGES)[number];
  submitter: string;
  vendor: string;
  confidence: (typeof QUEUE_CONFIDENCES)[number];
  duplicate: (typeof QUEUE_DUPLICATES)[number];
  housecall: HousecallStatus | "all";
  search: string;
  /** Inclusive UTC calendar dates, empty for no boundary. */
  from: string;
  to: string;
  limit: number;
};
export const DEFAULT_QUEUE_FILTERS: QueueFilters = {
  tab: "needs-review",
  sort: "oldest",
  status: "all",
  age: "all",
  submitter: "",
  vendor: "",
  confidence: "all",
  duplicate: "all",
  housecall: "all",
  search: "",
  from: "",
  to: "",
  limit: 25,
};
export type QueueReceipt = {
  id: string;
  status: ReceiptStatus;
  submittedAt: string;
  submitter: { id: string; label: string };
  vendor: string | null;
  reference: string | null;
  referenceTotalCents: number | null;
  pageCount: number;
  thumbnailUrl: string | null;
  /** Latest stored suggestion; no ranking or confidence is available yet. */
  assignedJobs?: Array<{ id: string; label: string | null }>;
  suggestedJob: { id: string; label: string | null; source: string | null } | null;
  /** Minimum valid per-field extraction confidence; not a job-match score. */
  confidence: number | null;
  duplicate: "marked" | "unmarked";
  warnings: string[];
  housecallStatus: HousecallStatus;
  extractionId: string | null;
  latestReviewDecision: string | null;
};
export type QueueResponse = {
  receipts: QueueReceipt[];
  nextCursor: string | null;
  filters: QueueFilters;
  asOf: string;
};
