import { randomUUID } from "node:crypto";
import {
  isHandledWorkKind,
  WORK_HANDLED_KINDS,
  WORK_LEASE_SECONDS,
  type WorkKind,
} from "@svl/domain";
import { removeReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type WorkRow = {
  id: string;
  receipt_id: string;
  kind: string;
};

function newWorkerId(): string {
  return `work:${randomUUID()}`;
}

export async function kickWork(kind: WorkKind): Promise<{
  claimed: number;
  completed: number;
  failed: number;
  skipped?: string;
}> {
  if (!isHandledWorkKind(kind)) {
    return { claimed: 0, completed: 0, failed: 0, skipped: `${kind}_unimplemented` };
  }
  return runWorkBatch({ kinds: [kind] });
}

export async function runWorkBatch(input?: { limit?: number; kinds?: WorkKind[] }): Promise<{
  claimed: number;
  completed: number;
  failed: number;
}> {
  const kinds = input?.kinds ?? [...WORK_HANDLED_KINDS];
  const limit = input?.limit ?? 20;
  const workerId = newWorkerId();
  const supabase = createServiceRoleClient();

  if (kinds.includes("purge")) {
    const { error: enqueueError } = await supabase.rpc("enqueue_due_purges");
    if (enqueueError) {
      console.error("[work-runner] enqueue_due_purges", enqueueError);
    }
  }

  const { data, error } = await supabase.rpc("claim_work", {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: WORK_LEASE_SECONDS,
    p_kinds: kinds,
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
      if (!isHandledWorkKind(row.kind)) {
        throw new Error(`unhandled_work_kind:${row.kind}`);
      }

      const { error: startError } = await supabase.rpc("start_queued_work", {
        p_work_id: row.id,
        p_worker_id: workerId,
      });
      if (startError) {
        throw startError;
      }

      if (row.kind === "purge") {
        await runPurge(supabase, row, workerId);
      }

      const { error: completeError } = await supabase.rpc("complete_work", {
        p_work_id: row.id,
        p_worker_id: workerId,
      });
      if (completeError) {
        throw completeError;
      }
      completed += 1;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message.slice(0, 500) : "worker_failure";
      const { error: failError } = await supabase.rpc("fail_work", {
        p_work_id: row.id,
        p_worker_id: workerId,
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

async function runPurge(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: WorkRow,
  workerId: string,
) {
  const { error: renewError } = await supabase.rpc("renew_work_lease", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_lease_seconds: WORK_LEASE_SECONDS,
  });
  if (renewError) {
    throw renewError;
  }

  const { data: eligible, error: eligibleError } = await supabase.rpc("assert_purge_eligible", {
    p_receipt_id: row.receipt_id,
    p_worker_id: workerId,
  });
  if (eligibleError) {
    throw eligibleError;
  }

  const snapshot = eligible as {
    storageKey?: string | null;
    alreadyPurged?: boolean;
  } | null;
  if (snapshot?.alreadyPurged) {
    return;
  }

  const storageKey = snapshot?.storageKey;
  if (storageKey) {
    await removeReceiptObject(storageKey);
  }

  const { error: purgeError } = await supabase.rpc("purge_receipt_content", {
    p_receipt_id: row.receipt_id,
    p_worker_id: workerId,
  });
  if (purgeError) {
    throw purgeError;
  }
}
