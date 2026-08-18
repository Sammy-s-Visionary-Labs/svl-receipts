/**
 * Storage error codes that mean the receipt object is gone.
 * Do not treat HTTP 404 or NoSuchBucket as verified absence.
 *
 * @see https://supabase.com/docs/guides/storage/debugging/error-codes
 */

export function storageErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const candidate = error as { code?: unknown; error?: unknown };
  if (typeof candidate.code === "string" && candidate.code.length > 0) {
    return candidate.code;
  }
  if (typeof candidate.error === "string" && candidate.error.length > 0) {
    return candidate.error;
  }
  return null;
}

export function storageErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }
  const candidate = error as { message?: unknown };
  return typeof candidate.message === "string" ? candidate.message : "";
}

/** True only when the object key is missing, not when the bucket or service is missing. */
export function isReceiptStorageObjectAbsent(error: unknown): boolean {
  const code = (storageErrorCode(error) ?? "").toLowerCase();
  if (code === "nosuchkey") {
    return true;
  }
  if (code === "nosuchbucket" || code === "tenantnotfound") {
    return false;
  }
  if (code === "objectnotfound") {
    return true;
  }
  if (code === "not_found") {
    return /object not found/i.test(storageErrorMessage(error));
  }
  return false;
}
