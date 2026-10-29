import { after } from "next/server";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { housecallConfiguration } from "@/lib/housecall/config";
import { runReceiptHousecallExport } from "@/lib/housecall/export";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";

export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validId(id);
    const { supabase } = await requireManager(request, "POST continue approved Housecall export");
    const { data, error } = await supabase
      .from("receipts")
      .select("id,status,submitted_at,content_deleted_at,purge_claimed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data?.submitted_at || data.content_deleted_at || data.purge_claimed_at)
      throw new HttpError(404, "not_found", "Receipt content is not available");
    if (!["approved", "exporting", "partial_success", "export_failed"].includes(data.status))
      throw new HttpError(
        409,
        "export_not_pending",
        "This receipt has no pending approved export.",
      );
    const config = housecallConfiguration();
    if (config.mode !== "manager_approved" || !config.exportsEnabled)
      throw new HttpError(
        503,
        "export_unavailable",
        "Housecall export is unavailable. Try again later.",
      );
    // Reuse the frozen intent and its existing manager approval. This route never
    // creates a grant, changes a destination or requeues a successful step.
    after(async () => {
      try {
        await runReceiptHousecallExport(id);
      } catch {
        console.error("[manager-review] export continuation failed; durable work remains queued");
      }
    });
    return Response.json(
      { message: "Housecall export continuation requested. Check progress for confirmation." },
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
