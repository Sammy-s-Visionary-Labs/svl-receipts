import { createHash, timingSafeEqual } from "node:crypto";
import {
  declaredContentTypeMatches,
  isReceiptStorageObjectAbsent,
  MAX_RECEIPT_BYTES,
  RECEIPT_BUCKET,
  type ReceiptContentType,
  SIGNED_READ_TTL_SECONDS,
} from "@svl/domain";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type ReceiptObjectStore = {
  createUploadTarget(storageKey: string): Promise<{ signedUrl: string; token: string }>;
  createReadUrl(storageKey: string): Promise<string>;
  readObject(storageKey: string): Promise<{ bytes: Buffer; contentType: string | null } | null>;
  removeObject(storageKey: string): Promise<void>;
};

export const supabaseReceiptObjectStore: ReceiptObjectStore = {
  createUploadTarget: createReceiptUploadTarget,
  createReadUrl: createReceiptReadUrl,
  readObject: readReceiptObject,
  removeObject: removeReceiptObject,
};

export async function createReceiptUploadTarget(storageKey: string) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .createSignedUploadUrl(storageKey, { upsert: false });

  if (error || !data) {
    throw error ?? new Error("Failed to create signed upload URL");
  }

  return data;
}

export async function createReceiptReadUrl(storageKey: string) {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage
    .from(RECEIPT_BUCKET)
    .createSignedUrl(storageKey, SIGNED_READ_TTL_SECONDS);

  if (error || !data) {
    throw error ?? new Error("Failed to create signed read URL");
  }

  return data.signedUrl;
}

export type ReceiptObjectExistence = "present" | "absent" | "unknown";

export async function receiptObjectExists(storageKey: string): Promise<ReceiptObjectExistence> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).download(storageKey);
  if (data) {
    return "present";
  }
  if (isReceiptStorageObjectAbsent(error)) {
    return "absent";
  }
  return "unknown";
}

export async function readReceiptObject(storageKey: string): Promise<{
  bytes: Buffer;
  contentType: string | null;
} | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).download(storageKey);
  if (error || !data) {
    return null;
  }

  const bytes = Buffer.from(await data.arrayBuffer());
  return { bytes, contentType: data.type || null };
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function checksumsMatch(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export function objectMatchesSession(input: {
  bytes: Buffer;
  contentType: string | null;
  expectedContentType: ReceiptContentType;
}): boolean {
  if (input.bytes.byteLength === 0 || input.bytes.byteLength > MAX_RECEIPT_BYTES) {
    return false;
  }
  return declaredContentTypeMatches(input.contentType, input.expectedContentType);
}

export async function removeReceiptObject(storageKey: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).remove([storageKey]);
  if (error && !isReceiptStorageObjectAbsent(error)) {
    throw error;
  }

  const existence = await receiptObjectExists(storageKey);
  if (existence === "present") {
    throw new Error("storage_object_still_present");
  }
  if (existence === "unknown") {
    throw new Error("storage_object_existence_unknown");
  }
}
