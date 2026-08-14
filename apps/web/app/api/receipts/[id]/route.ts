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
      .select("status, submitted_at")
      .eq("id", id)
      .maybeSingle();
    const row = data as { status: string; submitted_at: string | null } | null;
    return Response.json({
      id,
      ownerUserId,
      status: row?.status ?? null,
      submittedAt: row?.submitted_at ?? null,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
