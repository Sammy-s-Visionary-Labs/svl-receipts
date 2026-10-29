import { AuthHttpError } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";
import type { LaborManualCorrection } from "./correction-contract";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !uuid.test(value)) throw new Error(`${label} is required.`);
  return value;
}
function manager(value: string): string {
  if (!uuid.test(value))
    throw new AuthHttpError(
      403,
      "real_manager_required",
      "A signed-in manager account is required.",
    );
  return value;
}
function requiredText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max)
    throw new Error(`${label} must contain ${min}–${max} characters.`);
  return value.trim();
}
function parse(value: unknown): LaborManualCorrection {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    typeof value.approval_id !== "string" ||
    !uuid.test(value.approval_id) ||
    typeof value.snapshot_hash !== "string" ||
    !hash.test(value.snapshot_hash) ||
    typeof value.recorded_by !== "string" ||
    !uuid.test(value.recorded_by) ||
    typeof value.recorded_at !== "string" ||
    !Number.isFinite(Date.parse(value.recorded_at)) ||
    typeof value.reason !== "string" ||
    value.reason.trim().length < 10 ||
    value.reason.length > 2000 ||
    typeof value.provider_reference !== "string" ||
    !value.provider_reference.trim() ||
    value.provider_reference.length > 500 ||
    typeof value.evidence !== "string" ||
    value.evidence.trim().length < 10 ||
    value.evidence.length > 4000
  )
    throw new AuthHttpError(
      503,
      "labor_correction_invalid_response",
      "Correction storage returned an invalid response. Refresh before retrying.",
    );
  return {
    id: value.id,
    approvalId: value.approval_id,
    snapshotHash: value.snapshot_hash,
    recordedBy: value.recorded_by,
    recordedAt: value.recorded_at,
    reason: value.reason,
    providerReference: value.provider_reference,
    evidence: value.evidence,
  };
}
async function rpc(name: string, args: Record<string, unknown>) {
  if (typeof window !== "undefined") throw new Error("Labor correction persistence is server-only");
  const { data, error } = await createServiceRoleClient().rpc(name, args);
  if (error) {
    const errors: Record<string, [number, string]> = {
      unauthenticated: [401, "Sign in with an active manager account."],
      forbidden: [403, "An active manager account is required."],
      labor_approval_not_found: [404, "Approval not found."],
      labor_correction_invalid_request: [400, "Review the required correction details."],
      labor_correction_conflict: [
        409,
        "This correction request was already used for different details. Refresh before recording a new resolution.",
      ],
      labor_approval_stale: [
        409,
        "The approval does not match the reviewed snapshot. Refresh its history.",
      ],
      labor_approval_invalid_status: [
        409,
        "Only sent or uncertain submissions can have a manual resolution recorded.",
      ],
      labor_approval_dispatch_busy: [
        409,
        "The send attempt is still active. Wait for it to finish before recording a resolution.",
      ],
    };
    const known = errors[error.message];
    throw new AuthHttpError(
      known?.[0] ?? 503,
      known ? error.message : "labor_correction_storage_failed",
      known?.[1] ?? "Correction storage could not confirm the action. Refresh before retrying.",
    );
  }
  return data as unknown;
}

export async function listLaborManualCorrections(approvalId: unknown, actorId: string) {
  const data = await rpc("read_labor_manual_corrections", {
    p_approval_id: identifier(approvalId, "Approval"),
    p_actor_id: manager(actorId),
  });
  if (!Array.isArray(data))
    throw new AuthHttpError(
      503,
      "labor_correction_invalid_response",
      "Correction history is unavailable.",
    );
  return { corrections: data.map(parse) };
}

export async function recordLaborManualCorrection(input: Record<string, unknown>, actorId: string) {
  manager(actorId);
  if (input.confirmed !== true)
    throw new Error("Confirm that you completed and checked the manual resolution in Housecall.");
  if (typeof input.expectedSnapshotHash !== "string" || !hash.test(input.expectedSnapshotHash))
    throw new Error("Review the saved approval before recording a manual resolution.");
  const data = await rpc("record_labor_manual_correction", {
    p_approval_id: identifier(input.approvalId, "Approval"),
    p_request_id: identifier(input.requestId, "Correction request ID"),
    p_snapshot_hash: input.expectedSnapshotHash,
    p_actor_id: actorId,
    p_reason: requiredText(input.reason, "Reason", 10, 2000),
    p_provider_reference: requiredText(input.providerReference, "Housecall reference", 1, 500),
    p_evidence: requiredText(input.evidence, "Resolution evidence", 10, 4000),
  });
  return { correction: parse(data) };
}
