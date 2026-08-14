import { randomUUID } from "node:crypto";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

type HoldBody = {
  hold?: unknown;
  reason?: unknown;
};

export async function POST(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireManager(request, "POST /api/receipts/[id]/retention-hold");
    const body = (await readJson(request)) as HoldBody;
    if (typeof body.hold !== "boolean") {
      throw new HttpError(400, "invalid_request", "hold must be a boolean");
    }
    if (body.hold && (typeof body.reason !== "string" || body.reason.trim() === "")) {
      throw new HttpError(400, "invalid_request", "hold reason is required");
    }

    const { data, error } = await supabase.rpc("set_retention_hold", {
      p_receipt_id: id,
      p_hold: body.hold,
      p_reason: typeof body.reason === "string" ? body.reason : null,
      p_correlation_id: randomUUID(),
    });
    if (error) {
      throw rpcHttpError(error);
    }
    return Response.json(data);
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON");
  }
}
