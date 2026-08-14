import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";

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
        "status, submitted_at, retention_starts_at, delete_after_at, retention_hold, retention_hold_reason, content_deleted_at",
      )
      .eq("id", id)
      .maybeSingle();
    const row = data as {
      status: string;
      submitted_at: string | null;
      retention_starts_at: string | null;
      delete_after_at: string | null;
      retention_hold: boolean;
      retention_hold_reason: string | null;
      content_deleted_at: string | null;
    } | null;
    return Response.json({
      id,
      ownerUserId,
      status: row?.status ?? null,
      submittedAt: row?.submitted_at ?? null,
      retentionStartsAt: row?.retention_starts_at ?? null,
      deleteAfterAt: row?.delete_after_at ?? null,
      retentionHold: row?.retention_hold ?? false,
      retentionHoldReason: row?.retention_hold_reason ?? null,
      contentDeletedAt: row?.content_deleted_at ?? null,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
