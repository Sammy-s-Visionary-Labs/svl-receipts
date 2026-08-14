import { randomUUID } from "node:crypto";
import {
  ALLOWED_RECEIPT_CONTENT_TYPES,
  buildReceiptStorageKey,
  isReceiptContentType,
  MAX_RECEIPT_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
} from "@svl/domain";
import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createReceiptUploadTarget } from "@/lib/storage/receipts";

type SessionBody = {
  contentType?: unknown;
  originalFilename?: unknown;
};

export async function POST(request: Request) {
  try {
    const { actor, supabase } = await requireActor(request, "POST /api/upload-sessions");
    const body = (await readJson(request)) as SessionBody;
    const contentType = typeof body.contentType === "string" ? body.contentType : "image/jpeg";
    if (!isReceiptContentType(contentType)) {
      throw new HttpError(400, "invalid_request", "Unsupported content type");
    }

    const originalFilename =
      typeof body.originalFilename === "string" && body.originalFilename.length > 0
        ? body.originalFilename.slice(0, 255)
        : null;

    const receiptId = randomUUID();
    const storageKey = buildReceiptStorageKey({
      ownerUserId: actor.userId,
      receiptId,
      objectId: randomUUID(),
      contentType,
    });

    const { error: insertError } = await supabase.from("receipts").insert({
      id: receiptId,
      owner_user_id: actor.userId,
      status: "upload_pending",
      storage_key: storageKey,
      content_type: contentType,
      original_filename: originalFilename,
    });
    if (insertError) {
      console.error("[upload-session]", insertError);
      throw new HttpError(500, "internal", "Request failed");
    }

    const upload = await createReceiptUploadTarget(storageKey);
    const expiresAt = new Date(Date.now() + UPLOAD_SESSION_TTL_SECONDS * 1000).toISOString();

    return Response.json({
      receiptId,
      storageKey,
      uploadUrl: upload.signedUrl,
      token: upload.token,
      expiresAt,
      allowedContentType: contentType,
      allowedContentTypes: ALLOWED_RECEIPT_CONTENT_TYPES,
      maxBytes: MAX_RECEIPT_BYTES,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON");
  }
}
