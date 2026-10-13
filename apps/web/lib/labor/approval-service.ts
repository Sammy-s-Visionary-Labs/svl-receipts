import { createHash } from "node:crypto";
import {
  estimateLaborJobCosts,
  LABOR_ALLOCATION_POLICY,
  type LaborApprovalSnapshot,
} from "@svl/domain";
import {
  createHousecallClient,
  type HousecallClient,
  HousecallError,
  type PreparedMaterialWrite,
  prepareLaborMaterialWrite,
  verifyPreparedHousecallWrite,
} from "@svl/integrations";
import { AuthHttpError } from "@/lib/auth/guards";
import { housecallConfiguration } from "@/lib/housecall/config";
import {
  laborApprovalPreview,
  laborApprovalScope,
  laborApprovalSnapshotHash,
  loadLaborApprovalContext,
} from "./approval-context";
import type { LaborApprovalHistoryItem, LaborApprovalWorkspaceData } from "./approval-contract";
import {
  claimSupabaseLaborApprovalSend,
  createSupabaseLaborApproval,
  finishSupabaseLaborApprovalAttempt,
  invalidateSupabaseLaborApproval,
  type LaborApprovalRecord,
  listSupabaseLaborApprovals,
  markSupabaseLaborApprovalDispatch,
  reconcileSupabaseLaborApproval,
} from "./approval-persistence";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const store = {
  list: listSupabaseLaborApprovals,
  create: createSupabaseLaborApproval,
  invalidate: invalidateSupabaseLaborApproval,
  claim: claimSupabaseLaborApprovalSend,
  dispatch: markSupabaseLaborApprovalDispatch,
  finish: finishSupabaseLaborApprovalAttempt,
  reconcile: reconcileSupabaseLaborApproval,
};
type Dependencies = {
  context?: typeof loadLaborApprovalContext;
  store?: typeof store;
  client?: () => HousecallClient;
  env?: Readonly<Record<string, string | undefined>>;
};

/** Separate from receipt exports: enabling receipts must never authorize labor writes. */
export function laborApprovalCapability(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const config = housecallConfiguration(env);
  const sendingEnabled =
    env.LABOR_HOUSECALL_SEND_ENABLED === "1" &&
    config.readsEnabled &&
    config.allJobs &&
    config.configured;
  return {
    supported: true,
    sendingEnabled,
    message: sendingEnabled
      ? "Send creates one estimated labor-cost summary under Housecall Job Inputs > Materials. Quantity is 1; the exact approved cost and paid hours appear below. It does not create native time entries or payroll."
      : "Destination: Housecall Job Inputs > Materials. One estimated labor-cost summary, quantity 1, preserves exact approved cents; paid hours appear in its name and description. Live sending is disabled; approval does not send anything.",
  };
}

function providerClient(jobId: string, deps: Dependencies): HousecallClient {
  if (deps.client) return deps.client();
  const env = deps.env ?? process.env;
  const config = housecallConfiguration(env);
  if (!config.readsEnabled || !config.allJobs || !config.configured)
    throw new AuthHttpError(503, "housecall_unavailable", "Housecall reads are not configured.");
  return createHousecallClient({
    apiKey: env.HOUSECALL_API_KEY ?? "",
    allowedReadJobIds: [jobId],
    allowedWriteJobIds: laborApprovalCapability(env).sendingEnabled ? [jobId] : [],
    correlationId: `labor-${crypto.randomUUID()}`,
  });
}

