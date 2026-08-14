import { randomUUID } from "node:crypto";
import {
  ALLOWED_RECEIPT_CONTENT_TYPES,
  buildReceiptStorageKey,
  isReceiptContentType,
  MAX_RECEIPT_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
} from "@svl/domain";
import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createReceiptUploadTarget } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

type SessionBody = {
  contentType?: unknown;
  originalFilename?: unknown;
};

export async function POST(request: Request) {
  try {
    const { actor } = await requireActor(request, "POST /api/upload-sessions");
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

    const service = createServiceRoleClient();
    const { error: insertError } = await service.rpc("create_upload_pending_receipt", {
      p_actor_id: actor.userId,
      p_receipt_id: receiptId,
      p_storage_key: storageKey,
      p_content_type: contentType,
      p_original_filename: originalFilename,
      p_correlation_id: randomUUID(),
    });
    if (insertError) {
      console.error("[upload-session]", insertError);
      throw rpcHttpError(insertError);
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
