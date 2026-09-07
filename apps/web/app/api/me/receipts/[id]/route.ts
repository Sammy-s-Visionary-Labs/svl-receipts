import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import { HttpError, httpErrorResponse } from "@/lib/http";
import {
  normalizeReadability,
  type ReadabilityRow,
  workerStatusForStoredReceipt,
} from "@/lib/receipts/worker-history";
import { createReceiptReadTargets } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

type RouteContext = { params: Promise<{ id: string }> };

type ReceiptRow = {
  id: string;
  status: string;
  submitted_at: string;
  clarification_reason?: string | null;
  content_deleted_at?: string | null;
  purge_claimed_at?: string | null;
};

type PageRow = {
  page_index: number;
  storage_key: string;
};

export async function GET(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { actor, supabase } = await requireActor(request, "GET /api/me/receipts/[id]");
    const { data, error } = await supabase
      .from("receipts")
      .select(
        "id, status, submitted_at, clarification_reason, content_deleted_at, purge_claimed_at",
      )
      .eq("id", id)
      .eq("owner_user_id", actor.userId)
      .not("submitted_at", "is", null)
      .maybeSingle();
    if (error) {
      throw error;
    }
    if (!data) {
      throw new HttpError(404, "not_found", "Receipt is not available");
    }
    const receipt = data as ReceiptRow;
    if (receipt.content_deleted_at || receipt.purge_claimed_at)
      throw new HttpError(404, "not_found", "Receipt content is not available");
    const service = createServiceRoleClient();
    const [{ data: pagesData, error: pagesError }, { data: readabilityData, error: checkError }] =
      await Promise.all([
        service
          .from("receipt_pages")
          .select("page_index, storage_key")
          .eq("receipt_id", receipt.id)
          .not("confirmed_at", "is", null)
          .order("page_index", { ascending: true }),
        service
          .from("readability_checks")
          .select("receipt_id, readable, failed_page_indexes, reasons, created_at")
          .eq("receipt_id", receipt.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
    if (pagesError) {
      throw pagesError;
    }
    if (checkError) {
      throw checkError;
    }
    const pages = (pagesData ?? []) as PageRow[];
    const imageTargets = await createReceiptReadTargets(pages.map((page) => page.storage_key));
    if (pages.some((page) => !imageTargets.has(page.storage_key))) {
      throw new Error("receipt_page_signing_failed");
    }

    return Response.json(
      {
        id: receipt.id,
        workerStatus: workerStatusForStoredReceipt(receipt.status),
        submittedAt: receipt.submitted_at,
        ...(receipt.clarification_reason ? { clarification: receipt.clarification_reason } : {}),
        pages: pages.map((page) => {
          const target = imageTargets.get(page.storage_key);
          if (!target) {
            throw new Error("receipt_page_signing_failed");
          }
          return {
            pageIndex: page.page_index,
            image: { url: target.url, expiresAt: target.expiresAt },
          };
        }),
        readability: normalizeReadability(readabilityData as ReadabilityRow | null),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}
