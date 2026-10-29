export const UNRESOLVED_EMAIL_IMPORT_STATUSES = [
  "awaiting_upload",
  "queued",
  "processing",
  "needs_attention",
] as const;

export function isUnresolvedEmailImportStatus(status: string) {
  return UNRESOLVED_EMAIL_IMPORT_STATUSES.some((candidate) => candidate === status);
}
