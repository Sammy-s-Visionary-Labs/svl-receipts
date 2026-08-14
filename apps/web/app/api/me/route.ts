import { authErrorResponse, requireActor } from "@/lib/auth/guards";

export async function GET(request: Request) {
  try {
    const { actor } = await requireActor(request, "GET /api/me");
    return Response.json({
      userId: actor.userId,
      role: actor.role,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}
