/** Manager actions from the PRD review flow. */
export const REVIEW_DECISIONS = [
  "save_draft",
  "request_clarification",
  "decline",
  "mark_duplicate",
  "approve",
] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export function isReviewDecision(value: string): value is ReviewDecision {
  return (REVIEW_DECISIONS as readonly string[]).includes(value);
}

/** Shared identity fields on every review command. */
export type ReviewCommandBase = {
  receipt_id: string;
  actor_id: string;
};

/** Light edit surface — thicken when manager API stories land. */
export type ReviewEdits = {
  vendor?: string;
  purchase_date?: string;
  invoice_number?: string;
  ticket_number?: string;
  manager_notes?: string;
  lines?: Array<{
    description: string;
    qty: number;
    uom?: string;
    unit_cost_cents: number;
    /** Immutable Housecall job id when assigned; never display text alone. */
    job_id?: string;
  }>;
};

export type SaveDraftCommand = ReviewCommandBase & {
  decision: "save_draft";
  edits: ReviewEdits;
};

export type RequestClarificationCommand = ReviewCommandBase & {
  decision: "request_clarification";
  reason: string;
  edits?: ReviewEdits;
};

export type DeclineCommand = ReviewCommandBase & {
  decision: "decline";
  reason: string;
};

export type MarkDuplicateCommand = ReviewCommandBase & {
  decision: "mark_duplicate";
  canonical_receipt_id: string;
  reason?: string;
};

export type ApproveLineAssignment = {
  description: string;
  qty: number;
  uom?: string;
  unit_cost_cents: number;
  /** Required for approve — destination Housecall job id. */
  job_id: string;
};

export type ApproveCommand = ReviewCommandBase & {
  decision: "approve";
  edits?: ReviewEdits;
  lines: ApproveLineAssignment[];
};

export type ReviewCommand =
  | SaveDraftCommand
  | RequestClarificationCommand
  | DeclineCommand
  | MarkDuplicateCommand
  | ApproveCommand;
