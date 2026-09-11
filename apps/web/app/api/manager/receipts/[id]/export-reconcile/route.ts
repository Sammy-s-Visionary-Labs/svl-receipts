import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { runReceiptHousecallExport } from "@/lib/housecall/export";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validId(id);
    const { supabase } = await requireManager(request, "POST Housecall reconciliation reads");
    const { data, error } = await supabase
      .from("receipts")
      .select("id,submitted_at,content_deleted_at,purge_claimed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data?.submitted_at || data.content_deleted_at || data.purge_claimed_at)
      throw new HttpError(404, "not_found", "Receipt content is not available");
    // This endpoint can only GET provider evidence; it never grants or consumes a write permit.
    return Response.json(await runReceiptHousecallExport(id, { reconcileOnly: true }), {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
