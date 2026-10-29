import { createHash } from "node:crypto";
import {
  canonicalLaborApprovalSnapshot,
  canonicalLaborWorkerName,
  type LaborApprovalSnapshot,
  normalizeLaborWorkerName,
} from "@svl/domain";
import { createServiceRoleClient } from "@/lib/supabase/service";

export type LaborApprovalStatus =
  | "approved"
  | "stale"
  | "sending"
  | "sent"
  | "failed"
  | "reconciliation_required"
  | "revoked";
export type LaborApprovalAttempt = {
  id: string;
  status: "claimed" | "dispatched" | "sent" | "failed" | "uncertain";
  sourceRevision: number;
  createdAt: string;
  expiresAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
};
export type LaborApprovalRecord = {
  id: string;
  snapshot: LaborApprovalSnapshot;
  snapshotHash: string;
  sourceRevision: number;
  status: LaborApprovalStatus;
  approvedBy: string;
  approvedAt: string;
  sentAt: string | null;
  lastError: string | null;
  providerReference: string | null;
  lastAttempt: LaborApprovalAttempt | null;
};
export type LaborApprovalSendClaim = {
  approval: LaborApprovalRecord;
  attempt: { id: string; leaseToken: string; expiresAt: string; sourceRevision: number };
};
export type LaborApprovalAttemptOutcome =
  | { status: "sent"; providerReference: string; responseHash?: string }
  | { status: "failed"; errorCode: string }
  | { status: "reconciliation_required"; errorCode?: string };
export type LaborApprovalReconciliationEvidence = {
  status: "sent" | "absent" | "unknown";
  providerReference?: string;
  responseHash?: string;
};

export class LaborApprovalPersistenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "LaborApprovalPersistenceError";
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const statuses = new Set([
  "approved",
  "stale",
  "sending",
  "sent",
  "failed",
  "reconciliation_required",
  "revoked",
]);
const knownErrors = new Set([
  "labor_approval_stale",
  "labor_approval_duplicate_interval",
  "labor_approval_not_found",
  "labor_approval_invalid_status",
  "labor_approval_dispatch_uncertain",
  "labor_approval_invalid_snapshot",
  "labor_approval_invalid_lease",
  "labor_approval_invalid_outcome",
  "unauthenticated",
  "forbidden",
]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function invalid(): never {
  throw new LaborApprovalPersistenceError("labor_approval_invalid_response");
}
function actor(value: string) {
  if (!uuid.test(value)) throw new LaborApprovalPersistenceError("unauthenticated");
}
function id(value: string) {
  if (!uuid.test(value)) throw new LaborApprovalPersistenceError("labor_approval_invalid_request");
}
function expected(value: number) {
  if (!integer(value)) throw new LaborApprovalPersistenceError("labor_approval_invalid_request");
}
function reference(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 500;
}
function responseHash(value: unknown) {
  if (value !== undefined && (typeof value !== "string" || !sha256.test(value)))
    throw new LaborApprovalPersistenceError("labor_approval_invalid_outcome");
}
function errorCode(value: unknown) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(value))
    throw new LaborApprovalPersistenceError("labor_approval_invalid_outcome");
}
async function rpc(name: string, args?: Record<string, unknown>) {
  if (typeof window !== "undefined") throw new Error("Labor approval persistence is server-only");
  const { data, error } = await createServiceRoleClient().rpc(name, args);
  if (error) {
    const code = knownErrors.has(error.message) ? error.message : "labor_approval_storage_failed";
    throw new LaborApprovalPersistenceError(code);
  }
  return data as unknown;
}
function parseRecord(value: unknown): LaborApprovalRecord {
  if (
    !object(value) ||
    typeof value.id !== "string" ||
    !uuid.test(value.id) ||
    !object(value.snapshot) ||
    value.snapshot.version !== 1 ||
    !Array.isArray(value.snapshot.entries) ||
    typeof value.snapshot_hash !== "string" ||
    !sha256.test(value.snapshot_hash) ||
    digest(canonicalLaborApprovalSnapshot(value.snapshot as LaborApprovalSnapshot)) !==
      value.snapshot_hash ||
    !integer(value.source_revision) ||
    typeof value.status !== "string" ||
    !statuses.has(value.status) ||
    typeof value.approved_by !== "string" ||
    !uuid.test(value.approved_by) ||
    typeof value.approved_at !== "string" ||
    !(value.sent_at === null || typeof value.sent_at === "string") ||
    !(value.last_error === null || typeof value.last_error === "string") ||
    !(value.provider_reference === null || reference(value.provider_reference))
  )
    invalid();
  let lastAttempt: LaborApprovalAttempt | null = null;
  if (value.last_attempt !== null) {
    const row = value.last_attempt;
    if (
      !object(row) ||
      typeof row.id !== "string" ||
      !uuid.test(row.id) ||
      !["claimed", "dispatched", "sent", "failed", "uncertain"].includes(String(row.status)) ||
      !integer(row.source_revision) ||
      typeof row.created_at !== "string" ||
      typeof row.expires_at !== "string" ||
      !(row.dispatched_at === null || typeof row.dispatched_at === "string") ||
      !(row.completed_at === null || typeof row.completed_at === "string")
    )
      invalid();
    lastAttempt = {
      id: row.id,
      status: row.status as LaborApprovalAttempt["status"],
      sourceRevision: row.source_revision,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      dispatchedAt: row.dispatched_at,
      completedAt: row.completed_at,
    };
  }
  return structuredClone({
    id: value.id,
    snapshot: value.snapshot as LaborApprovalSnapshot,
    snapshotHash: value.snapshot_hash,
    sourceRevision: value.source_revision,
    status: value.status as LaborApprovalStatus,
    approvedBy: value.approved_by,
    approvedAt: value.approved_at,
    sentAt: value.sent_at,
    lastError: value.last_error,
    providerReference: value.provider_reference,
    lastAttempt,
  });
}

