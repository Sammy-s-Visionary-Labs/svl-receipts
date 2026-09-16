import { authErrorResponse, requireManager } from "@/lib/auth/guards";
import { EMAIL_MAILBOX } from "@/lib/email/config";
export async function GET(request: Request) {
  try {
    const { supabase } = await requireManager(request, "GET email imports");
    const health = await supabase
      .from("email_importer_health")
      .select("last_contact_at")
      .eq("singleton", true)
      .maybeSingle();
    if (health.error) throw health.error;
    const { data, error } = await supabase
      .from("email_receipt_imports")
      .select(
        "id,status,sender,subject,received_at,created_at,updated_at,last_error,raw_deleted_at,email_receipt_documents(receipt_id,filename)",
      )
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    return Response.json(
      {
        mailbox: EMAIL_MAILBOX,
        lastContactAt: health.data?.last_contact_at ?? null,
        configured: !!process.env.EMAIL_IMPORT_SECRET && !!process.env.EMAIL_IMPORT_OWNER_ID,
        imports: data ?? [],
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
