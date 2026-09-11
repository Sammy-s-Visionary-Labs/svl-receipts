import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { closeExportForManualHandling } from "@/lib/housecall/resolution";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReviewBody, validId } from "@/lib/manager/review-request";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { actor } = await requireAdmin(
      request,
      "POST close Housecall export for manual handling",
    );
    const { id } = await context.params;
    validId(id);
    const body = await readReviewBody(request);
    if (typeof body.intentId !== "string")
      throw new HttpError(400, "invalid_request", "An export intent is required.");
    validId(body.intentId);
    if (
      body.confirmStop !== true ||
      typeof body.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.payloadHash) ||
      typeof body.reason !== "string" ||
      !body.reason.trim() ||
      body.reason.length > 2000
    )
      throw new HttpError(
        400,
        "invalid_request",
        "Confirm stopping the export and provide a reason.",
      );
    return Response.json(
      await closeExportForManualHandling({
        actorId: actor.userId,
        receiptId: id,
        intentId: body.intentId as string,
        payloadHash: body.payloadHash,
        reason: body.reason.trim(),
      }),
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const response =
      error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
    response.headers.set("cache-control", "private, no-store");
    return response;
  }
}
