import { SIGNED_READ_TTL_SECONDS } from "@svl/domain";
import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createReceiptReadUrl } from "@/lib/storage/receipts";

type RouteContext = { params: Promise<{ id: string }> };

type ReceiptRow = {
  storage_key: string | null;
  status: string;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { actor, supabase } = await requireReceiptAccess(
      request,
      "GET /api/receipts/[id]/image",
      id,
    );

    const { data, error } = await supabase
      .from("receipts")
      .select("storage_key, status")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) {
      throw new HttpError(404, "not_found", "Receipt image is not available");
    }

    const row = data as ReceiptRow;
    if (!row.storage_key || row.status === "upload_pending") {
      throw new HttpError(404, "not_found", "Receipt image is not available");
    }

    const url = await createReceiptReadUrl(row.storage_key);
    const expiresAt = new Date(Date.now() + SIGNED_READ_TTL_SECONDS * 1000).toISOString();
    console.info("[receipt-image-access]", { userId: actor.userId, receiptId: id });
    return Response.json({ url, expiresAt });
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}