async function review(
  context: Awaited<ReturnType<typeof loadLaborApprovalContext>>,
  input: Record<string, unknown>,
  _env: Readonly<Record<string, string | undefined>>,
) {
  const result = laborApprovalPreview(context, laborApprovalScope(input));
  const report = estimateLaborJobCosts({
    entries: context.dashboard.entries,
    allocation: context.dashboard.allocation,
    settings: context.dashboard.paySettings,
    payroll: context.dashboard.payroll,
  });
  const selectedIds = new Set(result.preview.entries.map((entry) => entry.sourceEntryId));
  const costs = report.entries.filter((entry) => selectedIds.has(entry.sourceEntryId));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const nullableSum = (values: (number | null)[]) =>
    values.some((value) => value === null) ? null : sum(values as number[]);
  if (costs.length !== selectedIds.size)
    result.preview.blockers.push("Some selected intervals have no matching cost calculation.");
  const explanations: Record<string, string> = {
    incomplete_worker_week: "Import the complete workweek before approving overtime costs.",
    missing_hourly_rate: "Set an hourly rate or deselect this worker for this approval.",
    unknown_same_day_clock_boundaries: "Review missing or overnight clocks in this worker's week.",
    overlapping_source_intervals: "Resolve overlapping clock intervals in this worker's week.",
    provisional_worker_day: "Import completed worker days before approving.",
    clock_duration_differs_from_source_hours:
      "Reported hours differ from clock duration; the original reported hours are retained.",
    minute_rounded_short_interval:
      "A short source interval has the same displayed start/end minute. Its reported hundredths are retained and ordered at that minute before a following longer interval.",
  };
  result.preview.warnings.push(
    ...costs.flatMap((entry) => entry.warnings.map((warning) => explanations[warning] ?? warning)),
  );
  const keys = new Set(costs.map((entry) => entry.workerWeekKey));
  const weeks = report.workerWeeks.filter((week) => keys.has(week.key));
  result.preview.blockers.push(
    ...weeks
      .filter((week) => !week.approvable)
      .flatMap((week) =>
        week.blockers.map(
          (reason) =>
            `${week.workerName} (${week.weekStart} through ${week.weekEnd}): ${explanations[reason] ?? "Source and payroll controls need review before this week's costs can be approved."}`,
        ),
      ),
  );
  const totalCostCents = nullableSum(costs.map((entry) => entry.estimatedCostCents));
  const regularHH = nullableSum(costs.map((entry) => entry.regularHourHundredths));
  const overtimeHH = nullableSum(costs.map((entry) => entry.overtimeHourHundredths));
  const workers = result.preview.workers.map((worker) => {
    const workerIds = new Set(
      result.preview.entries
        .filter((entry) => entry.workerName === worker.workerName)
        .map((entry) => entry.sourceEntryId),
    );
    const rows = costs.filter((entry) => workerIds.has(entry.sourceEntryId));
    const workerWeekKeys = new Set(rows.map((entry) => entry.workerWeekKey));
    const rates = [
      ...new Set(
        weeks.filter((week) => workerWeekKeys.has(week.key)).map((week) => week.hourlyRateCents),
      ),
    ];
    return {
      workerName: worker.workerName,
      hourlyRateCents: rates.length === 1 ? rates[0] : null,
      overtimeMultiplier: context.dashboard.paySettings.overtime.multiplier,
      paidHours: sum(rows.map((entry) => entry.paidHourHundredths)) / 100,
      regularHours: nullableSum(rows.map((entry) => entry.regularHourHundredths)),
      overtimeHours: nullableSum(rows.map((entry) => entry.overtimeHourHundredths)),
      costCents: nullableSum(rows.map((entry) => entry.estimatedCostCents)),
    };
  });
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekStartsOn = context.dashboard.paySettings.overtime.weekStartsOn;
  result.preview.costEstimate = {
    policyDescription: `Deduct ${LABOR_ALLOCATION_POLICY.lunchHours} hours once per worker-day with at least ${LABOR_ALLOCATION_POLICY.lunchThresholdHours} gross hours, spread proportionally across all positive time, including excluded and pending entries. Source break deductions are not subtracted again. Overtime follows clock order after ${context.dashboard.paySettings.overtime.thresholdHours} paid hours in the ${weekdays[weekStartsOn]}–${weekdays[(weekStartsOn + 6) % 7]} workweek at ${context.dashboard.paySettings.overtime.multiplier} times the rate. Weekly cents reconcile to pay estimates. Complete weeks and known clocks/rates are required for approval.`,
    paidHours: sum(costs.map((entry) => entry.paidHourHundredths)) / 100,
    regularHours: regularHH === null ? null : regularHH / 100,
    overtimeHours: overtimeHH === null ? null : overtimeHH / 100,
    totalCostCents,
    unpricedHours:
      sum(
        costs
          .filter(
            (entry) =>
              weeks.find((week) => week.key === entry.workerWeekKey)?.hourlyRateCents === null,
          )
          .map((entry) => entry.paidHourHundredths),
      ) / 100,
    workers: workers.map((worker) => ({
      ...worker,
      regularHours: worker.regularHours === null ? null : worker.regularHours / 100,
      overtimeHours: worker.overtimeHours === null ? null : worker.overtimeHours / 100,
    })),
  };
  if (
    result.snapshot &&
    totalCostCents !== null &&
    regularHH !== null &&
    overtimeHH !== null &&
    workers.every(
      (worker) =>
        worker.costCents !== null && worker.regularHours !== null && worker.overtimeHours !== null,
    )
  ) {
    const costSnapshot: LaborApprovalSnapshot = {
      ...result.snapshot,
      approvedWorkerNames: result.preview.workers.map((worker) => worker.workerName).sort(),
      disclosures: {
        ...result.snapshot.disclosures,
        lunchRedistributed: true,
        wageCostsIncluded: true,
      },
      costEstimate: {
        policyVersion: report.policyVersion,
        paidHourHundredths: Math.round(result.preview.costEstimate.paidHours * 100),
        regularHourHundredths: regularHH,
        overtimeHourHundredths: overtimeHH,
        totalCostCents,
        workers: workers.map((worker) => ({
          workerName: worker.workerName,
          sourceHourHundredths: Math.round(
            (result.preview.workers.find((row) => row.workerName === worker.workerName)?.hours ??
              0) * 100,
          ),
          paidHourHundredths: Math.round(worker.paidHours * 100),
          regularHourHundredths: worker.regularHours as number,
          overtimeHourHundredths: worker.overtimeHours as number,
          totalCostCents: worker.costCents as number,
        })),
        workerWeeks: weeks
          .map((week) => ({ key: week.key, fingerprintContext: week.fingerprintContext }))
          .sort((a, b) => a.key.localeCompare(b.key)),
      },
    };
    result.snapshot = costSnapshot;
    try {
      const write = await prepareLaborMaterialWrite({
        jobId: costSnapshot.housecallJobId,
        snapshotHash: laborApprovalSnapshotHash(costSnapshot),
        period: { from: costSnapshot.fromDate, to: costSnapshot.toDate },
        hours: costSnapshot.totalHourHundredths / 100,
        workers: result.preview.workers.map(({ workerName, hours }) => ({
          workerName,
          hours,
          paidHours:
            result.preview.costEstimate.workers.find((row) => row.workerName === workerName)
              ?.paidHours ?? 0,
          regularHours:
            result.preview.costEstimate.workers.find((row) => row.workerName === workerName)
              ?.regularHours ?? 0,
          overtimeHours:
            result.preview.costEstimate.workers.find((row) => row.workerName === workerName)
              ?.overtimeHours ?? 0,
          costCents:
            result.preview.costEstimate.workers.find((row) => row.workerName === workerName)
              ?.costCents ?? 0,
        })),
        costPolicy: "approved_total_cost",
        paidHours: result.preview.costEstimate.paidHours,
        regularHours: regularHH / 100,
        overtimeHours: overtimeHH / 100,
        totalCostCents,
      });
      result.snapshot = {
        ...costSnapshot,
        providerIntent: {
          version: 1,
          destination: "job_input_materials",
          costTreatment: "approved_total_cost",
          preparedWrite: write,
        },
      };
      const line = write.body.job_input_materials[0];
      result.preview.housecallInput = line
        ? {
            name: line.name,
            description: line.description,
            quantity: line.quantity,
            unitCostCents: line.unit_cost,
          }
        : null;
      result.preview.snapshotHash = laborApprovalSnapshotHash({
        ...costSnapshot,
        providerIntent: result.snapshot.providerIntent,
      });
    } catch (error) {
      result.preview.blockers.push(
        error instanceof Error
          ? error.message
          : "The Housecall cost summary could not be prepared.",
      );
    }
  }
  result.preview.blockers = [...new Set(result.preview.blockers)];
  result.preview.warnings = [...new Set(result.preview.warnings)];
  return result;
}

