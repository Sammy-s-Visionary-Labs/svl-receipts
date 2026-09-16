import { createHash } from "node:crypto";
import { RECEIPT_BUCKET, receiptManifestDigestInput } from "@svl/domain";
import { HttpError } from "@/lib/http";
import { sha256Hex } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runReceiptWork } from "@/lib/work/runner";
import { EMAIL_BUCKET, EMAIL_MAILBOX, MAX_EMAIL_BYTES } from "./config";
import { EmailPreparationError, prepareEmail } from "./prepare";
export type EmailImport = {
  id: string;
  checksum: string;
  byte_size: number;
  owner_user_id: string;
  status: string;
  attempts: number;
  lease_token: string | null;
};
export const emailKey = (id: string) => `${id}/original.eml`;
export function stableEmailId(value: string) {
  const hex = createHash("sha256").update(`svl-email-v1:${value}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export async function initializeEmailImport(body: Record<string, unknown>, ownerId: string) {
  const { messageId, checksum, byteSize } = body;
  if (
    typeof messageId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(messageId) ||
    typeof checksum !== "string" ||
    !/^[a-f0-9]{64}$/.test(checksum) ||
    !Number.isInteger(byteSize) ||
    Number(byteSize) < 1 ||
    Number(byteSize) > MAX_EMAIL_BYTES
  )
    throw new HttpError(400, "invalid_request", "Invalid email manifest.");
  const db = createServiceRoleClient();
  const { data: actor, error: actorError } = await db
    .from("profiles")
    .select("role,disabled")
    .eq("id", ownerId)
    .single();
  if (actorError || !actor || actor.disabled || !["manager", "admin"].includes(actor.role))
    throw new HttpError(
      503,
      "email_owner_unavailable",
      "Email intake needs an active manager account.",
    );
  const { error: insertError } = await db.from("email_receipt_imports").upsert(
    {
      mailbox: EMAIL_MAILBOX,
      message_id: messageId,
      checksum,
      byte_size: byteSize,
      owner_user_id: ownerId,
    },
    { onConflict: "mailbox,message_id", ignoreDuplicates: true },
  );
  if (insertError) throw insertError;
  const { data: row, error } = await db
    .from("email_receipt_imports")
    .select("id,checksum,byte_size,status")
    .eq("mailbox", EMAIL_MAILBOX)
    .eq("message_id", messageId)
    .single();
  if (error) throw error;
  if (row.checksum !== checksum || row.byte_size !== byteSize)
    throw new HttpError(409, "email_changed", "This message already has a different original.");
  if (row.status !== "awaiting_upload") return { id: row.id, status: row.status };
  const upload = await db.storage
    .from(EMAIL_BUCKET)
    .createSignedUploadUrl(emailKey(row.id), { upsert: false });
  if (upload.error) throw upload.error;
  return { id: row.id, status: row.status, uploadUrl: upload.data.signedUrl };
}
export async function confirmEmailImport(id: string) {
  const db = createServiceRoleClient();
  const { data: row, error } = await db
    .from("email_receipt_imports")
    .select("id,checksum,byte_size,status")
    .eq("id", id)
    .single();
  if (error || !row) throw new HttpError(404, "not_found", "Email import not found.");
  if (row.status !== "awaiting_upload") return { id, status: row.status };
  const object = await db.storage.from(EMAIL_BUCKET).download(emailKey(id));
  if (object.error || !object.data)
    throw new HttpError(
      409,
      "email_upload_missing",
      "The original email has not finished uploading.",
    );
  const raw = Buffer.from(await object.data.arrayBuffer());
  if (raw.length !== row.byte_size || sha256Hex(raw) !== row.checksum)
    throw new HttpError(409, "email_checksum_mismatch", "Original email verification failed.");
  const updated = await db
    .from("email_receipt_imports")
    .update({ status: "queued", updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "awaiting_upload");
  if (updated.error) throw updated.error;
  return { id, status: "queued" };
}
export async function processEmailImport(id: string, deadlineAt = Date.now() + 150000) {
  const db = createServiceRoleClient();
  const { data: claimed, error } = await db.rpc("claim_email_receipt_import", { p_id: id });
  if (error) throw error;
  const row = claimed?.[0] as EmailImport | undefined;
  if (!row) return;
  try {
    const original = await db.storage.from(EMAIL_BUCKET).download(emailKey(id));
    if (original.error || !original.data) throw new Error("original_unavailable");
    const raw = Buffer.from(await original.data.arrayBuffer());
    if (raw.length !== row.byte_size || sha256Hex(raw) !== row.checksum)
      throw new EmailPreparationError("email_checksum_mismatch");
    const prepared = await prepareEmail(raw, Math.min(deadlineAt - 15000, Date.now() + 90000));
    const documents = [];
    for (const [part, document] of prepared.documents.entries()) {
      const receiptId = stableEmailId(`${id}:${part}`);
      const pages = [];
      for (const [index, bytes] of document.pages.entries()) {
        if (Date.now() > deadlineAt - 15000) throw new Error("import_deadline");
        const checksum = sha256Hex(bytes);
        // Content-addressed pages keep a changed renderer's output separate on retry.
        const key = `${row.owner_user_id}/${receiptId}/${checksum}.jpg`;
        const uploaded = await db.storage
          .from(RECEIPT_BUCKET)
          .upload(key, bytes, { contentType: "image/jpeg", upsert: false });
        if (uploaded.error) {
          const previous = await db.storage.from(RECEIPT_BUCKET).download(key);
          if (
            previous.error ||
            !previous.data ||
            sha256Hex(Buffer.from(await previous.data.arrayBuffer())) !== checksum
          )
            throw new Error("page_upload_failed");
        }
        pages.push({
          pageIndex: index,
          storageKey: key,
          contentType: "image/jpeg",
          originalFilename: document.filename,
          checksum,
          byteSize: bytes.length,
        });
      }
      documents.push({
        receiptId,
        filename: document.filename,
        pages,
        manifestChecksum: sha256Hex(Buffer.from(receiptManifestDigestInput(pages))),
        totalBytes: pages.reduce((n, p) => n + p.byteSize, 0),
      });
    }
    const committed = await db.rpc("commit_email_receipts", {
      p_import_id: id,
      p_lease_token: row.lease_token,
      p_documents: documents,
      p_sender: prepared.sender,
      p_subject: prepared.subject,
      p_received_at: prepared.receivedAt,
    });
    if (committed.error) throw committed.error;
  } catch (error) {
    const permanent = error instanceof EmailPreparationError || row.attempts >= 5;
    const code = error instanceof EmailPreparationError ? error.code : "processing_failed";
    const updated = await db
      .from("email_receipt_imports")
      .update({
        status: permanent ? "needs_attention" : "queued",
        last_error: code,
        lease_token: null,
        lease_until: null,
        next_attempt_at: new Date(Date.now() + 5 * 60000).toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("lease_token", row.lease_token);
    if (updated.error) throw updated.error;
    console.warn("[email-import]", { id, code });
  }
}
/** Only import/extraction work. This endpoint never runs Housecall exports. */
export async function runEmailImportBatch(preferredId?: string) {
  const deadlineAt = Date.now() + 150000;
  const db = createServiceRoleClient();
  await purgeEmailOriginals();
  if (preferredId) await processEmailImport(preferredId, deadlineAt);
  else {
    const result = await db
      .from("email_receipt_imports")
      .select("id")
      .in("status", ["queued", "processing"])
      .lte("next_attempt_at", new Date().toISOString())
      .order("created_at")
      .limit(2);
    if (result.error) throw result.error;
    for (const row of result.data ?? [])
      if (Date.now() < deadlineAt - 30000) await processEmailImport(row.id, deadlineAt);
  }
  const pending = await db
    .from("email_receipt_documents")
    .select("receipt_id,receipts!inner(status)")
    .in("receipts.status", ["submitted", "processing"])
    .order("receipt_id")
    .limit(20);
  if (pending.error) throw pending.error;
  if (Date.now() < deadlineAt - 25000) {
    await Promise.all(
      (pending.data ?? []).slice(0, 4).map(async (row) => {
        await runReceiptWork(row.receipt_id, "readability", { deadlineAt });
        await runReceiptWork(row.receipt_id, "extract", { deadlineAt });
      }),
    );
  }
  return { ok: true };
}

async function purgeEmailOriginals() {
  const db = createServiceRoleClient();
  const due = await db.rpc("purgeable_email_originals");
  if (due.error) throw due.error;
  for (const row of due.data ?? []) {
    const result = await db.storage.from(EMAIL_BUCKET).remove([emailKey(row.id)]);
    if (result.error) throw result.error;
    const retired = await db.rpc("retire_email_original", { p_id: row.id });
    if (retired.error) throw retired.error;
  }
}

export async function recordEmailContact() {
  const result = await createServiceRoleClient()
    .from("email_importer_health")
    .upsert({ singleton: true, last_contact_at: new Date().toISOString() });
  if (result.error) throw result.error;
}
