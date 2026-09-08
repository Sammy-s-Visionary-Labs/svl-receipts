import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { buildSteps, extractionDraft, legacyReviewDraft, managerJob } from "@/lib/manager/detail";
import { categoryRow } from "@/lib/manager/intelligence";
import type { ReceiptDetail } from "@/lib/manager/review-contract";
import { UUID, validId } from "@/lib/manager/review-request";

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
          "id,work_item_id,schema_version,vendor,purchase_date,invoice_number,ticket_number,receipt_total_cents,tax_cents,lines,confidence,created_at,normalized",
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
        .select(
          "id,housecall_job_id,label,source,receipt_line_id,extraction_id,score,reasons,source_index,scoring_version",
        )
        .eq("receipt_id", id)
        .order("created_at", { ascending: false })
        .limit(505),
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
      supabase
        .from("receipt_categories")
        .select("id,label,active,keywords,version")
        .order("label")
        .limit(500),
      supabase
        .from("duplicate_candidates")
        .select("id,candidate_receipt_id,score,reasons,status")
        .eq("receipt_id", id)
        .order("score", { ascending: false })
        .limit(500),
    ]);
    for (const result of results) if (result.error) throw result.error;
    const [extractions, reviews, suggestions, pages, outbox, commands, categories, duplicates] =
      results;
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
      savedDraft = legacyReviewDraft(
        original,
        patches.data ?? {},
        extraction?.work_item_id ? [] : (legacyLines.data ?? []),
      );
    }
    const reprocessed =
      !!review?.snapshot && !!extraction?.id && review.extraction_id !== extraction.id;
    const sourceIds = [
      ...new Set(
        (savedDraft.lines ?? [])
          .map((line: { id?: string }) => line.id?.split(":")[0])
          .filter(
            (value: unknown): value is string =>
              typeof value === "string" && UUID.test(value) && value !== extraction?.id,
          ),
      ),
    ];
    const lineEvidence: NonNullable<ReceiptDetail["lineEvidence"]> = {};
    for (const line of original.lines) if (line.id) lineEvidence[line.id] = line;
    if (sourceIds.length) {
      const { data: origins, error: originError } = await supabase
        .from("extractions")
        .select("id,lines")
        .eq("receipt_id", id)
        .in("id", sourceIds)
        .limit(100);
      if (originError) throw originError;
      for (const origin of origins ?? [])
        for (const line of extractionDraft(origin).lines) if (line.id) lineEvidence[line.id] = line;
    }
    if (reprocessed)
      savedDraft = {
        ...savedDraft,
        lines: savedDraft.lines.map((line: Record<string, unknown>) => {
          if (typeof line.id === "string" && line.id.startsWith(`${extraction?.id}:`)) return line;
          const { sourceIndex: _sourceIndex, suggestionId: _suggestionId, ...retained } = line;
          return retained;
        }),
      };
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
      lineEvidence,
      reprocessed,
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
      suggestions: (suggestions.data ?? [])
        .filter(
          (row) =>
            row.extraction_id === extraction?.id ||
            (!extraction?.work_item_id && !row.extraction_id),
        )
        .map(managerJob)
        .sort(
          (a, b) =>
            (a.sourceIndex ?? -1) - (b.sourceIndex ?? -1) ||
            (b.score ?? 0) - (a.score ?? 0) ||
            a.id.localeCompare(b.id),
        ),
      categories: (categories.data ?? []).map(categoryRow),
      categorySuggestion: extraction?.normalized?.category_suggestion ?? null,
      warnings: extraction?.normalized?.warnings ?? [],
      duplicates: (duplicates.data ?? []).map((row) => ({
        id: row.id,
        receiptId: row.candidate_receipt_id,
        score: row.score,
        reasons: row.reasons,
        status: row.status,
      })),
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
