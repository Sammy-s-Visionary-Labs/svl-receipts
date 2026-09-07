import { AuthHttpError, authErrorResponse, requireManager } from "@/lib/auth/guards";
import {
  encodeQueueCursor,
  InvalidQueueRequest,
  normalizeQueueRow,
  parseQueueRequest,
  queueRpcParameters,
} from "@/lib/manager/queue";
import type { QueueResponse } from "@/lib/manager/queue-contract";

export const dynamic = "force-dynamic";

function privateResponse(response: Response) {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET /api/manager/queue");
    const parsed = parseQueueRequest(new URL(request.url));
    const { data, error } = await supabase.rpc("manager_review_queue", queueRpcParameters(parsed));
    if (error?.code === "42501")
      throw new AuthHttpError(403, "forbidden", "Manager access required");
    if (error) throw new Error("Manager queue query failed");
    if (!Array.isArray(data)) throw new Error("Invalid manager queue response");
    const hasMore = data.length > parsed.filters.limit;
    const receipts = data.slice(0, parsed.filters.limit).map(normalizeQueueRow);
    const last = receipts.at(-1);
    const body: QueueResponse = {
      receipts,
      filters: parsed.filters,
      asOf: parsed.asOf,
      nextCursor: hasMore && last ? encodeQueueCursor(last, parsed.filters, parsed.asOf) : null,
    };
    return privateResponse(Response.json(body));
  } catch (error) {
    if (error instanceof InvalidQueueRequest) {
      return privateResponse(
        Response.json(
          { error: { code: "invalid_request", message: error.message } },
          { status: 400 },
        ),
      );
    }
    return privateResponse(authErrorResponse(error));
  }
}