async function stillCurrent(
  record: LaborApprovalRecord,
  context: Awaited<ReturnType<typeof loadLaborApprovalContext>>,
  env: Readonly<Record<string, string | undefined>>,
) {
  try {
    const current = await review(
      context,
      { ...record.snapshot, workerNames: record.snapshot.approvedWorkerNames },
      env,
    );
    return (
      current.preview.blockers.length === 0 && current.preview.snapshotHash === record.snapshotHash
    );
  } catch {
    return false;
  }
}

async function history(
  record: LaborApprovalRecord,
  context: Awaited<ReturnType<typeof loadLaborApprovalContext>>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<LaborApprovalHistoryItem> {
  const current = await stillCurrent(record, context, env);
  const expired =
    record.status === "sending" &&
    !!record.lastAttempt &&
    Date.parse(record.lastAttempt.expiresAt) <= Date.now();
  const expiredBeforeDispatch = expired && !record.lastAttempt?.dispatchedAt;
  const mutable = ["approved", "failed"].includes(record.status) || expiredBeforeDispatch;
  const uncertain =
    record.status === "reconciliation_required" || (expired && !!record.lastAttempt?.dispatchedAt);
  return {
    id: record.id,
    housecallJobId: record.snapshot.housecallJobId,
    jobName: [
      record.snapshot.customerName,
      record.snapshot.jobNumber ? `#${record.snapshot.jobNumber}` : null,
      record.snapshot.jobName,
    ]
      .filter(Boolean)
      .join(" · "),
    fromDate: record.snapshot.fromDate,
    toDate: record.snapshot.toDate,
    snapshotHash: record.snapshotHash,
    hours: record.snapshot.totalHourHundredths / 100,
    paidHours: (record.snapshot.costEstimate?.paidHourHundredths ?? 0) / 100,
    estimatedCostCents: record.snapshot.costEstimate?.totalCostCents ?? 0,
    approvedWorkerNames:
      record.snapshot.approvedWorkerNames ??
      [...new Set(record.snapshot.entries.map((entry) => entry.workerName))].sort(),
    status: uncertain
      ? "reconciliation_required"
      : mutable && !current
        ? "stale"
        : expiredBeforeDispatch
          ? "failed"
          : record.status,
    approvedAt: record.approvedAt,
    approvedBy: record.approvedBy,
    sentAt: record.sentAt,
    lastError:
      record.status === "sent" && !current
        ? "Source data changed after sending. Review a correction; these hours cannot be sent again automatically."
        : record.lastError,
    canSend: mutable && current && laborApprovalCapability(env).sendingEnabled,
    canVerify: uncertain,
    canRevoke: mutable || record.status === "stale",
  };
}

export async function loadLaborApprovalWorkspace(
  input: Record<string, unknown>,
  deps: Dependencies = {},
): Promise<LaborApprovalWorkspaceData> {
  const env = deps.env ?? process.env;
  const context = await (deps.context ?? loadLaborApprovalContext)();
  const { preview } = await review(context, input, env);
  const records = context.storageRevision === null ? [] : await (deps.store ?? store).list();
  return {
    capability: laborApprovalCapability(env),
    preview,
    approvals: await Promise.all(
      records
        .filter((record) => record.snapshot.housecallJobId === preview.housecallJobId)
        .map((record) => history(record, context, env)),
    ),
  };
}

async function frozenWrite(record: LaborApprovalRecord): Promise<PreparedMaterialWrite> {
  const intent = record.snapshot.providerIntent;
  const write = intent?.preparedWrite;
  if (
    intent?.version !== 1 ||
    intent.destination !== "job_input_materials" ||
    intent.costTreatment !== "approved_total_cost" ||
    !record.snapshot.costEstimate ||
    !write ||
    write.kind !== "job_cost" ||
    write.jobId !== record.snapshot.housecallJobId ||
    write.body.job_input_materials[0]?.quantity !== 1 ||
    write.body.job_input_materials[0]?.unit_cost !== record.snapshot.costEstimate.totalCostCents ||
    record.snapshotHash !== laborApprovalSnapshotHash(record.snapshot) ||
    !(await verifyPreparedHousecallWrite(write))
  )
    throw new AuthHttpError(
      409,
      "invalid_approval",
      "The frozen Housecall payload could not be verified.",
    );
  return structuredClone(write);
}

function safeError(error: unknown): string {
  return error instanceof HousecallError ? `housecall_${error.code}` : "labor_send_interrupted";
}

export async function laborApprovalAction(
  input: Record<string, unknown>,
  actorId: string,
  deps: Dependencies = {},
) {
  if (!uuid.test(actorId))
    throw new AuthHttpError(
      403,
      "real_manager_required",
      "A signed-in manager account is required.",
    );
  const db = deps.store ?? store;
  const env = deps.env ?? process.env;
  if (input.action === "approve") {
    if (input.reviewed !== true) throw new Error("Review the job hours before approving.");
    const context = await (deps.context ?? loadLaborApprovalContext)();
    const { preview, snapshot } = await review(context, input, env);
    if (preview.blockers.length || !snapshot || !snapshot.providerIntent)
      throw new Error(preview.blockers.join(" ") || "The hours cannot be approved.");
    if (
      input.expectedSnapshotHash !== preview.snapshotHash ||
      input.expectedStorageRevision !== context.storageRevision
    )
      throw new AuthHttpError(
        409,
        "stale_review",
        "Hours changed after review. Refresh and approve the current version.",
      );
    // Release stale, never-dispatched reservations only through an audited manager action.
    for (const previous of await db.list())
      if (
        ["approved", "failed"].includes(previous.status) &&
        !(await stillCurrent(previous, context, env))
      )
        await db.invalidate(previous.id, actorId, "stale");
    return { approval: await db.create(snapshot, context.storageRevision as number, actorId) };
  }
  if (!["send", "verify", "revoke"].includes(String(input.action)))
    throw new Error("Choose approve, send, verify or revoke.");
  if (typeof input.approvalId !== "string" || !uuid.test(input.approvalId))
    throw new Error("Choose a saved approval.");
  // Gate before claims or provider calls; receipt export configuration cannot enable this action.
  if (input.action === "send" && !laborApprovalCapability(env).sendingEnabled)
    throw new AuthHttpError(
      403,
      "labor_sending_disabled",
      "Live labor sending is disabled. Nothing was sent.",
    );
  const record = (await db.list()).find((row) => row.id === input.approvalId);
  if (!record) throw new AuthHttpError(404, "approval_not_found", "Approval not found.");
  if (input.action === "revoke")
    return { approval: await db.invalidate(record.id, actorId, "revoked") };
  if (input.action === "send" && !["approved", "failed"].includes(record.status))
    throw new AuthHttpError(
      409,
      "approval_not_sendable",
      "This approval cannot be sent again. Review its status or verify the previous submission.",
    );
  const write = await frozenWrite(record);
  const client = providerClient(record.snapshot.housecallJobId, deps);
  if (input.action === "verify") {
    if (!["sending", "reconciliation_required"].includes(record.status))
      throw new Error("Only an uncertain submission needs Housecall verification.");
    let evidence: Awaited<ReturnType<HousecallClient["reconcileWrite"]>>;
    try {
      evidence = await client.reconcileWrite(write);
    } catch {
      return { approval: await db.reconcile(record.id, { status: "unknown" }, actorId) };
    }
    return {
      approval: await db.reconcile(
        record.id,
        evidence.status === "found"
          ? { status: "sent", providerReference: evidence.providerId }
          : { status: evidence.status === "absent" ? "absent" : "unknown" },
        actorId,
      ),
    };
  }
  if (
    input.confirmed !== true ||
    input.expectedSnapshotHash !== record.snapshotHash ||
    !sha256.test(String(input.expectedSnapshotHash))
  )
    throw new Error("Confirm the exact approved hours before sending.");
  const context = await (deps.context ?? loadLaborApprovalContext)();
  if (context.storageRevision === null || !(await stillCurrent(record, context, env))) {
    if (["approved", "failed"].includes(record.status))
      await db.invalidate(record.id, actorId, "stale");
    throw new AuthHttpError(
      409,
      "stale_review",
      "These hours changed after approval. Review and approve again.",
    );
  }
  const claim = await db.claim(record.id, record.snapshotHash, context.storageRevision, actorId);
  const args = [record.id, claim.attempt.id, claim.attempt.leaseToken] as const;
  let dispatched = false;
  try {
    // Reconcile first even on a first send: a matching reference must never be appended twice.
    const existing = await client.reconcileWrite(write);
    const guard = await db.dispatch(...args);
    if (!guard.allowed)
      throw new AuthHttpError(
        409,
        "stale_review",
        "The approval changed before dispatch. Nothing was sent.",
      );
    dispatched = true;
    // Consume the durable write phase even when readback already found the reference.
    // A crash after this point is verification-only, including before an HTTP PUT.
    if (existing.status !== "absent")
      return {
        approval: await db.finish(
          ...args,
          existing.status === "found"
            ? {
                status: "sent",
                providerReference: existing.providerId,
                responseHash: createHash("sha256").update(JSON.stringify(existing)).digest("hex"),
              }
            : { status: "reconciliation_required", errorCode: "housecall_reference_conflict" },
        ),
      };
    await client.executePreparedWrite(write, {
      approvalId: claim.attempt.id,
      approvedBy: actorId,
      approvedAt: new Date().toISOString(),
      expiresAt: claim.attempt.expiresAt,
      jobId: record.snapshot.housecallJobId,
      expectedCustomerId: record.snapshot.customerId,
      requestHash: write.requestHash,
    });
    const verified = await client.reconcileWrite(write);
    return {
      approval: await db.finish(
        ...args,
        verified.status === "found"
          ? {
              status: "sent",
              providerReference: verified.providerId,
              responseHash: createHash("sha256").update(JSON.stringify(verified)).digest("hex"),
            }
          : { status: "reconciliation_required", errorCode: "housecall_readback_required" },
      ),
    };
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    return {
      approval: await db.finish(
        ...args,
        dispatched
          ? { status: "reconciliation_required", errorCode: safeError(error) }
          : { status: "failed", errorCode: safeError(error) },
      ),
    };
  }
}
