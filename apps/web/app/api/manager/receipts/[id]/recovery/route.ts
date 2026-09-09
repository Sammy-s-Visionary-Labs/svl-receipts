import { AuthHttpError, authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { parseDraft, readReviewBody, UUID, validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    validId(id);
    const { actor } = await requireManager(request, "POST manager recovery");
    const body = await readReviewBody(request);
    if (body.kind !== "retry" && body.kind !== "correction")
      throw new HttpError(400, "invalid_request", "Invalid recovery command");
    if (body.kind === "correction" && actor.role !== "admin")
      throw new AuthHttpError(
        403,
        "forbidden",
        "An administrator must confirm posted-cost corrections",
      );
    if (
      typeof body.intentId !== "string" ||
      !UUID.test(body.intentId) ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 2000 ||
      (body.kind === "retry" && (typeof body.attemptId !== "string" || !UUID.test(body.attemptId)))
    )
      throw new HttpError(400, "invalid_request", "Provide the target and a reason");
    if (body.kind === "correction" && body.confirmImpact !== true)
      throw new HttpError(400, "invalid_request", "Confirm the correction impact");
    const snapshot = body.kind === "correction" ? parseDraft(body.draft) : null;
    const { data, error } = await createServiceRoleClient().rpc("manager_recovery_command", {
      p_receipt_id: id,
      p_actor_id: actor.userId,
      p_intent_id: body.intentId,
      p_kind: body.kind,
      p_attempt_id: body.kind === "retry" ? body.attemptId : null,
      p_reason: body.reason.trim(),
      p_snapshot: snapshot,
    });
    if (error) throw rpcHttpError(error);
    return Response.json(
      {
        ...data,
        message:
          body.kind === "retry"
            ? "Retry queued for this failed step. Reconciliation is required before another write."
            : "Correction recorded for reconciliation. Posted records are unchanged.",
      },
      { status: 202, headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
