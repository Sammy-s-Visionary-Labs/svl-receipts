import type { HousecallStepKind, HousecallStepStatus } from "./housecall";
import { isHousecallStepKind, isHousecallStepStatus } from "./housecall";
import { resolveReceiptStatus } from "./legacy-status";
import type { ReceiptStatus } from "./receipt-status";
import { isReceiptStatus } from "./receipt-status";

/**
 * Allowed receipt status edges.
 * `partial_success` is terminal for idle queue purposes, but an explicit retry
 * may move it back to exporting (and then exported / failed).
 * Legacy aliases are not stored and are not valid targets.
 */
export const RECEIPT_TRANSITIONS = {
  upload_pending: ["submitted", "failed"],
  submitted: ["processing", "failed"],
  processing: ["needs_review", "rejected_unreadable", "duplicate", "failed"],
  needs_review: ["approved", "rejected", "duplicate", "rejected_unreadable", "failed"],
  approved: ["exporting", "failed"],
  exporting: ["exported", "partial_success", "failed"],
  exported: [],
  partial_success: ["exporting", "exported", "failed"],
  rejected_unreadable: [],
  rejected: [],
  duplicate: [],
  failed: [],
} as const satisfies Record<ReceiptStatus, readonly ReceiptStatus[]>;

/** Next statuses allowed after the latest attempt for the same step target. */
export const HOUSECALL_STEP_TRANSITIONS = {
  pending: ["in_progress", "succeeded", "skipped", "retryable_failure", "permanent_failure"],
  in_progress: ["succeeded", "retryable_failure", "permanent_failure", "skipped"],
  retryable_failure: [
    "pending",
    "in_progress",
    "succeeded",
    "retryable_failure",
    "permanent_failure",
    "skipped",
  ],
  succeeded: [],
  permanent_failure: [],
  skipped: [],
} as const satisfies Record<HousecallStepStatus, readonly HousecallStepStatus[]>;

export const TRANSITION_GUARD_CODES = {
  illegal_transition: "illegal_transition",
  missing_actor: "missing_actor",
  missing_timestamp: "missing_timestamp",
  invalid_status: "invalid_status",
  step_already_succeeded: "step_already_succeeded",
} as const;

export type TransitionGuardCode =
  (typeof TRANSITION_GUARD_CODES)[keyof typeof TRANSITION_GUARD_CODES];

export type TransitionGuardFailure = {
  ok: false;
  code: TransitionGuardCode;
};

export type ReceiptTransitionInput = {
  from: string;
  to: string;
  actorId: string;
  occurredAt: Date;
};

export type ReceiptTransitionSuccess = {
  ok: true;
  from: ReceiptStatus;
  to: ReceiptStatus;
};

export type ReceiptTransitionResult = ReceiptTransitionSuccess | TransitionGuardFailure;

export type HousecallStepAttempt = {
  step: HousecallStepKind;
  housecallJobId: string;
  receiptLineId: string | null;
  status: HousecallStepStatus;
};

export type HousecallStepAttemptInput = {
  existing: readonly HousecallStepAttempt[];
  step: HousecallStepKind;
  housecallJobId: string;
  receiptLineId: string | null;
  nextStatus: string;
  actorId: string;
  occurredAt: Date;
};

function requireActorAndTime(actorId: string, occurredAt: Date): TransitionGuardFailure | null {
  if (typeof actorId !== "string" || actorId.trim() === "") {
    return { ok: false, code: TRANSITION_GUARD_CODES.missing_actor };
  }
  if (!(occurredAt instanceof Date) || !Number.isFinite(occurredAt.getTime())) {
    return { ok: false, code: TRANSITION_GUARD_CODES.missing_timestamp };
  }
  return null;
}

export function isReceiptTransitionAllowed(from: ReceiptStatus, to: ReceiptStatus): boolean {
  const allowed: readonly ReceiptStatus[] = RECEIPT_TRANSITIONS[from];
  return allowed.includes(to);
}

/**
 * Compatibility boundary: `from` may be a legacy alias; `to` must be canonical.
 * Actor id and timestamp are required on every change.
 */
export function evaluateReceiptTransition(input: ReceiptTransitionInput): ReceiptTransitionResult {
  const required = requireActorAndTime(input.actorId, input.occurredAt);
  if (required) {
    return required;
  }

  const from = resolveReceiptStatus(input.from);
  if (!from || !isReceiptStatus(input.to)) {
    return { ok: false, code: TRANSITION_GUARD_CODES.invalid_status };
  }

  if (!isReceiptTransitionAllowed(from, input.to)) {
    return { ok: false, code: TRANSITION_GUARD_CODES.illegal_transition };
  }

  return { ok: true, from, to: input.to };
}

function sameStepTarget(
  attempt: HousecallStepAttempt,
  step: HousecallStepKind,
  housecallJobId: string,
  receiptLineId: string | null,
): boolean {
  return (
    attempt.step === step &&
    attempt.housecallJobId === housecallJobId &&
    attempt.receiptLineId === receiptLineId
  );
}

export function housecallStepHasSucceeded(
  existing: readonly HousecallStepAttempt[],
  step: HousecallStepKind,
  housecallJobId: string,
  receiptLineId: string | null,
): boolean {
  return existing.some(
    (attempt) =>
      sameStepTarget(attempt, step, housecallJobId, receiptLineId) &&
      attempt.status === "succeeded",
  );
}

/**
 * Whether a new append-only export_attempts row may be recorded.
 * A succeeded step for the same receipt/job/line must never be repeated.
 */
export function evaluateHousecallStepAttempt(
  input: HousecallStepAttemptInput,
): { ok: true } | TransitionGuardFailure {
  const required = requireActorAndTime(input.actorId, input.occurredAt);
  if (required) {
    return required;
  }

  if (!isHousecallStepKind(input.step) || !isHousecallStepStatus(input.nextStatus)) {
    return { ok: false, code: TRANSITION_GUARD_CODES.invalid_status };
  }

  if (
    housecallStepHasSucceeded(input.existing, input.step, input.housecallJobId, input.receiptLineId)
  ) {
    return { ok: false, code: TRANSITION_GUARD_CODES.step_already_succeeded };
  }

  const matching = input.existing.filter((attempt) =>
    sameStepTarget(attempt, input.step, input.housecallJobId, input.receiptLineId),
  );
  const previous = matching[matching.length - 1];
  if (!previous) {
    return { ok: true };
  }

  const allowed: readonly HousecallStepStatus[] = HOUSECALL_STEP_TRANSITIONS[previous.status];
  if (!allowed.includes(input.nextStatus)) {
    return { ok: false, code: TRANSITION_GUARD_CODES.illegal_transition };
  }

  return { ok: true };
}
