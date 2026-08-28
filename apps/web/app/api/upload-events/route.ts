import { parseReceiptUploadTelemetryEvent } from "@svl/domain";
import { AuthHttpError, authErrorResponse, requireActor } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    const { actor, supabase } = await requireActor(request, "POST /api/upload-events");
    const event = parseReceiptUploadTelemetryEvent(await readJson(request));
    if (!event) {
      throw new HttpError(400, "invalid_request", "Upload event is invalid");
    }

    const { data, error } = await supabase
      .from("receipts")
      .select("owner_user_id")
      .eq("id", event.receiptId)
      .maybeSingle();
    if (error || !data || data.owner_user_id !== actor.userId) {
      throw new AuthHttpError(403, "forbidden", "Receipt access denied");
    }

    // The domain parser strips image data, OCR text, coordinates, URLs,
    // credentials, and free-form error messages before this reaches logs.
    console.info("[receipt-upload-client-metric]", event);
    return new Response(null, { status: 204 });
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
