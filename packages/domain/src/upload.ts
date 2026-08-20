/**
 * Upload constraints for receipt images.
 * HTTP session shapes live in @svl/web — this file is the shared vocabulary.
 */

export const RECEIPT_BUCKET = "receipts" as const;

/** Matches the private `receipts` bucket file_size_limit. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** Pilot cap for multi-page capture (RA-69 / RA-21). Single-page remains the common path. */
export const MAX_RECEIPT_PAGES = 5;

export const ALLOWED_RECEIPT_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type ReceiptContentType = (typeof ALLOWED_RECEIPT_CONTENT_TYPES)[number];

/** Signed upload URLs from Supabase Storage last two hours. */
export const UPLOAD_SESSION_TTL_SECONDS = 2 * 60 * 60;

/** Short-lived private reads — not a public URL. */
export const SIGNED_READ_TTL_SECONDS = 60;

/** Incomplete upload_pending rows older than this may be deleted. Confirmed receipts are never deleted. */
export const ABANDONED_UPLOAD_MAX_AGE_HOURS = 24;

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function isReceiptContentType(value: string): value is ReceiptContentType {
  return (ALLOWED_RECEIPT_CONTENT_TYPES as readonly string[]).includes(value);
}

export function declaredContentTypeMatches(
  contentType: string | null,
  expected: ReceiptContentType,
): boolean {
  return contentType === expected;
}

export function extensionForReceiptContentType(contentType: ReceiptContentType): string {
  if (contentType === "image/jpeg") {
    return "jpg";
  }
  if (contentType === "image/png") {
    return "png";
  }
  return "webp";
}

/**
 * Non-guessable object key: owner / receipt / random object id.
 * Never put original filenames in the key.
 */
export function buildReceiptStorageKey(input: {
  ownerUserId: string;
  receiptId: string;
  objectId: string;
  contentType: ReceiptContentType;
}): string {
  const ext = extensionForReceiptContentType(input.contentType);
  return `${input.ownerUserId}/${input.receiptId}/${input.objectId}.${ext}`;
}

export function normalizeChecksum(value: string): string {
  return value.trim().toLowerCase();
}

export function isSha256Checksum(value: string): boolean {
  return SHA256_HEX.test(normalizeChecksum(value));
}
