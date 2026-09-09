import { randomUUID } from "node:crypto";
import {
  isDeferablePurgeReason,
  isHandledWorkKind,
  persistableWorkReason,
  shouldReleasePurgeClaimAfterStorageFailure,
  WORK_HANDLED_KINDS,
  WORK_LEASE_SECONDS,
  type WorkKind,
} from "@svl/domain";
import {
  createGeminiReadabilityAdapter,
  ExpoPushError,
  GEMINI_READABILITY_MODEL,
  GeminiReadabilityError,
  type GeminiReadabilityPage,
  GeminiReceiptError,
  sendReceiptNeedsRetakePush,
} from "@svl/integrations";
import {
  ReceiptObjectSetRemovalError,
  readReceiptObject,
  removeReceiptObjectSet,
} from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { ExtractionDeferredError, runExtraction } from "./extraction";

export const READABILITY_PROVIDER_TIMEOUT_MS = 45_000;
export const WORK_REQUEST_BUDGET_MS = 160_000;
type WorkSummary = { claimed: number; completed: number; failed: number };

export type WorkRow = {
  id: string;
  receipt_id: string;
  kind: string;
  generation?: number;
};

function newWorkerId(): string {
  return `work:${randomUUID()}`;
}

class PurgeNotEligibleError extends Error {
  readonly code: "retention_hold" | "purge_not_eligible";

  constructor(code: "retention_hold" | "purge_not_eligible") {
    super(code);
    this.name = "PurgeNotEligibleError";
    this.code = code;
  }
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
  return runWorkBatch({ kinds: [kind], limit: 4 });
}

export async function runWorkBatch(input?: {
  limit?: number;
  kinds?: WorkKind[];
  deadlineAt?: number;
}): Promise<{
  claimed: number;
  completed: number;
  failed: number;
}> {
  const kinds = input?.kinds ?? [...WORK_HANDLED_KINDS];
  const deadlineAt = input?.deadlineAt ?? Date.now() + WORK_REQUEST_BUDGET_MS;
  // A serverless invocation must never fan out an unbounded provider batch.
  // Four concurrent stages fit inside the route budget. Accepted readability
  // results immediately continue for those same receipts; the daily cron is recovery.
  const limit = Math.min(Math.max(Math.trunc(input?.limit ?? 4), 1), 4);
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
  const summaries = await Promise.all(
    rows.map(async (row) => {
      const outcome = await processWorkRow(supabase, row, workerId, deadlineAt);
      const initial = summarize([row], [outcome]);
      if (row.kind !== "readability" || outcome !== "completed") return initial;
      try {
        // Continue this receipt before slow unrelated initial rows finish.
        const next = await runScopedStage(
          supabase,
          row.receipt_id,
          "extract",
          workerId,
          deadlineAt,
        );
        return totalWork([initial, next]);
      } catch {
        console.error("[work-runner] receipt extraction remains queued", {
          receiptId: row.receipt_id,
        });
        return initial;
      }
    }),
  );
  return totalWork(summaries);
}

function summarize(rows: WorkRow[], outcomes: Array<"completed" | "failed">): WorkSummary {
  return {
    claimed: rows.length,
    completed: outcomes.filter((outcome) => outcome === "completed").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
  };
}
function totalWork(summaries: WorkSummary[]): WorkSummary {
  return summaries.reduce(
    (total, item) => ({
      claimed: total.claimed + item.claimed,
      completed: total.completed + item.completed,
      failed: total.failed + item.failed,
    }),
    { claimed: 0, completed: 0, failed: 0 },
  );
}
async function runScopedStage(
  supabase: ReturnType<typeof createServiceRoleClient>,
  receiptId: string,
  kind: "readability" | "extract",
  workerId: string,
  deadlineAt: number,
): Promise<WorkSummary> {
  if (deadlineAt - Date.now() < 25_000) return { claimed: 0, completed: 0, failed: 0 };
  const { data, error } = await supabase.rpc("claim_receipt_work", {
    p_receipt_id: receiptId,
    p_worker_id: workerId,
    p_kind: kind,
    p_lease_seconds: WORK_LEASE_SECONDS,
  });
  if (error) throw error;
  const rows = (data ?? []) as WorkRow[];
  const outcomes = await Promise.all(
    rows.map((row) => processWorkRow(supabase, row, workerId, deadlineAt)),
  );
  return summarize(rows, outcomes);
}
/** Upload/re-extract kicks claim only the requested receipt. An accepted upload
 * proceeds to extraction in the same after() invocation, independent of backlog. */
