import { validateReview } from "@svl/domain";
import { after } from "next/server";
import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { housecallConfiguration } from "@/lib/housecall/config";
import { runReceiptHousecallExport } from "@/lib/housecall/export";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { parseDraft, readReviewBody, UUID, validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";

export const maxDuration = 180;

type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    validId(id);
    const { actor } = await requireManager(request, "POST manager review");
    const body = await readReviewBody(request);
    if (
      !["save_draft", "request_clarification", "decline", "mark_duplicate", "approve"].includes(
        String(body.decision),
      ) ||
      !Number.isSafeInteger(body.version) ||
      Number(body.version) < 0 ||
      (body.extractionId !== null &&
        (typeof body.extractionId !== "string" || !UUID.test(body.extractionId)))
    )
      throw new HttpError(400, "invalid_request", "Invalid review command");
    const draft = parseDraft(body.draft);
    const errors = validateReview(draft, body.decision === "approve");
    if (Object.keys(errors).length)
      return Response.json(
        {
          error: {
            code: "invalid_request",
            message: "Resolve the highlighted fields before approval",
          },
          fields: errors,
        },
        { status: 400 },
      );
    if (body.decision === "approve" && body.taxExcluded !== true)
      throw new HttpError(400, "invalid_request", "Confirm that tax is excluded");
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (
      reason.length > 2000 ||
      (["request_clarification", "decline", "mark_duplicate"].includes(String(body.decision)) &&
        !reason)
    )
      throw new HttpError(400, "invalid_request", "Enter a reason");
    const canonical = body.canonicalReceiptId ?? null;
    if (canonical !== null && (typeof canonical !== "string" || !UUID.test(canonical)))
      throw new HttpError(400, "invalid_request", "Enter a valid canonical receipt ID");
    const sessionId =
      body.decision === "approve" ? process.env.HOUSECALL_TEST_SESSION_ID?.trim() : undefined;
    if (sessionId && (!UUID.test(sessionId) || !housecallConfiguration().exportsEnabled))
      throw new HttpError(
        503,
        "test_export_unavailable",
        "Test export is not enabled. Your edits have not been submitted.",
      );
    const { data, error } = await createServiceRoleClient().rpc(
      sessionId ? "manager_review_with_test_export" : "manager_review_command",
      {
        ...(sessionId ? { p_session_id: sessionId } : {}),
        p_receipt_id: id,
        p_actor_id: actor.userId,
        p_version: body.version,
        p_extraction_id: body.extractionId,
        p_decision: body.decision,
        p_snapshot: draft,
        p_reason: reason || null,
        p_canonical_id: canonical,
      },
    );
    if (error) throw rpcHttpError(error);
    if (body.decision === "approve")
      after(async () => {
        try {
          await runReceiptHousecallExport(id);
        } catch {
          console.error("[manager-review] export kick failed; durable work remains queued");
        }
      });
    return Response.json(data, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
