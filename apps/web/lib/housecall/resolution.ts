import type { HousecallClient } from "@svl/integrations";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError } from "@/lib/http";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { configuredHousecallClient, housecallConfiguration } from "./config";
import { type ExportStepRow, prepareExportStep } from "./export";

/** Read-only provider evidence. Closing an intent is an audited manual handoff,
 * never proof of successful export and never authorization to resend it. */
export async function closeExportForManualHandling(
  input: {
    actorId: string;
    receiptId: string;
    intentId: string;
    payloadHash: string;
    reason: string;
  },
  dependencies: {
    db?: ReturnType<typeof createServiceRoleClient>;
    client?: Pick<HousecallClient, "getJob" | "listJobInputMaterials">;
  } = {},
) {
  const config = housecallConfiguration();
  if (!config.readsEnabled)
    throw new HttpError(
      409,
      "reads_disabled",
      "Enable scoped Housecall reads to verify this export first.",
    );
  const db = dependencies.db ?? createServiceRoleClient();
  const { data: intent, error } = await db
    .from("housecall_intents")
    .select("id,payload_hash,attachment_job_ids")
    .eq("id", input.intentId)
    .eq("receipt_id", input.receiptId)
    .single();
  if (error) throw rpcHttpError(error);
  if (
    !intent ||
    intent.payload_hash !== input.payloadHash ||
    !Array.isArray(intent.attachment_job_ids) ||
    !intent.attachment_job_ids.length ||
    !intent.attachment_job_ids.every((id: string) => config.allowedJobIds.has(id))
  )
    throw new HttpError(409, "conflict", "The frozen export or allowed destinations changed.");
  const { data: rows, error: stepError } = await db
    .from("housecall_export_steps")
    .select("*")
    .eq("intent_id", input.intentId)
    .eq("receipt_id", input.receiptId)
    .order("id")
    .limit(601);
  if (stepError) throw rpcHttpError(stepError);
  if (
    !rows?.length ||
    rows.length > 600 ||
    rows.some(
      (step) => step.status === "in_progress" || !config.allowedJobIds.has(step.housecall_job_id),
    )
  )
    throw new HttpError(409, "conflict", "Wait for active export work before manual resolution.");
  const client =
    dependencies.client ?? configuredHousecallClient(15_000, `receipt-${input.receiptId}`);
  const evidence = [];
  for (const jobId of intent.attachment_job_ids as string[]) {
    const job = await client.getJob(jobId, { includeAttachments: true });
    const materials = await client.listJobInputMaterials(jobId);
    if (job.id !== jobId || !Array.isArray(job.attachments))
      throw new HttpError(409, "conflict", "Housecall returned an unexpected destination.");
    for (const row of rows.filter((step) => step.housecall_job_id === jobId)) {
      const step = row as ExportStepRow & {
        updated_at: string;
        dispatch_count: number;
        external_id: string | null;
      };
      let matches: Array<{ id: string | null; [key: string]: unknown }>;
      if (step.step === "attachment") {
        const image = step.payload.image;
        if (!image) throw new HttpError(409, "conflict", "Frozen image metadata is missing.");
        const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[
          image.content_type
        ];
        const fileName = `svl-${step.receipt_id}-${step.intent_id}-${image.page_id}-${image.checksum}.${extension}`;
        matches = job.attachments
          .filter((attachment) => attachment.fileName === fileName)
          .map(({ url: _url, ...attachment }) => attachment);
      } else {
        const write = await prepareExportStep(step);
        if (write.kind !== "job_cost") throw new Error("invalid_resolution_step");
        matches = materials.filter((material) => material.partNumber === write.reference);
      }
      if (
        matches.length > 1 ||
        (step.dispatch_count > 0 && !matches[0]?.id) ||
        (step.status === "succeeded" && matches[0]?.id !== step.external_id)
      )
        throw new HttpError(
          409,
          "reconciliation_required",
          "An uncertain or ambiguous provider result must be resolved before closing this export.",
        );
      evidence.push({
        step_id: step.id,
        payload_hash: step.payload_hash,
        updated_at: step.updated_at,
        job_id: jobId,
        observed_at: new Date().toISOString(),
        outcome: matches.length ? "present" : "absent",
        external_id: matches[0]?.id ?? null,
        observed: matches[0] ?? null,
      });
    }
  }
  const result = await db.rpc("close_housecall_export_for_manual_handling", {
    p_actor_id: input.actorId,
    p_receipt_id: input.receiptId,
    p_intent_id: input.intentId,
    p_payload_hash: input.payloadHash,
    p_reason: input.reason,
    p_evidence: evidence,
  });
  if (result.error) throw rpcHttpError(result.error);
  return result.data;
}