export async function runReceiptWork(
  receiptId: string,
  kind: "readability" | "extract",
  input?: { deadlineAt?: number },
): Promise<WorkSummary> {
  const supabase = createServiceRoleClient();
  const workerId = newWorkerId();
  const deadlineAt = input?.deadlineAt ?? Date.now() + WORK_REQUEST_BUDGET_MS;
  const initial = await runScopedStage(supabase, receiptId, kind, workerId, deadlineAt);
  if (kind !== "readability" || initial.failed) return initial;
  // The scoped SQL claim requires retained accepted readability evidence. An
  // unreadable result or another live worker's unfinished stage returns no row.
  const extraction = await runScopedStage(supabase, receiptId, "extract", workerId, deadlineAt);
  return totalWork([initial, extraction]);
}

async function processWorkRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: WorkRow,
  workerId: string,
  deadlineAt: number,
): Promise<"completed" | "failed"> {
  try {
    if (!isHandledWorkKind(row.kind)) {
      throw new Error("unhandled_work_kind");
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
    } else if (row.kind === "extract") {
      await runExtraction(supabase, row, workerId, deadlineAt);
    } else if (row.kind === "readability") {
      await runReadability(supabase, row, workerId, deadlineAt);
    }

    const { error: completeError } = await supabase.rpc("complete_work", {
      p_work_id: row.id,
      p_worker_id: workerId,
    });
    if (completeError) {
      throw completeError;
    }
    return "completed";
  } catch (cause) {
    if (cause instanceof ExtractionDeferredError) {
      const { error: releaseError } = await supabase.rpc("release_receipt_work", {
        p_work_id: row.id,
        p_worker_id: workerId,
      });
      if (!releaseError) return "failed";
    }
    if (cause instanceof PurgeNotEligibleError) {
      const { error: deferError } = await supabase.rpc("defer_work", {
        p_work_id: row.id,
        p_worker_id: workerId,
        p_reason: cause.code,
      });
      if (!deferError) return "failed";
    }
    console.error("[work-runner] job failed", {
      workId: row.id,
      reason: persistableWorkReason(cause),
    });
    const { error: failError } = await supabase.rpc("fail_work", {
      p_work_id: row.id,
      p_worker_id: workerId,
      p_reason: persistableWorkReason(cause),
      p_retryable:
        !(cause instanceof GeminiReadabilityError || cause instanceof GeminiReceiptError) ||
        cause.kind === "retryable",
    });
    if (failError) {
      console.error("[work-runner] fail_work", failError);
    }
    return "failed";
  }
}

async function runReadability(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: WorkRow,
  workerId: string,
  deadlineAt: number,
) {
  const { data: existing, error: existingError } = await supabase
    .from("readability_checks")
    .select("id")
    .eq("work_item_id", row.id)
    .maybeSingle();
  if (existingError) {
    throw existingError;
  }
  if (existing) {
    return;
  }

  const { data: pages, error: pagesError } = await supabase
    .from("receipt_pages")
    .select("page_index, storage_key, content_type, confirmed_at")
    .eq("receipt_id", row.receipt_id)
    .order("page_index", { ascending: true });
  if (pagesError) {
    throw pagesError;
  }
  const confirmedPages = (pages ?? []) as Array<{
    page_index: number;
    storage_key: string;
    content_type: "image/jpeg" | "image/png" | "image/webp";
    confirmed_at: string | null;
  }>;
  if (
    confirmedPages.length === 0 ||
    confirmedPages.some((page, index) => page.confirmed_at === null || page.page_index !== index)
  ) {
    throw new GeminiReadabilityError("permanent", "invalid_page_set");
  }

  if (deadlineAt - Date.now() < 25_000) throw new ExtractionDeferredError();
  const providerPages: GeminiReadabilityPage[] = [];
  for (const page of confirmedPages) {
    const object = await readReceiptObject(page.storage_key);
    if (!object) {
      throw new Error("storage_object_missing");
    }
    providerPages.push({
      pageIndex: page.page_index,
      mimeType: page.content_type,
      bytes: object.bytes,
    });
  }

  const { error: renewError } = await supabase.rpc("renew_work_lease", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_lease_seconds: WORK_LEASE_SECONDS,
  });
  if (renewError) {
    throw renewError;
  }

  const provider = (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  if (provider !== "gemini" && provider !== "google_gemini") {
    throw new GeminiReadabilityError("permanent", "provider_not_configured");
  }
  const providerBudget = Math.min(
    READABILITY_PROVIDER_TIMEOUT_MS,
    deadlineAt - Date.now() - 15_000,
  );
  if (providerBudget < 10_000) throw new ExtractionDeferredError();
  const adapter = createGeminiReadabilityAdapter({
    apiKey: process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "",
    model: process.env.GEMINI_MODEL || GEMINI_READABILITY_MODEL,
    timeoutMs: providerBudget,
  });
  const result = await adapter.checkReadable(providerPages);

  const { error: resultError } = await supabase.rpc("record_readability_result", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_result: result.check,
    p_provider: result.provider,
    p_model: result.model,
    p_usage: result.usage,
  });
  if (resultError) {
    throw new GeminiReadabilityError("permanent", persistableWorkReason(resultError));
  }
  if (!result.check.readable) {
    await notifyReceiptNeedsRetake(supabase, row.receipt_id);
  }
}

