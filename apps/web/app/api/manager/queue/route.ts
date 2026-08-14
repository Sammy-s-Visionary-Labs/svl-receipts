import { authErrorResponse, requireManager } from "@/lib/auth/guards";

export async function GET(request: Request) {
  try {
    await requireManager(request, "GET /api/manager/queue");
    return Response.json({ ok: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
