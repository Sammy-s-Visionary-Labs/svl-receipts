import { randomUUID } from "node:crypto";
import {
  type HousecallClient,
  HousecallError,
  isHousecallQuantitySupported,
  type PreparedHousecallWrite,
  prepareAttachmentWrite,
  prepareMaterialWrite,
} from "@svl/integrations";
import { readReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { configuredHousecallClient, housecallConfiguration } from "./config";

export type ExportStepRow = {
  id: string;
  intent_id: string;
  receipt_id: string;
  housecall_job_id: string;
  step: "attachment" | "job_cost";
  receipt_page_id: string | null;
  receipt_line_id: string | null;
  payload_hash: string;
  lease_token: string;
  status: string;
  payload: {
    approved_reference?: string;
    image?: {
      page_id: string;
      storage_key: string;
      content_type: "image/jpeg" | "image/png" | "image/webp";
      checksum: string;
      byte_size: number;
    };
    line?: { receipt_line_id: string; description: string; qty: number; unit_cost_cents: number };
  };
};
type Db = ReturnType<typeof createServiceRoleClient>;
type Dependencies = {
  db?: Db;
  client?: HousecallClient;
  readObject?: typeof readReceiptObject;
  deadlineAt?: number;
  reconcileOnly?: boolean;
};
type Summary = { completed: number; unresolved: number; skipped?: string };

export async function prepareExportStep(
  step: ExportStepRow,
  readObject = readReceiptObject,
): Promise<PreparedHousecallWrite> {
  if (step.step === "job_cost") {
    const line = step.payload?.line;
    if (!line || line.receipt_line_id !== step.receipt_line_id)
      throw new Error("invalid_export_plan");
    return prepareMaterialWrite({
      jobId: step.housecall_job_id,
      intentId: step.intent_id,
      receiptId: step.receipt_id,
      receiptLineId: line.receipt_line_id,
      description: line.description,
      quantity: line.qty,
      unitCostCents: line.unit_cost_cents,
      approvedReference: step.payload.approved_reference,
    });
  }
  const image = step.payload?.image;
  if (!image || image.page_id !== step.receipt_page_id) throw new Error("invalid_export_plan");
  const object = await readObject(image.storage_key);
  if (!object || object.bytes.length !== image.byte_size) throw new Error("receipt_image_changed");
  const write = await prepareAttachmentWrite({
    jobId: step.housecall_job_id,
    intentId: step.intent_id,
    receiptId: step.receipt_id,
    pageId: image.page_id,
    bytes: object.bytes,
    contentType: image.content_type,
  });
  if (write.contentSha256 !== image.checksum) throw new Error("receipt_image_changed");
  return write;
}

async function finish(
  db: Db,
  step: ExportStepRow,
  outcome: string,
  input?: { externalId?: string; code?: string; evidence?: Record<string, unknown> },
) {
  const { error } = await db.rpc("finish_housecall_export_step", {
    p_step_id: step.id,
    p_lease_token: step.lease_token,
    p_outcome: outcome,
    p_external_id: input?.externalId ?? null,
    p_error_code: input?.code ?? null,
    p_evidence: {
      housecall_job_id: step.housecall_job_id,
      payload_hash: step.payload_hash,
      ...input?.evidence,
    },
  });
  if (error) throw error;
}

/** Claims one frozen step at a time. Uncertain dispatch is never permission to resend. */
export async function runReceiptHousecallExport(
  receiptId: string,
  input: Dependencies = {},
): Promise<Summary> {
  const config = housecallConfiguration();
  if (input.reconcileOnly ? !config.readsEnabled : !config.exportsEnabled)
    return { completed: 0, unresolved: 0, skipped: "live_writes_disabled" };
  const db = input.db ?? createServiceRoleClient();
  const { data: outbox, error: outboxError } = await db
    .from("housecall_outbox")
    .select("intent_id,status")
    .eq("receipt_id", receiptId)
    .maybeSingle();
  if (outboxError) throw outboxError;
  if (!outbox || outbox.status === "cancelled")
    return { completed: 0, unresolved: 0, skipped: "no_current_intent" };
  const { data: intent, error: intentError } = await db
    .from("housecall_intents")
    .select("id,payload_hash,attachment_job_ids,approved_images")
    .eq("id", outbox.intent_id)
    .single();
  if (intentError) throw intentError;
  // Validate the WHOLE receipt before the first claim/provider call. A forbidden
  // destination on a later line must not result in an earlier partial export.
  const jobs = intent?.attachment_job_ids;
  if (
    !intent?.payload_hash ||
    !Array.isArray(jobs) ||
    jobs.length === 0 ||
    !jobs.every((id) => typeof id === "string" && (config.allJobs || config.allowedJobIds.has(id)))
  )
    return { completed: 0, unresolved: 0, skipped: "destination_not_approved" };
  let approvalQuery = db
    .from("housecall_write_approvals")
    .select("job_ids,used_writes,max_writes,authorization_kind")
    .eq("intent_id", intent.id)
    .eq("payload_hash", intent.payload_hash)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString());
  if (config.mode === "manager_approved" && !input.reconcileOnly)
    approvalQuery = approvalQuery.eq("authorization_kind", "manager_review");
  const { data: approvals, error: approvalError } = await approvalQuery;
  if (approvalError) throw approvalError;
  const authorizedJobs = new Set(
    (approvals ?? []).filter((a) => a.used_writes < a.max_writes).flatMap((a) => a.job_ids),
  );
  // An exhausted approval still allows reconciliation reads below, but no new
  // dispatch; consume_housecall_write_approval remains the durable authority.
  if (!input.reconcileOnly && !approvals?.length)
    return { completed: 0, unresolved: 0, skipped: "explicit_approval_required" };
  if (!input.reconcileOnly) {
    // Check the whole immutable receipt before even its first attachment read
    // or claim. A later material must not strand earlier uploaded pages.
    const { data: materials, error } = await db
      .from("housecall_export_steps")
      .select("payload")
      .eq("intent_id", intent.id)
      .eq("step", "job_cost");
    if (error) throw error;
    if (!materials?.length)
      return { completed: 0, unresolved: 0, skipped: "incomplete_frozen_plan" };
    if (materials.some((row) => !isHousecallQuantitySupported(row.payload?.line?.qty)))
      return { completed: 0, unresolved: 0, skipped: "unsupported_quantity_precision" };
  }
  const client = input.client ?? configuredHousecallClient(12_000, `receipt-${receiptId}`, jobs);
  const deadlineAt = input.deadlineAt ?? Date.now() + 140_000;
  const workerId = `housecall:${randomUUID()}`;
  let completed = 0;
  for (let count = 0; count < 20 && deadlineAt - Date.now() > 55_000; count++) {
    const { data: claim, error: claimError } = await db.rpc("claim_housecall_export_step", {
      p_intent_id: intent.id,
      p_worker_id: workerId,
      p_lease_seconds: 120,
    });
    if (claimError) throw claimError;
    if (!claim) break;
    const step = claim.step as ExportStepRow;
    if (input.reconcileOnly && !claim.reconcileOnly) {
      await finish(db, step, "not_sent");
      break;
    }
    let dispatched = false;
    let outcomeRecorded = false;
    try {
      if (
        step.intent_id !== intent.id ||
        step.receipt_id !== receiptId ||
        !jobs.includes(step.housecall_job_id) ||
        (!config.allJobs && !config.allowedJobIds.has(step.housecall_job_id))
      )
        throw new Error("invalid_export_plan");
      const write = await prepareExportStep(step, input.readObject);
      const before = await client.reconcileWrite(write);
      if (before.status === "found") {
        await finish(db, step, "succeeded", {
          externalId: before.providerId,
          evidence: { verified: true, request_hash: write.requestHash },
        });
        completed++;
        continue;
      }
      if (before.status === "conflict" || claim.reconcileOnly) {
        await finish(db, step, "not_found", { code: "reconciliation_required" });
        return { completed, unresolved: 1 };
      }
      if (!authorizedJobs.has(step.housecall_job_id) || deadlineAt - Date.now() < 45_000) {
        await finish(db, step, "not_sent", { code: "live_write_approval_required" });
        return { completed, unresolved: 0, skipped: "explicit_approval_required" };
      }
      const { data: grant, error: grantError } = await db.rpc("consume_housecall_write_approval", {
        p_step_id: step.id,
        p_lease_token: step.lease_token,
      });
      if (grantError) {
        await finish(db, step, "not_sent", { code: "live_write_approval_required" });
        return { completed, unresolved: 0, skipped: "explicit_approval_required" };
      }
      // Durable dispatch begins before HTTP. Every failure from here is treated
      // conservatively, including losing the response to a committed write.
      dispatched = true;
      if (
        !grant ||
        grant.step_payload_hash !== step.payload_hash ||
        grant.payload_hash !== intent.payload_hash ||
        grant.step_id !== step.id ||
        !grant.job_ids?.includes(step.housecall_job_id) ||
        (config.mode === "manager_approved" &&
          (grant.authorization_kind !== "manager_review" ||
            typeof grant.job_bindings?.[step.housecall_job_id] !== "string"))
      )
        throw new Error("invalid_export_approval");
      await client.executePreparedWrite(write, {
        approvalId: `${grant.id}:${grant.used_writes}`,
        approvedBy: grant.approved_by,
        approvedAt: grant.dispatch_authorized_at ?? grant.created_at,
        expiresAt: grant.dispatch_expires_at ?? grant.expires_at,
        ...(grant.job_bindings?.[step.housecall_job_id]
          ? { expectedCustomerId: grant.job_bindings[step.housecall_job_id] }
          : {}),
        jobId: step.housecall_job_id,
        requestHash: write.requestHash,
      });
      const after = await client.reconcileWrite(write);
      if (after.status === "found") {
        await finish(db, step, "succeeded", {
          externalId: after.providerId,
          evidence: { verified: true, request_hash: write.requestHash },
        });
        outcomeRecorded = true;
        completed++;
      } else {
        await finish(db, step, "uncertain", { code: "reconciliation_required" });
        return { completed, unresolved: 1 };
      }
    } catch (error) {
      if (outcomeRecorded) throw error;
      const code = error instanceof HousecallError ? error.code : "export_verification_failed";
      // Even explicit 4xx bulk-write responses are kept uncertain until the live
      // contract proves partial creation cannot occur. No automatic write replay.
      await finish(db, step, dispatched || claim.reconcileOnly ? "uncertain" : "not_sent", {
        code,
      });
      return { completed, unresolved: 1 };
    }
  }
  return { completed, unresolved: 0 };
}

/** Cron/recovery visits only intents with recorded, unexpired human approvals. */
export async function runApprovedHousecallExports(input: Dependencies = {}): Promise<Summary> {
  if (!housecallConfiguration().exportsEnabled)
    return { completed: 0, unresolved: 0, skipped: "live_writes_disabled" };
  const db = input.db ?? createServiceRoleClient();
  const { data: outboxes, error } = await db.rpc("list_ready_housecall_exports", { p_limit: 20 });
  if (error) throw error;
  if (!outboxes?.length)
    return { completed: 0, unresolved: 0, skipped: "explicit_approval_required" };
  const deadlineAt = input.deadlineAt ?? Date.now() + 140_000;
  let completed = 0;
  let unresolved = 0;
  for (const row of outboxes ?? []) {
    if (deadlineAt - Date.now() < 55_000) break;
    const result = await runReceiptHousecallExport(row.receipt_id, { ...input, db, deadlineAt });
    completed += result.completed;
    unresolved += result.unresolved;
  }
  return { completed, unresolved };
}
