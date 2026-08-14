import {
  actorMayReadReceipt,
  evaluateReceiptTransition,
  isReceiptContentType,
  isSha256Checksum,
  normalizeChecksum,
} from "@svl/domain";
import { AuthHttpError, authErrorResponse, requireActor } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import {
  checksumsMatch,
  objectMatchesSession,
  readReceiptObject,
  sha256Hex,
} from "@/lib/storage/receipts";

type RouteContext = { params: Promise<{ id: string }> };

type ConfirmBody = {
  checksum?: unknown;
};

type ReceiptRow = {
  id: string;
  owner_user_id: string;
  status: string;
  storage_key: string | null;
  content_type: string | null;
  checksum: string | null;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { actor, supabase } = await requireActor(request, "POST /api/receipts/[id]/confirm");
    const body = (await readJson(request)) as ConfirmBody;
    if (typeof body.checksum !== "string" || !isSha256Checksum(body.checksum)) {
      throw new HttpError(400, "invalid_request", "checksum must be a sha256 hex digest");
    }
    const checksum = normalizeChecksum(body.checksum);

    const { data, error } = await supabase
      .from("receipts")
      .select("id, owner_user_id, status, storage_key, content_type, checksum")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) {
      throw new AuthHttpError(403, "forbidden", "Receipt access denied");
    }

    const row = data as ReceiptRow;
    if (!actorMayReadReceipt(actor, row.owner_user_id) || actor.userId !== row.owner_user_id) {
      throw new AuthHttpError(403, "forbidden", "Receipt access denied");
    }

    if (row.status !== "upload_pending") {
      if (row.checksum && checksumsMatch(row.checksum, checksum)) {
        return Response.json({ id: row.id, status: row.status });
      }
      throw new HttpError(409, "conflict", "Receipt is not awaiting upload confirmation");
    }

    const contentType = row.content_type;
    if (!row.storage_key || !contentType || !isReceiptContentType(contentType)) {
      throw new HttpError(409, "conflict", "Upload session is incomplete");
    }

    const object = await readReceiptObject(row.storage_key);
    if (!object) {
      throw new HttpError(404, "not_found", "Uploaded object is missing");
    }

    if (
      !objectMatchesSession({
        bytes: object.bytes,
        contentType: object.contentType,
        expectedContentType: contentType,
      })
    ) {
      throw new HttpError(409, "conflict", "Uploaded object does not match the session");
    }

    const actualChecksum = sha256Hex(object.bytes);
    if (!checksumsMatch(checksum, actualChecksum)) {
      throw new HttpError(409, "conflict", "Checksum does not match the uploaded object");
    }

    const transition = evaluateReceiptTransition({
      from: row.status,
      to: "submitted",
      actorId: actor.userId,
      occurredAt: new Date(),
    });
    if (!transition.ok) {
      throw new HttpError(409, "conflict", "Illegal status transition");
    }

    const submittedAt = new Date().toISOString();
    const { data: updated, error: updateError } = await supabase
      .from("receipts")
      .update({
        status: "submitted",
        checksum,
        byte_size: object.bytes.byteLength,
        submitted_at: submittedAt,
      })
      .eq("id", row.id)
      .eq("status", "upload_pending")
      .select("id, status")
      .maybeSingle();

    if (updateError) {
      console.error("[upload-confirm]", updateError);
      throw new HttpError(500, "internal", "Request failed");
    }

    if (!updated) {
      return Response.json({ id: row.id, status: "submitted" });
    }

    return Response.json({ id: updated.id, status: updated.status });
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
