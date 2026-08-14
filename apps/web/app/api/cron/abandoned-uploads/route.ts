import { ABANDONED_UPLOAD_MAX_AGE_HOURS } from "@svl/domain";
import { authErrorResponse } from "@/lib/auth/guards";
import { requireCronSecret } from "@/lib/cron/secret";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { removeReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

type AbandonedRow = {
  id: string;
  storage_key: string | null;
};

async function cleanupAbandonedUploads(request: Request) {
  try {
    requireCronSecret(request);
    const supabase = createServiceRoleClient();
    const cutoff = new Date(
      Date.now() - ABANDONED_UPLOAD_MAX_AGE_HOURS * 60 * 60 * 1000,
    ).toISOString();

    const { data, error } = await supabase
      .from("receipts")
      .select("id, storage_key")
      .eq("status", "upload_pending")
      .lt("created_at", cutoff)
      .limit(100);

    if (error) {
      console.error("[abandoned-upload-cleanup]", error);
      throw new HttpError(500, "internal", "Request failed");
    }

    const rows = (data ?? []) as AbandonedRow[];
    let deleted = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        if (row.storage_key) {
          await removeReceiptObject(row.storage_key);
        }
        const { error: deleteError } = await supabase.rpc("delete_abandoned_upload", {
          p_receipt_id: row.id,
        });
        if (deleteError) {
          throw deleteError;
        }
        deleted += 1;
      } catch (cause) {
        console.error("[abandoned-upload-cleanup]", { receiptId: row.id, cause });
        failed += 1;
      }
    }

    console.info("[abandoned-upload-cleanup]", { deleted, failed });
    return Response.json({ deleted, failed });
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

export async function GET(request: Request) {
  return cleanupAbandonedUploads(request);
}

export async function POST(request: Request) {
  return cleanupAbandonedUploads(request);
}
