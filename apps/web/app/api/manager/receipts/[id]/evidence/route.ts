import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { UUID, validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validId(id);
    const { actor } = await requireManager(request, "GET manager extraction evidence");
    const extractionId = new URL(request.url).searchParams.get("extractionId");
    if (!extractionId || !UUID.test(extractionId))
      throw new HttpError(400, "invalid_request", "Choose an extraction version.");
    const { data, error } = await createServiceRoleClient().rpc("manager_extraction_evidence", {
      p_actor_id: actor.userId,
      p_receipt_id: id,
      p_extraction_id: extractionId,
    });
    if (error) throw rpcHttpError(error);
    // Explicit field projection prevents accidentally returning restricted raw response payloads.
    const evidence = (Array.isArray(data) ? data : []).map((item) => ({
      field: item.field,
      text: item.text,
      page_index: item.page_index,
      confidence: item.confidence,
    }));
    return Response.json({ evidence }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