async function notifyReceiptNeedsRetake(
  supabase: ReturnType<typeof createServiceRoleClient>,
  receiptId: string,
): Promise<void> {
  const { data: receipt, error: receiptError } = await supabase
    .from("receipts")
    .select("owner_user_id")
    .eq("id", receiptId)
    .maybeSingle();
  if (receiptError || !receipt) {
    console.error("[readability-push] owner lookup failed", { receiptId });
    return;
  }

  const ownerUserId = (receipt as { owner_user_id: string }).owner_user_id;
  const { data: device, error: deviceError } = await supabase
    .from("device_push_tokens")
    .select("expo_push_token")
    .eq("user_id", ownerUserId)
    .maybeSingle();
  if (deviceError) {
    console.error("[readability-push] token lookup failed", { receiptId });
    return;
  }
  if (!device) {
    return;
  }

  const pushToken = (device as { expo_push_token: string }).expo_push_token;
  try {
    await sendReceiptNeedsRetakePush({
      token: pushToken,
      receiptId,
      accessToken: process.env.EXPO_ACCESS_TOKEN,
    });
  } catch (cause) {
    const code = cause instanceof ExpoPushError ? cause.code : "push_unavailable";
    console.error("[readability-push] delivery failed", { receiptId, code });
    if (cause instanceof ExpoPushError && cause.code === "device_not_registered") {
      const { error: deleteError } = await supabase
        .from("device_push_tokens")
        .delete()
        .eq("user_id", ownerUserId)
        .eq("expo_push_token", pushToken);
      if (deleteError) {
        console.error("[readability-push] stale token removal failed", { receiptId });
      }
    }
  }
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
    if (isDeferablePurgeReason(eligibleError)) {
      const code = persistableWorkReason(eligibleError);
      throw new PurgeNotEligibleError(
        code === "retention_hold" ? "retention_hold" : "purge_not_eligible",
      );
    }
    throw eligibleError;
  }

  const snapshot = eligible as {
    storageKey?: string | null;
    alreadyPurged?: boolean;
  } | null;
  if (snapshot?.alreadyPurged) {
    return;
  }

  const { data: pages, error: pagesError } = await supabase
    .from("receipt_pages")
    .select("storage_key")
    .eq("receipt_id", row.receipt_id)
    .order("page_index", { ascending: true });
  if (pagesError) {
    throw pagesError;
  }
  const storageKeys = (pages ?? []).map((page) => page.storage_key);
  if (storageKeys.length === 0 && snapshot?.storageKey) {
    storageKeys.push(snapshot.storageKey);
  }
  try {
    await removeReceiptObjectSet(storageKeys);
  } catch (cause) {
    if (
      cause instanceof ReceiptObjectSetRemovalError &&
      shouldReleasePurgeClaimAfterStorageFailure(cause.existence)
    ) {
      const { error: releaseError } = await supabase.rpc("release_purge_claim", {
        p_receipt_id: row.receipt_id,
        p_worker_id: workerId,
      });
      if (releaseError) {
        console.error("[work-runner] release_purge_claim", releaseError);
      }
    }
    throw cause;
  }

  const { error: purgeError } = await supabase.rpc("purge_receipt_content", {
    p_receipt_id: row.receipt_id,
    p_worker_id: workerId,
  });
  if (purgeError) {
    throw purgeError;
  }
}
