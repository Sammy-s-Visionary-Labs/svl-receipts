import { MAX_RECEIPT_PAGES } from "@svl/domain";
import { createGeminiReceiptAdapter, GEMINI_RECEIPT_MODEL } from "@svl/integrations";
import { authErrorResponse, requireAdmin } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { readReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { normalizeExtractionPage } from "@/lib/work/extraction";

export const maxDuration = 180;
type Claim = { receiptId: string; leaseToken: string };
function cutoff(value: unknown) {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    Date.parse(value) > Date.now() + 300_000
  )
    throw new HttpError(400, "invalid_request", "Invalid classification cutoff.");
  return value;
}
function respond(body: unknown) {
  return Response.json(body, { headers: { "Cache-Control": "private, no-store" } });
}
async function status(db: ReturnType<typeof createServiceRoleClient>, before: string) {
  const result = await db.rpc("receipt_type_classification_status", { p_cutoff: before });
  if (result.error) throw result.error;
  return result.data;
}
export async function GET(request: Request) {
  try {
    await requireAdmin(request, "GET receipt type classification status");
    const before = cutoff(
      new URL(request.url).searchParams.get("cutoff") ?? new Date().toISOString(),
    );
    return respond({ cutoff: before, ...(await status(createServiceRoleClient(), before)) });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
async function classify(db: ReturnType<typeof createServiceRoleClient>, item: Claim) {
  const finish = async (result: Record<string, unknown>) => {
    const response = await db.rpc("finish_receipt_type_classification", {
      p_receipt_id: item.receiptId,
      p_lease_token: item.leaseToken,
      p_type: null,
      p_model: null,
      p_prompt_version: null,
      p_evidence: [],
      p_error: null,
      ...result,
    });
    if (response.error) throw response.error;
  };
  try {
    const { data, error } = await db
      .from("receipt_pages")
      .select("page_index,storage_key,confirmed_at")
      .eq("receipt_id", item.receiptId)
      .order("page_index");
    if (
      error ||
      !data?.length ||
      data.length > MAX_RECEIPT_PAGES ||
      data.some((page, index) => page.page_index !== index || !page.confirmed_at)
    )
      throw new Error("invalid_page_set");
    const pages = [];
    for (const page of data) {
      const object = await readReceiptObject(page.storage_key);
      if (!object) throw new Error("storage_object_missing");
      pages.push({
        pageIndex: page.page_index,
        mimeType: "image/jpeg" as const,
        bytes: await normalizeExtractionPage(object.bytes),
      });
    }
    const result = await createGeminiReceiptAdapter({
      apiKey: process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "",
      model: process.env.GEMINI_EXTRACTION_MODEL || GEMINI_RECEIPT_MODEL,
      timeoutMs: 65_000,
    }).parseReceipt(pages);
    const evidence = result.receipt.evidence.filter((item) => item.field === "receipt_type");
    const type = evidence.some((item) => item.confidence >= 0.75)
      ? (result.receipt.receipt_type ?? "unknown")
      : "unknown";
    await finish({
      p_type: type,
      p_model: result.model,
      p_prompt_version: result.promptVersion,
      p_evidence: evidence,
    });
  } catch {
    await finish({ p_error: "classification_failed" });
  }
}
export async function POST(request: Request) {
  try {
    const { actor } = await requireAdmin(request, "POST receipt type classification batch");
    const body = await request.json();
    const before = cutoff(body?.cutoff);
    const db = createServiceRoleClient();
    const claimed = await db.rpc("claim_receipt_type_classifications", {
      p_actor_id: actor.userId,
      p_cutoff: before,
      p_limit: 3,
    });
    if (claimed.error) throw claimed.error;
    const outcomes = await Promise.allSettled(
      ((claimed.data as Claim[]) ?? []).map((item) => classify(db, item)),
    );
    if (outcomes.some((item) => item.status === "rejected"))
      throw new Error("Classification persistence failed");
    return respond({
      cutoff: before,
      claimed: claimed.data?.length ?? 0,
      ...(await status(db, before)),
    });
  } catch (error) {
    return error instanceof HttpError ? httpErrorResponse(error) : authErrorResponse(error);
  }
}
