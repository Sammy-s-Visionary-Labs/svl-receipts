import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { EMAIL_BUCKET } from "@/lib/email/config";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { validId } from "@/lib/manager/review-request";
import { createServiceRoleClient } from "@/lib/supabase/service";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { supabase } = await requireManager(request, "GET original email");
    const { id } = await context.params;
    validId(id);
    const { data, error } = await supabase
      .from("email_receipt_imports")
      .select("id,raw_deleted_at")
      .eq("id", id)
      .maybeSingle();
    if (error || !data || data.raw_deleted_at)
      throw new HttpError(404, "not_found", "Email original unavailable.");
    const result = await createServiceRoleClient()
      .storage.from(EMAIL_BUCKET)
      .createSignedUrl(`${id}/original.eml`, 60, { download: "original-receipt-email.eml" });
    if (result.error) throw result.error;
    return new Response(null, {
      status: 303,
      headers: {
        location: result.data.signedUrl,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