export async function listSupabaseLaborApprovals(): Promise<LaborApprovalRecord[]> {
  const data = await rpc("read_labor_job_hour_approvals");
  if (!Array.isArray(data)) invalid();
  return data.map(parseRecord);
}
export async function createSupabaseLaborApproval(
  snapshot: LaborApprovalSnapshot,
  expectedRevision: number,
  actorId: string,
): Promise<LaborApprovalRecord> {
  actor(actorId);
  expected(expectedRevision);
  const intent = snapshot.providerIntent;
  const write = intent?.preparedWrite;
  const material = write?.body.job_input_materials[0];
  const estimate = snapshot.costEstimate;
  const approvedNames = snapshot.approvedWorkerNames;
  const costInteger = (value: unknown): value is number =>
    integer(value) && Number(value) <= 2_147_483_647;
  const sum = (
    field:
      | "sourceHourHundredths"
      | "paidHourHundredths"
      | "regularHourHundredths"
      | "overtimeHourHundredths"
      | "totalCostCents",
  ) => estimate?.workers.reduce((total, worker) => total + worker[field], 0);
  if (
    intent?.version !== 1 ||
    intent.destination !== "job_input_materials" ||
    intent.costTreatment !== "approved_total_cost" ||
    write?.kind !== "job_cost" ||
    write.jobId !== snapshot.housecallJobId ||
    write.method !== "PUT" ||
    write.path !== `/jobs/${snapshot.housecallJobId}/job_input_materials/bulk_update` ||
    !sha256.test(write.requestHash) ||
    write.body.job_input_materials.length !== 1 ||
    !material ||
    !estimate ||
    !Array.isArray(approvedNames) ||
    !approvedNames.length ||
    approvedNames.some((name) => !reference(name)) ||
    new Set(approvedNames.map(normalizeLaborWorkerName)).size !== approvedNames.length ||
    !estimate.policyVersion ||
    !Array.isArray(estimate.workers) ||
    !estimate.workers.length ||
    !Array.isArray(estimate.workerWeeks) ||
    !estimate.workerWeeks.length ||
    !costInteger(estimate.paidHourHundredths) ||
    !costInteger(estimate.regularHourHundredths) ||
    !costInteger(estimate.overtimeHourHundredths) ||
    !costInteger(estimate.totalCostCents) ||
    estimate.paidHourHundredths !==
      estimate.regularHourHundredths + estimate.overtimeHourHundredths ||
    estimate.paidHourHundredths > snapshot.totalHourHundredths ||
    estimate.workers.some(
      (worker) =>
        !reference(worker.workerName) ||
        !costInteger(worker.sourceHourHundredths) ||
        !costInteger(worker.paidHourHundredths) ||
        !costInteger(worker.regularHourHundredths) ||
        !costInteger(worker.overtimeHourHundredths) ||
        !costInteger(worker.totalCostCents) ||
        worker.paidHourHundredths !==
          worker.regularHourHundredths + worker.overtimeHourHundredths ||
        worker.paidHourHundredths > worker.sourceHourHundredths,
    ) ||
    estimate.workers.length !== approvedNames.length ||
    estimate.workers.some(
      (worker) =>
        !approvedNames.some(
          (name) => normalizeLaborWorkerName(name) === normalizeLaborWorkerName(worker.workerName),
        ),
    ) ||
    snapshot.entries.some(
      (entry) =>
        normalizeLaborWorkerName(entry.canonicalWorkerName ?? entry.workerName) !==
          normalizeLaborWorkerName(
            canonicalLaborWorkerName(entry.workerName, snapshot.workerAliases ?? []),
          ) ||
        !approvedNames.some(
          (name) =>
            normalizeLaborWorkerName(name) ===
            normalizeLaborWorkerName(entry.canonicalWorkerName ?? entry.workerName),
        ),
    ) ||
    sum("sourceHourHundredths") !== snapshot.totalHourHundredths ||
    sum("paidHourHundredths") !== estimate.paidHourHundredths ||
    sum("regularHourHundredths") !== estimate.regularHourHundredths ||
    sum("overtimeHourHundredths") !== estimate.overtimeHourHundredths ||
    sum("totalCostCents") !== estimate.totalCostCents ||
    estimate.workerWeeks.some(
      (week) =>
        !reference(week.key) ||
        typeof week.fingerprintContext !== "string" ||
        !week.fingerprintContext.length,
    ) ||
    snapshot.disclosures.wageCostsIncluded !== true ||
    snapshot.disclosures.lunchRedistributed !== true ||
    material.quantity !== 1 ||
    material.unit_cost !== estimate.totalCostCents ||
    material.part_number !== write.reference
  )
    throw new LaborApprovalPersistenceError("labor_approval_invalid_snapshot");
  const canonical = canonicalLaborApprovalSnapshot(snapshot);
  return parseRecord(
    await rpc("approve_labor_job_hours", {
      p_snapshot: snapshot,
      p_canonical: canonical,
      p_snapshot_hash: digest(canonical),
      p_source_revision: expectedRevision,
      p_actor_id: actorId,
    }),
  );
}
export async function invalidateSupabaseLaborApproval(
  approvalId: string,
  actorId: string,
  reason: "revoked" | "stale" = "revoked",
): Promise<LaborApprovalRecord> {
  id(approvalId);
  actor(actorId);
  if (!["revoked", "stale"].includes(reason))
    throw new LaborApprovalPersistenceError("labor_approval_invalid_request");
  return parseRecord(
    await rpc("invalidate_labor_job_hour_approval", {
      p_approval_id: approvalId,
      p_actor_id: actorId,
      p_reason: reason,
    }),
  );
}
export async function claimSupabaseLaborApprovalSend(
  approvalId: string,
  snapshotHash: string,
  expectedRevision: number,
  actorId: string,
): Promise<LaborApprovalSendClaim> {
  id(approvalId);
  actor(actorId);
  expected(expectedRevision);
  if (!sha256.test(snapshotHash))
    throw new LaborApprovalPersistenceError("labor_approval_invalid_request");
  const data = await rpc("claim_labor_job_hour_send", {
    p_approval_id: approvalId,
    p_snapshot_hash: snapshotHash,
    p_source_revision: expectedRevision,
    p_actor_id: actorId,
  });
  if (!object(data) || !object(data.attempt)) invalid();
  const attempt = data.attempt;
  if (
    typeof attempt.id !== "string" ||
    !uuid.test(attempt.id) ||
    typeof attempt.lease_token !== "string" ||
    !uuid.test(attempt.lease_token) ||
    typeof attempt.expires_at !== "string" ||
    !integer(attempt.source_revision)
  )
    invalid();
  return {
    approval: parseRecord(data.approval),
    attempt: {
      id: attempt.id,
      leaseToken: attempt.lease_token,
      expiresAt: attempt.expires_at,
      sourceRevision: attempt.source_revision,
    },
  };
}
export async function markSupabaseLaborApprovalDispatch(
  approvalId: string,
  attemptId: string,
  leaseToken: string,
): Promise<{ allowed: boolean; approval: LaborApprovalRecord }> {
  id(approvalId);
  id(attemptId);
  id(leaseToken);
  const data = await rpc("mark_labor_job_hour_dispatched", {
    p_approval_id: approvalId,
    p_attempt_id: attemptId,
    p_lease_token: leaseToken,
  });
  if (!object(data) || typeof data.allowed !== "boolean") invalid();
  return { allowed: data.allowed, approval: parseRecord(data.approval) };
}
export async function finishSupabaseLaborApprovalAttempt(
  approvalId: string,
  attemptId: string,
  leaseToken: string,
  outcome: LaborApprovalAttemptOutcome,
): Promise<LaborApprovalRecord> {
  id(approvalId);
  id(attemptId);
  id(leaseToken);
  responseHash("responseHash" in outcome ? outcome.responseHash : undefined);
  if (outcome.status === "sent") {
    if (!reference(outcome.providerReference))
      throw new LaborApprovalPersistenceError("labor_approval_invalid_outcome");
  } else if (outcome.status === "failed") errorCode(outcome.errorCode);
  else if (outcome.status === "reconciliation_required") {
    if (outcome.errorCode !== undefined) errorCode(outcome.errorCode);
  } else throw new LaborApprovalPersistenceError("labor_approval_invalid_outcome");
  return parseRecord(
    await rpc("finish_labor_job_hour_attempt", {
      p_approval_id: approvalId,
      p_attempt_id: attemptId,
      p_lease_token: leaseToken,
      p_outcome: outcome,
    }),
  );
}
export async function reconcileSupabaseLaborApproval(
  approvalId: string,
  evidence: LaborApprovalReconciliationEvidence,
  actorId: string,
): Promise<LaborApprovalRecord> {
  id(approvalId);
  actor(actorId);
  responseHash(evidence.responseHash);
  if (
    !["sent", "absent", "unknown"].includes(evidence.status) ||
    (evidence.status === "sent" && !reference(evidence.providerReference))
  )
    throw new LaborApprovalPersistenceError("labor_approval_invalid_outcome");
  return parseRecord(
    await rpc("reconcile_labor_job_hour_approval", {
      p_approval_id: approvalId,
      p_evidence: evidence,
      p_actor_id: actorId,
    }),
  );
}
