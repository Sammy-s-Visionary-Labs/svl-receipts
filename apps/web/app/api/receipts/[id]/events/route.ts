import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";

type RouteContext = { params: Promise<{ id: string }> };

type AuditRow = {
  id: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  before_ref: unknown;
  after_ref: unknown;
  correlation_id: string;
  payload: unknown;
  created_at: string;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireReceiptAccess(request, "GET /api/receipts/[id]/events", id);
    const { data, error } = await supabase
      .from("audit_events")
      .select(
        "id, action, actor_type, actor_id, before_ref, after_ref, correlation_id, payload, created_at",
      )
      .eq("receipt_id", id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[receipt-events]", error);
      return Response.json(
        { error: { code: "internal", message: "Request failed" } },
        { status: 500 },
      );
    }

    const events = ((data ?? []) as AuditRow[]).map((row) => ({
      id: row.id,
      action: row.action,
      actorType: row.actor_type,
      actorId: row.actor_id,
      before: row.before_ref,
      after: row.after_ref,
      correlationId: row.correlation_id,
      payload: row.payload,
      createdAt: row.created_at,
    }));

    return Response.json({ receiptId: id, events });
  } catch (error) {
    return authErrorResponse(error);
  }
}
