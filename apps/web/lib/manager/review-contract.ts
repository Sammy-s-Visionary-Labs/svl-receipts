import type {
  CategorySuggestion,
  IntelligenceReason,
  ReceiptCategory,
  ReceiptWarning,
  ReviewDraft,
  ReviewLine,
} from "@svl/domain";
export type ManagerJob = {
  id: string;
  label: string;
  customer: string | null;
  number: string | null;
  status: string | null;
  scheduledAt: string | null;
  technicians: string[];
  source: string | null;
  syncedAt?: string | null;
  stale?: boolean;
  unavailable?: boolean;
  suggestionId?: string;
  active: boolean;
  score?: number;
  reasons?: IntelligenceReason[];
  sourceIndex?: number;
  scoringVersion?: string;
};
export type ReviewEvent = {
  id: string;
  action: string;
  actor: string;
  createdAt: string;
  version: number | null;
  reason: string | null;
  changes: Record<string, { before: unknown; after: unknown }>;
  externalId?: string | null;
};
export type ExportStep = {
  id: string;
  intentId: string;
  jobId: string;
  lineId: string | null;
  exportStepId?: string;
  pageId?: string | null;
  pageIndex?: number;
  step: string;
  status: string;
  externalId: string | null;
  error: string | null;
  createdAt: string | null;
  retryQueued: boolean;
};
export type ReceiptDetail = {
  automaticJobAssignments?: import("./job-autofill").AutomaticJobAssignment[];
  id: string;
  status: string;
  submittedAt: string;
  version: number;
  extractionId: string | null;
  draft: ReviewDraft;
  original: ReviewDraft;
  lineEvidence?: Record<string, ReviewLine>;
  reprocessed?: boolean;
  confidence: Record<string, number>;
  gps: { lat: number; lng: number } | null;
  pageCount: number;
  automaticExport?: boolean;
  editable: boolean;
  steps: ExportStep[];
  events: ReviewEvent[];
  nextEventCursor: string | null;
  suggestions: ManagerJob[];
  assignedJobs?: ManagerJob[];
  correctionPending: boolean;
  clarification: string | null;
  canonicalReceiptId: string | null;
  categories?: ReceiptCategory[];
  categorySuggestion?: CategorySuggestion | null;
  warnings?: ReceiptWarning[];
  duplicates?: Array<{
    id: string;
    receiptId: string;
    score: number;
    reasons: IntelligenceReason[];
    status: string;
  }>;
};
