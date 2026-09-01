import { isReadabilityReason, READABILITY_RETAKE_COPY, type ReadabilityReason } from "@svl/domain";
import { authErrorResponse, requireActor } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";

const RECENT_RECEIPT_LIMIT = 25;

type ReceiptRow = {
  id: string;
  status: string;
  submitted_at: string | null;
};

type ReadabilityRow = {
  receipt_id: string;
  readable: boolean;
  failed_page_indexes: number[];
  reasons: string[];
  created_at: string;
};

export async function GET(request: Request) {
  try {
    const { actor, supabase } = await requireActor(request, "GET /api/me/receipts");
    const { data, error } = await supabase
      .from("receipts")
      .select("id, status, submitted_at")
      .eq("owner_user_id", actor.userId)
      .not("submitted_at", "is", null)
      .order("submitted_at", { ascending: false })
      .limit(RECENT_RECEIPT_LIMIT);
    if (error) {
      throw error;
    }

    const receipts = (data ?? []) as ReceiptRow[];
    const receiptIds = receipts.map((receipt) => receipt.id);
    const latestByReceipt = new Map<string, ReadabilityRow>();
    if (receiptIds.length > 0) {
      const { data: checks, error: checksError } = await createServiceRoleClient()
        .from("readability_checks")
        .select("receipt_id, readable, failed_page_indexes, reasons, created_at")
        .in("receipt_id", receiptIds)
        .order("created_at", { ascending: false });
      if (checksError) {
        throw checksError;
      }
      for (const check of (checks ?? []) as ReadabilityRow[]) {
        if (!latestByReceipt.has(check.receipt_id)) {
          latestByReceipt.set(check.receipt_id, check);
        }
      }
    }

    return Response.json(
      {
        receipts: receipts.map((receipt) => ({
          id: receipt.id,
          status: receipt.status,
          submittedAt: receipt.submitted_at,
          readability: normalizeReadability(latestByReceipt.get(receipt.id)),
        })),
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

function normalizeReadability(check: ReadabilityRow | undefined) {
  if (!check) {
    return null;
  }
  const reasons = check.reasons.filter(isReadabilityReason);
  return {
    readable: check.readable,
    failedPageIndexes: check.failed_page_indexes.filter(
      (index) => Number.isInteger(index) && index >= 0,
    ),
    reasons: reasons.map((code: ReadabilityReason) => ({
      code,
      guidance: READABILITY_RETAKE_COPY[code],
    })),
    checkedAt: check.created_at,
  };
}
