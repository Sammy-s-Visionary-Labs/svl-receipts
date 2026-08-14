/**
 * Retention policy v1.
 * Clock starts at the submission confirmation event (`submitted_at`), not upload-session created_at.
 */

export const RETENTION_POLICY_VERSION = 1 as const;

export const RETENTION_DAYS = 365;

/** Named start event for policy v1. Still-open (never submitted) receipts are not eligible. */
export const RETENTION_START_EVENT = "submitted" as const;

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

export function computeDeleteAfterAt(retentionStartsAt: Date): Date {
  return addUtcDays(retentionStartsAt, RETENTION_DAYS);
}

export type RetentionEligibilityInput = {
  retentionStartsAt: Date | null;
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
  if (!input.retentionStartsAt || !input.deleteAfterAt) {
    return false;
  }
  return input.deleteAfterAt.getTime() <= input.now.getTime();
}
