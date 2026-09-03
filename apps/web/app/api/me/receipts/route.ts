import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import {
  decodeRecentReceiptCursor,
  encodeRecentReceiptCursor,
  normalizeReadability,
  RECENT_RECEIPT_LIMIT,
  type ReadabilityRow,
  recentReceiptCursorFilter,
  workerStatusForStoredReceipt,
} from "@/lib/receipts/worker-history";
import { createReceiptReadTargets } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

type ReceiptRow = {
  id: string;
  status: string;
  submitted_at: string;
};

type PageRow = {
  receipt_id: string;
  page_index: number;
  storage_key: string;
};

export async function GET(request: Request) {
  try {
    const { actor, supabase } = await requireActor(request, "GET /api/me/receipts");
    const cursorValue = new URL(request.url).searchParams.get("cursor");
    const cursor = cursorValue === null ? null : decodeRecentReceiptCursor(cursorValue);
    if (cursorValue !== null && cursor === null) {
      return invalidCursorResponse();
    }

    let query = supabase
      .from("receipts")
      .select("id, status, submitted_at")
      .eq("owner_user_id", actor.userId)
      .not("submitted_at", "is", null);
    if (cursor) {
      query = query.or(recentReceiptCursorFilter(cursor));
    }
    const { data, error } = await query
      .order("submitted_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(RECENT_RECEIPT_LIMIT + 1);
    if (error) {
      throw error;
    }

    const fetched = (data ?? []) as ReceiptRow[];
    const hasMore = fetched.length > RECENT_RECEIPT_LIMIT;
    const receipts = fetched.slice(0, RECENT_RECEIPT_LIMIT);
    const receiptIds = receipts.map((receipt) => receipt.id);
    const latestByReceipt = new Map<string, ReadabilityRow>();
    const pagesByReceipt = new Map<string, PageRow[]>();
    const service = createServiceRoleClient();

    if (receiptIds.length > 0) {
      const [{ data: checks, error: checksError }, { data: pages, error: pagesError }] =
        await Promise.all([
          service
            .from("readability_checks")
            .select("receipt_id, readable, failed_page_indexes, reasons, created_at")
            .in("receipt_id", receiptIds)
            .order("created_at", { ascending: false }),
          service
            .from("receipt_pages")
            .select("receipt_id, page_index, storage_key")
            .in("receipt_id", receiptIds)
            .not("confirmed_at", "is", null)
            .order("page_index", { ascending: true }),
        ]);
      if (checksError) {
        throw checksError;
      }
      if (pagesError) {
        throw pagesError;
      }
      for (const check of (checks ?? []) as ReadabilityRow[]) {
        if (!latestByReceipt.has(check.receipt_id)) {
          latestByReceipt.set(check.receipt_id, check);
        }
      }
      for (const page of (pages ?? []) as PageRow[]) {
        const current = pagesByReceipt.get(page.receipt_id) ?? [];
        current.push(page);
        pagesByReceipt.set(page.receipt_id, current);
      }
    }

    const thumbnailKeys = receipts.flatMap((receipt) => {
      const firstPage = pagesByReceipt.get(receipt.id)?.find((page) => page.page_index === 0);
      return firstPage ? [firstPage.storage_key] : [];
    });
    const thumbnailTargets = await createReceiptReadTargets(thumbnailKeys);
    const lastReceipt = receipts.at(-1);

    return Response.json(
      {
        receipts: receipts.map((receipt) => {
          const pages = pagesByReceipt.get(receipt.id) ?? [];
          const firstPage = pages.find((page) => page.page_index === 0);
          const target = firstPage ? thumbnailTargets.get(firstPage.storage_key) : undefined;
          return {
            id: receipt.id,
            status: receipt.status,
            workerStatus: workerStatusForStoredReceipt(receipt.status),
            submittedAt: receipt.submitted_at,
            pageCount: pages.length,
            thumbnail: target ? { url: target.url, expiresAt: target.expiresAt } : null,
            readability: normalizeReadability(latestByReceipt.get(receipt.id)),
          };
        }),
        nextCursor:
          hasMore && lastReceipt
            ? encodeRecentReceiptCursor({
                submittedAt: lastReceipt.submitted_at,
                id: lastReceipt.id,
              })
            : null,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

function invalidCursorResponse() {
  return Response.json(
    { error: { code: "invalid_request", message: "Receipt history cursor is invalid" } },
    { status: 400, headers: { "cache-control": "private, no-store" } },
  );
}
