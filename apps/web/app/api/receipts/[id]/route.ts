import { isReadabilityReason, READABILITY_RETAKE_COPY, type ReadabilityReason } from "@svl/domain";
import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase, ownerUserId } = await requireReceiptAccess(
      request,
      "GET /api/receipts/[id]",
      id,
    );
    const { data } = await supabase
      .from("receipts")
      .select(
        "status, submitted_at, retention_started_at, delete_after_at, retention_hold, retention_hold_reason, content_deleted_at",
      )
      .eq("id", id)
      .maybeSingle();
    const row = data as {
      status: string;
      submitted_at: string | null;
      retention_started_at: string | null;
      delete_after_at: string | null;
      retention_hold: boolean;
      retention_hold_reason: string | null;
      content_deleted_at: string | null;
    } | null;
    const service = createServiceRoleClient();
    const { data: readabilityData } = await service
      .from("readability_checks")
      .select("readable, failed_page_indexes, reasons, created_at")
      .eq("receipt_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const readability = readabilityData as {
      readable: boolean;
      failed_page_indexes: number[];
      reasons: string[];
      created_at: string;
    } | null;
    const reasons = (readability?.reasons ?? []).filter(isReadabilityReason);
    return Response.json({
      id,
      ownerUserId,
      status: row?.status ?? null,
      submittedAt: row?.submitted_at ?? null,
      retentionStartedAt: row?.retention_started_at ?? null,
      deleteAfterAt: row?.delete_after_at ?? null,
      retentionHold: row?.retention_hold ?? false,
      retentionHoldReason: row?.retention_hold_reason ?? null,
      contentDeletedAt: row?.content_deleted_at ?? null,
      readability:
        readability === null
          ? null
          : {
              readable: readability.readable,
              failedPageIndexes: readability.failed_page_indexes,
              reasons: reasons.map((code: ReadabilityReason) => ({
                code,
                guidance: READABILITY_RETAKE_COPY[code],
              })),
              checkedAt: readability.created_at,
            },
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
