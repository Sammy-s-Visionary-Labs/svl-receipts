import { after } from "next/server";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { runReceiptWork, WORK_REQUEST_BUDGET_MS } from "@/lib/work/runner";
// Includes after() work: provider timeout plus image preparation and persistence.
export const maxDuration = 180;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const deadlineAt = Date.now() + WORK_REQUEST_BUDGET_MS;
  try {
    const { id } = await context.params;
    validId(id);
    const { actor } = await requireManager(request, "POST reextract receipt");
    const { data, error } = await createServiceRoleClient().rpc("request_receipt_reextraction", {
      p_receipt_id: id,
      p_actor_id: actor.userId,
    });
    if (error) throw rpcHttpError(error);
    after(async () => {
      try {
        await runReceiptWork(id, "extract", { deadlineAt });
      } catch {
        console.error("[receipt-extraction] kick failed; durable work remains queued");
      }
    });
    return Response.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
