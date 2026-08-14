/** Append-only audit vocabulary. Payloads must never include secrets, images, or OCR text. */

export const AUDIT_ACTIONS = [
  "receipt_created",
  "receipt_status_changed",
  "review_recorded",
  "receipt_approved",
  "outbox_enqueued",
  "work_completed",
  "work_retried",
  "work_dead_lettered",
  "external_attempt",
  "retention_hold_set",
  "retention_hold_cleared",
  "content_purged",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTOR_TYPES = ["user", "system", "worker"] as const;

export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

const REDACT_KEYS = new Set([
  "raw_text",
  "ocr",
  "image",
  "bytes",
  "token",
  "authorization",
  "api_key",
  "secret",
  "password",
  "access_token",
  "refresh_token",
]);

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditPayload);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = REDACT_KEYS.has(key.toLowerCase()) ? "[redacted]" : redactAuditPayload(nested);
    }
    return out;
  }
  return value;
}
