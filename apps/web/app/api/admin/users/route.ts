import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";

export async function GET(request: Request) {
  try {
    await requireAdmin(request, "GET /api/admin/users");
    return Response.json({ ok: true });
  } catch (error) {
    return authErrorResponse(error);
  }
}
