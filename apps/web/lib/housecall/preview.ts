import { extendedCostCents } from "@svl/domain";
import { isHousecallQuantitySupported } from "@svl/integrations";

export type PreviewStepRow = {
  id: string;
  housecall_job_id: string;
  step: string;
  status: string;
  external_id: string | null;
  payload: unknown;
};
export type HousecallExportPreview = {
  receiptId: string;
  intentId: string | null;
  payloadHash: string | null;
  previewOnly: true;
  liveWritesEnabled: boolean;
  separateApprovalRequired: boolean;
  taxExcluded: true;
  totalMaterialCostCents: number;
  blockedReasons: string[];
  closedForManualHandling?: boolean;
  jobs: Array<{
    id: string;
    label: string;
    destinationAllowed: boolean;
    unavailable: boolean;
    materialCostCents: number;
    images: Array<{ stepId: string; pageIndex: number; status: string; externalId: string | null }>;
    lines: Array<{
      stepId: string;
      description: string;
      qty: number;
      uom: string | null;
      unitCostCents: number;
      extendedCostCents: number;
      status: string;
      externalId: string | null;
    }>;
  }>;
};

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid_export_preview");
  return value as Record<string, unknown>;
}
const knownStatuses = new Set([
  "ready",
  "in_progress",
  "reconcile_required",
  "succeeded",
  "retryable_failure",
  "permanent_failure",
]);

/** Project the frozen plan; never return the database payload or storage location. */
export function buildHousecallExportPreview(input: {
  receiptId: string;
  intent: { id: string; payload_hash: string | null; attachment_job_ids: unknown } | null;
  steps: PreviewStepRow[];
  catalog: Array<{ id: string; label: string; unavailable?: boolean }>;
  allowedJobIds: ReadonlySet<string>;
  allJobs?: boolean;
  separateApprovalRequired?: boolean;
  liveWritesEnabled: boolean;
}): HousecallExportPreview {
  const result: HousecallExportPreview = {
    receiptId: input.receiptId,
    intentId: input.intent?.id ?? null,
    payloadHash: input.intent?.payload_hash ?? null,
    previewOnly: true,
    liveWritesEnabled: input.liveWritesEnabled,
    separateApprovalRequired: input.separateApprovalRequired ?? true,
    taxExcluded: true,
    totalMaterialCostCents: 0,
    blockedReasons: [],
    jobs: [],
  };
  if (!input.intent) {
    result.blockedReasons.push("no_current_intent");
    return result;
  }
  if (!input.liveWritesEnabled) result.blockedReasons.push("live_writes_disabled");
  if (!input.intent.payload_hash) result.blockedReasons.push("missing_frozen_plan");
  else if (!/^[a-f0-9]{64}$/.test(input.intent.payload_hash))
    throw new Error("invalid_export_preview");
  if (
    !Array.isArray(input.intent.attachment_job_ids) ||
    input.intent.attachment_job_ids.length > 100 ||
    !input.intent.attachment_job_ids.every((id) => typeof id === "string" && id.length > 0)
  )
    throw new Error("invalid_export_preview");
  const ids = [...new Set(input.intent.attachment_job_ids as string[])];
  if (ids.length !== input.intent.attachment_job_ids.length)
    throw new Error("invalid_export_preview");
  result.jobs = ids.map((id) => {
    const job = input.catalog.find((item) => item.id === id);
    return {
      id,
      label: job?.label || "Job label unavailable",
      destinationAllowed: input.allJobs === true || input.allowedJobIds.has(id),
      unavailable: job?.unavailable === true,
      materialCostCents: 0,
      images: [],
      lines: [],
    };
  });
  const stepIds = new Set<string>();
  for (const step of input.steps) {
    const job = result.jobs.find((item) => item.id === step.housecall_job_id);
    if (!job || stepIds.has(step.id) || !knownStatuses.has(step.status))
      throw new Error("invalid_export_preview");
    stepIds.add(step.id);
    const payload = record(step.payload);
    if (step.step === "attachment") {
      const image = record(payload.image);
      if (
        !Number.isInteger(image.page_index) ||
        (image.page_index as number) < 0 ||
        (image.page_index as number) > 4 ||
        job.images.some((item) => item.pageIndex === image.page_index)
      )
        throw new Error("invalid_export_preview");
      job.images.push({
        stepId: step.id,
        pageIndex: image.page_index as number,
        status: step.status,
        externalId: step.external_id,
      });
    } else if (step.step === "job_cost") {
      const line = record(payload.line);
      if (
        typeof line.description !== "string" ||
        typeof line.qty !== "number" ||
        typeof line.unit_cost_cents !== "number" ||
        typeof line.extended_cost_cents !== "number" ||
        extendedCostCents(line.qty, line.unit_cost_cents) !== line.extended_cost_cents
      )
        throw new Error("invalid_export_preview");
      job.lines.push({
        stepId: step.id,
        description: line.description,
        qty: line.qty,
        uom: typeof line.uom === "string" ? line.uom : null,
        unitCostCents: line.unit_cost_cents,
        extendedCostCents: line.extended_cost_cents,
        status: step.status,
        externalId: step.external_id,
      });
      job.materialCostCents += line.extended_cost_cents;
      result.totalMaterialCostCents += line.extended_cost_cents;
      if (result.totalMaterialCostCents > 2147483647) throw new Error("invalid_export_preview");
    } else throw new Error("invalid_export_preview");
  }
  if (!result.jobs.length || result.jobs.some((job) => !job.images.length || !job.lines.length))
    result.blockedReasons.push("incomplete_frozen_plan");
  if (result.jobs.some((job) => !job.destinationAllowed))
    result.blockedReasons.push("destination_not_approved");
  if (result.jobs.some((job) => job.lines.some((line) => !isHousecallQuantitySupported(line.qty))))
    result.blockedReasons.push("unsupported_quantity_precision");
  if (result.jobs.some((job) => job.unavailable))
    result.blockedReasons.push("destination_unavailable");
  for (const job of result.jobs) job.images.sort((a, b) => a.pageIndex - b.pageIndex);
  return result;
}
