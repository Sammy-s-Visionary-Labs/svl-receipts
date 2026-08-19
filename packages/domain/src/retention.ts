/**
 * Retention policy v1 (RA-66).
 * Clock starts once, when the current Housecall intent is fully exported,
 * or the receipt is declined (`rejected`, `rejected_unreadable`, `duplicate`).
 */

export const RETENTION_POLICY_VERSION = 1 as const;

export const RETENTION_DAYS = 365;

/** Canonical start event. Upload confirmation does not start the clock. */
export const RETENTION_START_EVENT = "housecall_export_succeeded_or_declined" as const;

/**
 * Supabase Free/Hobby does not offer PITR. Daily backups, if enabled, can retain
 * deleted objects until that backup expires. Documented in docs/environments.md.
 */
export const BACKUP_EXPIRATION_NOTE =
  "Supabase Free has no PITR; deleted receipt content can remain in backups until those backups expire.";

export function addUtcDays(start: Date, days: number): Date {
  const next = new Date(start.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export function computeDeleteAfterAt(retentionStartedAt: Date): Date {
  return addUtcDays(retentionStartedAt, RETENTION_DAYS);
}

export type RetentionStartInput = {
  status: string;
  /** True only when every target on the current Housecall intent has succeeded. */
  exportComplete: boolean;
  retentionStartedAt: Date | null;
};

export function shouldStartRetention(input: RetentionStartInput): boolean {
  if (input.retentionStartedAt) {
    return false;
  }
  if (
    input.status === "rejected" ||
    input.status === "rejected_unreadable" ||
    input.status === "duplicate"
  ) {
    return true;
  }
  return input.exportComplete;
}

export type RetentionEligibilityInput = {
  retentionStartedAt: Date | null;
  deleteAfterAt: Date | null;
  retentionHold: boolean;
  contentDeletedAt: Date | null;
  now: Date;
};

export function isEligibleForContentDeletion(input: RetentionEligibilityInput): boolean {
  if (input.contentDeletedAt) {
    return false;
  }
  if (input.retentionHold) {
    return false;
  }
  if (!input.retentionStartedAt || !input.deleteAfterAt) {
    return false;
  }
  return input.deleteAfterAt.getTime() <= input.now.getTime();
}
