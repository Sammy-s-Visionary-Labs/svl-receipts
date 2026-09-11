import { SIGNED_READ_TTL_SECONDS } from "@svl/domain";
import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createReceiptReadUrl } from "@/lib/storage/receipts";

type RouteContext = { params: Promise<{ id: string }> };

type ReceiptRow = {
  storage_key: string | null;
  status: string;
  content_deleted_at: string | null;
  purge_claimed_at: string | null;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { actor, supabase } = await requireReceiptAccess(
      request,
      "GET /api/receipts/[id]/image",
      id,
    );
    const pageParams = new URL(request.url).searchParams.getAll("page");
    const page = pageParams[0] ?? "0";
    if (pageParams.length > 1 || !/^[0-4]$/.test(page))
      throw new HttpError(400, "invalid_request", "Choose a valid receipt page");

    const { data, error } = await supabase
      .from("receipts")
      .select("storage_key, status, content_deleted_at, purge_claimed_at")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) {
      throw new HttpError(404, "not_found", "Receipt image is not available");
    }

    const row = data as ReceiptRow;
    if (
      !row.storage_key ||
      row.status === "upload_pending" ||
      row.content_deleted_at ||
      row.purge_claimed_at
    ) {
      throw new HttpError(404, "not_found", "Receipt image is not available");
    }

    let storageKey = row.storage_key;
    if (page !== "0") {
      const { data: receiptPage, error: pageError } = await supabase
        .from("receipt_pages")
        .select("storage_key,confirmed_at")
        .eq("receipt_id", id)
        .eq("page_index", Number(page))
        .maybeSingle();
      if (pageError || !receiptPage?.storage_key || !receiptPage.confirmed_at)
        throw new HttpError(404, "not_found", "Receipt page is not available");
      storageKey = receiptPage.storage_key;
    }
    const url = await createReceiptReadUrl(storageKey);
    const expiresAt = new Date(Date.now() + SIGNED_READ_TTL_SECONDS * 1000).toISOString();
    console.info("[receipt-image-access]", { userId: actor.userId, receiptId: id });
    return Response.json({ url, expiresAt }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}
