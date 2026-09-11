import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReviewBody, validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin(request, "POST Housecall employee mapping");
    const body = await readReviewBody(request);
    if (
      typeof body.employeeId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(body.employeeId) ||
      typeof body.userId !== "string"
    )
      throw new HttpError(400, "invalid_request", "Enter an employee ID and active app user ID.");
    validId(body.userId);
    const { error } = await createServiceRoleClient().rpc("configure_housecall_employee_mapping", {
      p_actor_id: actor.userId,
      p_employee_id: body.employeeId,
      p_user_id: body.userId,
    });
    if (error) throw rpcHttpError(error);
    return Response.json({ saved: true }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
