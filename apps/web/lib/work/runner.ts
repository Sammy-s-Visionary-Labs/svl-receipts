import { WORK_LEASE_SECONDS } from "@svl/domain";
import { removeReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

const WORKER_ID = "vercel-cron";

export type WorkRow = {
  id: string;
  receipt_id: string;
  kind: string;
};

export async function runWorkBatch(limit = 20): Promise<{
  claimed: number;
  completed: number;
  failed: number;
}> {
  const supabase = createServiceRoleClient();
  const { error: enqueueError } = await supabase.rpc("enqueue_due_purges");
  if (enqueueError) {
    console.error("[work-runner] enqueue_due_purges", enqueueError);
  }

  const { data, error } = await supabase.rpc("claim_work", {
    p_worker_id: WORKER_ID,
    p_limit: limit,
    p_lease_seconds: WORK_LEASE_SECONDS,
  });
  if (error) {
    console.error("[work-runner] claim_work", error);
    throw error;
  }

  const rows = (data ?? []) as WorkRow[];
  let completed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const { error: startError } = await supabase.rpc("start_queued_work", {
        p_work_id: row.id,
        p_worker_id: WORKER_ID,
      });
      if (startError) {
        throw startError;
      }

      if (row.kind === "purge") {
        const { data: receipt } = await supabase
          .from("receipts")
          .select("storage_key")
          .eq("id", row.receipt_id)
          .maybeSingle();
        const storageKey = (receipt as { storage_key: string | null } | null)?.storage_key;
        if (storageKey) {
          await removeReceiptObject(storageKey);
        }
        const { error: purgeError } = await supabase.rpc("purge_receipt_content", {
          p_receipt_id: row.receipt_id,
          p_worker_id: WORKER_ID,
        });
        if (purgeError) {
          throw purgeError;
        }
      }

      const { error: completeError } = await supabase.rpc("complete_work", {
        p_work_id: row.id,
        p_worker_id: WORKER_ID,
      });
      if (completeError) {
        throw completeError;
      }
      completed += 1;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message.slice(0, 500) : "worker_failure";
      const { error: failError } = await supabase.rpc("fail_work", {
        p_work_id: row.id,
        p_worker_id: WORKER_ID,
        p_reason: reason,
        p_retryable: true,
      });
      if (failError) {
        console.error("[work-runner] fail_work", failError);
      }
      failed += 1;
    }
  }

  return { claimed: rows.length, completed, failed };
}
