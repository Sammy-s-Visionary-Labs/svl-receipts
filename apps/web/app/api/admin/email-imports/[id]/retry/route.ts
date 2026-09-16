import { after } from "next/server";
import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { runEmailImportBatch } from "@/lib/email/importer";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export const maxDuration = 180;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin(request, "POST retry email");
    const { id } = await context.params;
    validId(id);
    const result = await createServiceRoleClient()
      .from("email_receipt_imports")
      .update({
        status: "queued",
        attempts: 0,
        last_error: null,
        next_attempt_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "needs_attention")
      .select("id");
    if (result.error) throw result.error;
    if (!result.data?.length)
      throw new HttpError(409, "conflict", "This email is not awaiting a retry.");
    after(async () => {
      try {
        await runEmailImportBatch(id);
      } catch {
        console.error("[email-import] retry deferred");
      }
    });
    return Response.json({ ok: true });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
