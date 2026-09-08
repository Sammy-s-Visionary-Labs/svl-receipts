import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReviewBody, UUID, validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validId(id);
    const { actor, supabase } = await requireManager(request, "POST dismiss duplicate candidate");
    const body = await readReviewBody(request);
    if (
      body.decision !== "dismiss" ||
      typeof body.candidateId !== "string" ||
      !UUID.test(body.candidateId)
    )
      throw new HttpError(400, "invalid_request", "Choose a duplicate candidate to dismiss.");
    const { data: candidate, error: readError } = await supabase
      .from("duplicate_candidates")
      .select("id")
      .eq("id", body.candidateId)
      .eq("receipt_id", id)
      .maybeSingle();
    if (readError) throw readError;
    if (!candidate) throw new HttpError(404, "not_found", "Candidate is unavailable.");
    const { data, error } = await createServiceRoleClient().rpc("dismiss_duplicate_candidate", {
      p_id: body.candidateId,
      p_actor_id: actor.userId,
    });
    if (error) throw rpcHttpError(error);
    return Response.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
