import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { buildSteps, extractionDraft, legacyReviewDraft, managerJob } from "@/lib/manager/detail";
import type { ReceiptDetail } from "@/lib/manager/review-contract";
import { validId } from "@/lib/manager/review-request";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    validId(id);
    const { supabase } = await requireManager(request, "GET manager receipt detail");
    const { data: receipt, error } = await supabase
      .from("receipts")
      .select(
        "id,status,submitted_at,review_version,gps_lat,gps_lng,content_deleted_at,purge_claimed_at",
      )
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!receipt || receipt.content_deleted_at || receipt.purge_claimed_at || !receipt.submitted_at)
      throw new HttpError(404, "not_found", "Receipt content is not available");
    const results = await Promise.all([
      supabase
        .from("extractions")
        .select(
          "id,schema_version,vendor,purchase_date,invoice_number,ticket_number,receipt_total_cents,tax_cents,lines,confidence,created_at",
        )
        .eq("receipt_id", id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      supabase
        .from("reviews")
        .select(
          "id,actor_id,decision,reason,version,base_version,snapshot,edits,extraction_id,changed_fields,canonical_receipt_id,created_at",
        )
        .eq("receipt_id", id)
        .order("version", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      supabase
        .from("job_candidates")
        .select("id,housecall_job_id,label,source,receipt_line_id")
        .eq("receipt_id", id)
        .order("created_at", { ascending: false })
        .limit(100),
      supabase
        .from("receipt_pages")
        .select("page_index")
        .eq("receipt_id", id)
        .not("confirmed_at", "is", null)
        .limit(5),
      supabase
        .from("housecall_outbox")
        .select("intent_id,status")
        .eq("receipt_id", id)
        .maybeSingle(),
      supabase
        .from("manager_recovery_commands")
        .select(
          "id,actor_id,kind,attempt_id,status,created_at,reason,before_snapshot,proposed_snapshot",
        )
        .eq("receipt_id", id)
        .order("created_at", { ascending: false })
        .limit(100),
    ]);
    for (const result of results) if (result.error) throw result.error;
    const [extractions, reviews, suggestions, pages, outbox, commands] = results;
    const extraction = extractions.data?.[0] ?? null;
    const review = reviews.data?.[0] ?? null;
    let intent = null;
    let attempts: Record<string, unknown>[] = [];
    let links: Record<string, unknown>[] = [];
    if (outbox.data?.intent_id) {
      const exportResults = await Promise.all([
        supabase
          .from("housecall_intents")
          .select("id,attachment_job_ids,job_cost_lines")
          .eq("id", outbox.data.intent_id)
          .single(),
        supabase.rpc("manager_current_export_attempts", {
          p_receipt_id: id,
          p_intent_id: outbox.data.intent_id,
        }),
        supabase
          .from("housecall_links")
          .select("housecall_job_id,receipt_line_id,step,external_id")
          .eq("receipt_id", id)
          .limit(200),
      ]);
      for (const result of exportResults) if (result.error) throw result.error;
      intent = exportResults[0].data;
      attempts = exportResults[1].data ?? [];
      links = exportResults[2].data ?? [];
    }
    const original = extractionDraft(extraction);
    if (Array.isArray(extraction?.lines) && extraction.lines.length > 100)
      throw new HttpError(
        422,
        "review_limit",
        "This receipt exceeds the 100-line review limit. Ask an administrator to split it before approval.",
      );
    let savedDraft = review?.snapshot ?? original;
    if (!review?.snapshot) {
      const [patches, legacyLines] = await Promise.all([
        supabase.rpc("manager_legacy_review_edits", { p_receipt_id: id }),
        supabase
          .from("receipt_lines")
          .select("id,description,qty,uom,unit_cost_cents,job_id")
          .eq("receipt_id", id)
          .order("sort_index", { ascending: true })
          .limit(101),
      ]);
      if (patches.error) throw patches.error;
      if (legacyLines.error) throw legacyLines.error;
      if ((legacyLines.data?.length ?? 0) > 100)
        throw new HttpError(422, "review_limit", "This receipt exceeds the 100-line review limit.");
      savedDraft = legacyReviewDraft(original, patches.data ?? {}, legacyLines.data ?? []);
    }
    const { data: events, error: eventError } = await supabase.rpc("manager_receipt_timeline", {
      p_receipt_id: id,
      p_after_at: null,
      p_after_id: null,
      p_limit: 51,
    });
    if (eventError) throw eventError;
    const eventRows = events ?? [];
    const eventPage = eventRows.slice(0, 50);
    const last = eventPage.at(-1);
    const data: ReceiptDetail = {
      id,
      status: receipt.status,
      submittedAt: receipt.submitted_at,
      version: receipt.review_version,
      extractionId: extraction?.id ?? null,
      draft: savedDraft,
      original,
      confidence: extraction?.confidence ?? {},
      gps: receipt.gps_lat === null ? null : { lat: receipt.gps_lat, lng: receipt.gps_lng },
      pageCount: pages.data?.length ?? 0,
      editable: receipt.status === "needs_review",
      steps: buildSteps(intent, attempts, links, commands.data ?? []),
      events: eventPage,
      nextEventCursor:
        eventRows.length > 50 && last
          ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url")
          : null,
      suggestions: (suggestions.data ?? []).map(managerJob),
      correctionPending: (commands.data ?? []).some(
        (c) => c.kind === "correction" && ["pending", "processing"].includes(c.status),
      ),
      clarification: review?.decision === "request_clarification" ? review.reason : null,
      canonicalReceiptId: review?.canonical_receipt_id ?? null,
    };
    return Response.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
