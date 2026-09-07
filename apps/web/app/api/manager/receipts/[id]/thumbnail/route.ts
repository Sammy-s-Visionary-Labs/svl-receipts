import { MAX_RECEIPT_BYTES } from "@svl/domain";
import { AuthHttpError, authErrorResponse, requireManager } from "@/lib/auth/guards";
import { renderReceiptThumbnail } from "@/lib/manager/thumbnail";
import { createReceiptReadUrl } from "@/lib/storage/receipts";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { supabase } = await requireManager(request, "GET /api/manager/receipts/[id]/thumbnail");
    const { id } = await context.params;
    if (!UUID.test(id)) return unavailable();

    // Both lookups use the authenticated client and the existing RLS policies.
    const { data: receipt, error: receiptError } = await supabase
      .from("receipts")
      .select("id")
      .eq("id", id)
      .not("submitted_at", "is", null)
      .is("content_deleted_at", null)
      .neq("status", "upload_pending")
      .maybeSingle();
    if (receiptError) throw receiptError;
    if (!receipt) return unavailable();

    const { data: page, error: pageError } = await supabase
      .from("receipt_pages")
      .select("storage_key, byte_size")
      .eq("receipt_id", id)
      .eq("page_index", 0)
      .not("confirmed_at", "is", null)
      .maybeSingle();
    if (pageError) throw pageError;
    if (!page?.storage_key || page.byte_size < 1 || page.byte_size > MAX_RECEIPT_BYTES) {
      return unavailable();
    }

    // Sign only after role and row checks. The URL and original bytes never reach the browser.
    const url = await createReceiptReadUrl(page.storage_key);
    const source = await fetch(url, {
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!source.ok || !source.body) {
      await source.body?.cancel();
      return unavailable();
    }
    const bytes = await readBoundedImage(source);
    const thumbnail = await renderReceiptThumbnail(bytes);
    return new Response(new Uint8Array(thumbnail), {
      headers: { ...PRIVATE_HEADERS, "content-type": "image/jpeg" },
    });
  } catch (error) {
    if (error instanceof AuthHttpError) {
      const response = authErrorResponse(error);
      for (const [name, value] of Object.entries(PRIVATE_HEADERS))
        response.headers.set(name, value);
      return response;
    }
    // A missing or malformed image must not break the queue or disclose Storage details.
    return unavailable();
  }
}

async function readBoundedImage(response: Response): Promise<Buffer> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > MAX_RECEIPT_BYTES) {
    await response.body?.cancel();
    throw new Error("thumbnail_input_invalid");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("thumbnail_input_missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECEIPT_BYTES) throw new Error("thumbnail_input_invalid");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function unavailable() {
  return Response.json(
    { error: { code: "image_unavailable", message: "Receipt preview is unavailable" } },
    { status: 404, headers: PRIVATE_HEADERS },
  );
}
