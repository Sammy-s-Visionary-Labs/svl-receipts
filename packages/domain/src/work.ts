/** Durable DB work-queue vocabulary. Keep in sync with work_items SQL. */

export const WORK_KINDS = ["extract", "export", "purge"] as const;

export type WorkKind = (typeof WORK_KINDS)[number];

export const WORK_STATUSES = ["queued", "leased", "succeeded", "dead_letter"] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];

/** Keep in sync with claim_work / fail_work in SQL. */
export const WORK_MAX_ATTEMPTS = 8;

export const WORK_LEASE_SECONDS = 5 * 60;

/** Kinds the current runner may claim and complete. Extract/export stay queued until providers exist. */
export const WORK_HANDLED_KINDS = ["purge"] as const satisfies readonly WorkKind[];

export function isHandledWorkKind(value: string): value is (typeof WORK_HANDLED_KINDS)[number] {
  return (WORK_HANDLED_KINDS as readonly string[]).includes(value);
}

export const WORK_RETRY_CAP_MINUTES = 24 * 60;

export function isWorkKind(value: string): value is WorkKind {
  return (WORK_KINDS as readonly string[]).includes(value);
}

export function isWorkStatus(value: string): value is WorkStatus {
  return (WORK_STATUSES as readonly string[]).includes(value);
}

export type WorkClaimSnapshot = {
  status: WorkStatus;
  nextAttemptAt: Date;
  leaseExpiresAt: Date | null;
};

export function isWorkClaimable(item: WorkClaimSnapshot, now: Date): boolean {
  if (item.status === "succeeded" || item.status === "dead_letter") {
    return false;
  }
  if (item.nextAttemptAt.getTime() > now.getTime()) {
    return false;
  }
  if (item.status === "queued") {
    return true;
  }
  return item.leaseExpiresAt === null || item.leaseExpiresAt.getTime() <= now.getTime();
}

export function retryDelayMinutes(attemptCount: number): number {
  const safeAttempt = Math.max(attemptCount, 1);
  return Math.min(2 ** (safeAttempt - 1), WORK_RETRY_CAP_MINUTES);
}

export function nextAttemptAt(attemptCount: number, now: Date): Date {
  return new Date(now.getTime() + retryDelayMinutes(attemptCount) * 60 * 1000);
}

export type RetryDecision =
  | { status: "queued"; nextAttemptAt: Date; terminalReason: null }
  | { status: "dead_letter"; nextAttemptAt: Date; terminalReason: string };

export function scheduleWorkFailure(input: {
  attemptCount: number;
  retryable: boolean;
  reason: string;
  now: Date;
}): RetryDecision {
  if (!input.retryable || input.attemptCount >= WORK_MAX_ATTEMPTS) {
    return {
      status: "dead_letter",
      nextAttemptAt: input.now,
      terminalReason: input.reason,
    };
  }
  return {
    status: "queued",
    nextAttemptAt: nextAttemptAt(input.attemptCount, input.now),
    terminalReason: null,
  };
}
