import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReviewBody } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin(request, "POST receipt category configuration");
    const body = await readReviewBody(request);
    if (
      typeof body.id !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(body.id) ||
      typeof body.label !== "string" ||
      !body.label.trim() ||
      body.label.length > 100 ||
      typeof body.active !== "boolean" ||
      !Array.isArray(body.keywords) ||
      body.keywords.length > 50 ||
      body.keywords.some((v) => typeof v !== "string" || !v.trim() || v.length > 80)
    )
      throw new HttpError(
        400,
        "invalid_request",
        "Enter a category ID, label and up to 50 keywords.",
      );
    const { data, error } = await createServiceRoleClient().rpc("configure_receipt_category", {
      p_actor_id: actor.userId,
      p_id: body.id,
      p_label: body.label.trim(),
      p_active: body.active,
      p_keywords: [...new Set(body.keywords.map((v: string) => v.trim().toLowerCase()))],
    });
    if (error) throw rpcHttpError(error);
    return Response.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
