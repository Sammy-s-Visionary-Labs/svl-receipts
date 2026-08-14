import { authErrorResponse, requireReceiptAccess } from "@/lib/auth/guards";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { ownerUserId } = await requireReceiptAccess(request, "GET /api/receipts/[id]", id);
    return Response.json({ id, ownerUserId });
  } catch (error) {
    return authErrorResponse(error);
  }
}
