/** Independent Housecall export steps — never bundle as one opaque "sync". */
export const HOUSECALL_STEP_KINDS = ["attachment", "job_cost"] as const;

export type HousecallStepKind = (typeof HOUSECALL_STEP_KINDS)[number];

export const HOUSECALL_STEP_STATUSES = [
  "pending",
  "in_progress",
  "succeeded",
  "retryable_failure",
  "permanent_failure",
  "skipped",
] as const;

export type HousecallStepStatus = (typeof HOUSECALL_STEP_STATUSES)[number];

/** Current approve → export intent payload version. */
export const HOUSECALL_PAYLOAD_VERSION = 1 as const;

export type HousecallPayloadVersion = typeof HOUSECALL_PAYLOAD_VERSION;

/**
 * Light intent shape recorded on approve.
 * HTTP request/response details belong in @svl/integrations later.
 */
export type HousecallIntentV1 = {
  payload_version: HousecallPayloadVersion;
  receipt_id: string;
  /** Distinct Housecall jobs that need an attachment (usually one per destination job). */
  attachment_job_ids: string[];
  /** One job-cost write target per approved line. */
  job_cost_lines: Array<{
    job_id: string;
    description: string;
    qty: number;
    unit_cost_cents: number;
    receipt_line_id?: string;
  }>;
};

export type HousecallStepStateV1 = {
  payload_version: HousecallPayloadVersion;
  step: HousecallStepKind;
  status: HousecallStepStatus;
};

export function isHousecallStepKind(value: string): value is HousecallStepKind {
  return (HOUSECALL_STEP_KINDS as readonly string[]).includes(value);
}

export function isHousecallStepStatus(value: string): value is HousecallStepStatus {
  return (HOUSECALL_STEP_STATUSES as readonly string[]).includes(value);
}

export function isHousecallIntentV1(value: unknown): value is HousecallIntentV1 {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<HousecallIntentV1>;
  return (
    candidate.payload_version === HOUSECALL_PAYLOAD_VERSION &&
    typeof candidate.receipt_id === "string" &&
    Array.isArray(candidate.attachment_job_ids) &&
    Array.isArray(candidate.job_cost_lines)
  );
}

export function parseHousecallIntentV1(value: unknown): HousecallIntentV1 | null {
  return isHousecallIntentV1(value) ? value : null;
}

export type IntentExportAttempt = {
  intentId: string | null;
  step: string;
  housecallJobId: string;
  receiptLineId: string | null;
};

/** True when every attachment job and every job-cost line on this intent has a succeeded attempt. */
export function isCurrentIntentExportComplete(input: {
  intentId: string;
  attachmentJobIds: string[];
  jobCostLines: Array<{ job_id: string; receipt_line_id?: string | null }>;
  succeededAttempts: IntentExportAttempt[];
}): boolean {
  if (input.attachmentJobIds.length < 1 || input.jobCostLines.length < 1) {
    return false;
  }

  for (const jobId of input.attachmentJobIds) {
    if (
      !input.succeededAttempts.some(
        (attempt) =>
          attempt.intentId === input.intentId &&
          attempt.step === "attachment" &&
          attempt.housecallJobId === jobId,
      )
    ) {
      return false;
    }
  }

  for (const line of input.jobCostLines) {
    if (!line.receipt_line_id) {
      return false;
    }
    if (
      !input.succeededAttempts.some(
        (attempt) =>
          attempt.intentId === input.intentId &&
          attempt.step === "job_cost" &&
          attempt.housecallJobId === line.job_id &&
          attempt.receiptLineId === line.receipt_line_id,
      )
    ) {
      return false;
    }
  }

  return true;
}
