import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { UUID, validId } from "@/lib/manager/review-request";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    validId(id);
    const { supabase } = await requireManager(request, "GET manager timeline");
    const cursor = new URL(request.url).searchParams.get("cursor");
    let at = null;
    let afterId = null;
    if (cursor) {
      try {
        if (cursor.length > 512) throw new Error();
        const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (
          typeof value.at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(value.at) ||
          !Number.isFinite(Date.parse(value.at)) ||
          typeof value.id !== "string" ||
          !UUID.test(value.id)
        )
          throw new Error();
        at = value.at;
        afterId = value.id;
      } catch {
        throw new HttpError(400, "invalid_request", "Invalid timeline cursor");
      }
    }
    const { data, error } = await supabase.rpc("manager_receipt_timeline", {
      p_receipt_id: id,
      p_after_at: at,
      p_after_id: afterId,
      p_limit: 51,
    });
    if (error) throw error;
    const rows = data ?? [];
    const events = rows.slice(0, 50);
    const last = events.at(-1);
    return Response.json(
      {
        events,
        nextCursor:
          rows.length > 50 && last
            ? Buffer.from(JSON.stringify({ at: last.createdAt, id: last.id })).toString("base64url")
            : null,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
