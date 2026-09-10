import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { housecallConfiguration } from "@/lib/housecall/config";
import { buildHousecallExportPreview, type PreviewStepRow } from "@/lib/housecall/preview";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    validId(id);
    const { supabase } = await requireManager(request, "GET manager Housecall export preview");
    const { data: receipt, error } = await supabase
      .from("receipts")
      .select("id,submitted_at,content_deleted_at,purge_claimed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!receipt?.submitted_at || receipt.content_deleted_at || receipt.purge_claimed_at)
      throw new HttpError(404, "not_found", "Receipt content is not available");
    const { data: outbox, error: outboxError } = await supabase
      .from("housecall_outbox")
      .select("intent_id,status")
      .eq("receipt_id", id)
      .maybeSingle();
    if (outboxError) throw outboxError;
    let closedForManualHandling = false;
    if (outbox?.intent_id && outbox.status === "cancelled") {
      const { data: resolution, error: resolutionError } = await supabase
        .from("housecall_manual_resolutions")
        .select("id")
        .eq("receipt_id", id)
        .eq("intent_id", outbox.intent_id)
        .maybeSingle();
      if (resolutionError) throw resolutionError;
      closedForManualHandling = !!resolution;
    }
    const config = housecallConfiguration();
    let intent = null;
    let steps: PreviewStepRow[] = [];
    let catalog: Array<{ id: string; label: string; unavailable?: boolean }> = [];
    if (outbox?.intent_id && outbox.status !== "cancelled") {
      const { data, error: intentError } = await supabase
        .from("housecall_intents")
        .select("id,payload_hash,attachment_job_ids")
        .eq("id", outbox.intent_id)
        .eq("receipt_id", id)
        .single();
      if (intentError) throw intentError;
      intent = data;
      if (!intent || !Array.isArray(intent.attachment_job_ids))
        throw new Error("invalid_export_preview");
      const results = await Promise.all([
        supabase
          .from("housecall_export_steps")
          .select("id,housecall_job_id,step,status,external_id,payload")
          .eq("receipt_id", id)
          .eq("intent_id", intent.id)
          .order("created_at")
          .order("id")
          .limit(601),
        supabase
          .from("manager_job_catalog")
          .select("id,label,unavailable")
          .in("id", intent.attachment_job_ids)
          .limit(101),
      ]);
      for (const result of results) if (result.error) throw result.error;
      steps = results[0].data ?? [];
      catalog = results[1].data ?? [];
      if (steps.length > 600 || catalog.length > 100) throw new Error("invalid_export_preview");
    }
    let preview: ReturnType<typeof buildHousecallExportPreview>;
    try {
      preview = buildHousecallExportPreview({
        receiptId: id,
        intent,
        steps,
        catalog,
        allowedJobIds: config.allowedJobIds,
        liveWritesEnabled: config.exportsEnabled,
      });
    } catch {
      throw new HttpError(
        422,
        "invalid_export_preview",
        "The frozen export plan needs administrator review.",
      );
    }
    return Response.json(
      { ...preview, closedForManualHandling },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const response =
      error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
