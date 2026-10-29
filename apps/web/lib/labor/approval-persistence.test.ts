import { createHash } from "node:crypto";
import { canonicalLaborApprovalSnapshot, type LaborApprovalSnapshot } from "@svl/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => ({ rpc }) }));

import {
  claimSupabaseLaborApprovalSend,
  createSupabaseLaborApproval,
  finishSupabaseLaborApprovalAttempt,
  invalidateSupabaseLaborApproval,
  listSupabaseLaborApprovals,
  markSupabaseLaborApprovalDispatch,
  reconcileSupabaseLaborApproval,
} from "./approval-persistence";

const actor = "93000000-0000-4000-8000-000000000001";
const approval = "93000000-0000-4000-8000-000000000002";
const attempt = "93000000-0000-4000-8000-000000000003";
const token = "93000000-0000-4000-8000-000000000004";
function snapshot(): LaborApprovalSnapshot {
  return {
    version: 1,
    housecallJobId: "job_test",
    customerId: "customer_test",
    jobName: "TEST Job",
    jobNumber: "1001",
    jobAddress: "TEST Address",
    customerName: "TEST Customer",
    fromDate: "2026-09-17",
    toDate: "2026-09-17",
    allocationRulesVersion: "TEST",
    hourBasis: "allocated_source_hours_before_day_lunch",
    totalHourHundredths: 125,
    travelHourHundredths: 0,
    entries: [],
    workerDays: [],
    unresolved: { entryCount: 0, hourHundredths: 0 },
    disclosures: {
      lunchRedistributed: true,
      wageCostsIncluded: true,
      provisionalWorkerDates: [],
    },
    costEstimate: {
      policyVersion: "TEST_COST",
      paidHourHundredths: 125,
      regularHourHundredths: 125,
      overtimeHourHundredths: 0,
      totalCostCents: 2500,
      workers: [
        {
          workerName: "TEST Worker",
          sourceHourHundredths: 125,
          paidHourHundredths: 125,
          regularHourHundredths: 125,
          overtimeHourHundredths: 0,
          totalCostCents: 2500,
        },
      ],
      workerWeeks: [{ key: "TEST_WEEK", fingerprintContext: '{"complete":true}' }],
    },
    approvedWorkerNames: ["TEST Worker"],
    providerIntent: {
      version: 1,
      destination: "job_input_materials",
      costTreatment: "approved_total_cost",
      preparedWrite: {
        kind: "job_cost",
        jobId: "job_test",
        method: "PUT",
        path: "/jobs/job_test/job_input_materials/bulk_update",
        reference: "SVL-LABOR-test",
        body: {
          job_input_materials: [
            {
              name: "TEST Labor hours",
              description: "TEST Worker 1.25h",
              part_number: "SVL-LABOR-test",
              quantity: 1,
              unit_cost: 2500,
            },
          ],
        },
        requestHash: "b".repeat(64),
      },
    },
  };
}
const digest = (value: LaborApprovalSnapshot) =>
  createHash("sha256").update(canonicalLaborApprovalSnapshot(value)).digest("hex");
function row(value = snapshot()) {
  return {
    id: approval,
    snapshot: value,
    snapshot_hash: digest(value),
    source_revision: 7,
    status: "approved",
    approved_by: actor,
    approved_at: "2026-10-13T22:00:00Z",
    sent_at: null,
    last_error: null,
    provider_reference: null,
    last_attempt: null,
    canonical_snapshot: "PRIVATE_INTERNAL",
    source_fingerprint: "INTERNAL_HASH",
    lease_token: "DO_NOT_LEAK",
  };
}
beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: row(), error: null });
});
describe("labor approval service-role persistence", () => {
  it("accepts reviewed canonical worker rollups while retaining original interval identity", async () => {
    const value = snapshot();
    value.workerAliases = [{ alias: "TEST Alias", workerName: "TEST Worker" }];
    value.entries = [
      {
        workerName: "TEST Alias",
        normalizedWorkerName: "test alias",
        canonicalWorkerName: "TEST Worker",
      } as LaborApprovalSnapshot["entries"][number],
    ];
    await createSupabaseLaborApproval(value, 7, actor);
    expect(rpc.mock.calls[0][1].p_snapshot.entries[0]).toMatchObject({
      workerName: "TEST Alias",
      normalizedWorkerName: "test alias",
      canonicalWorkerName: "TEST Worker",
    });
    rpc.mockClear();
    value.entries[0].canonicalWorkerName = "TEST Other Worker";
    await expect(createSupabaseLaborApproval(value, 7, actor)).rejects.toMatchObject({
      code: "labor_approval_invalid_snapshot",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("saves canonical exact approval bytes and a SHA256 with an active-actor/revision contract", async () => {
    const value = snapshot();
    const result = await createSupabaseLaborApproval(value, 7, actor);
    expect(rpc).toHaveBeenCalledWith("approve_labor_job_hours", {
      p_snapshot: value,
      p_canonical: canonicalLaborApprovalSnapshot(value),
      p_snapshot_hash: digest(value),
      p_source_revision: 7,
      p_actor_id: actor,
    });
    expect(result.snapshotHash).toBe(digest(value));
    expect(result.sourceRevision).toBe(7);
  });
  it("includes provider intent changes in the final approved hash", async () => {
    const first = snapshot();
    const second = snapshot();
    if (second.providerIntent)
      second.providerIntent.preparedWrite.body.job_input_materials[0] = {
        name: "Changed exact approved description",
        description: "TEST",
        part_number: "SVL-LABOR-test",
        quantity: 1,
        unit_cost: 2500,
      };
    expect(digest(first)).not.toBe(digest(second));
  });
  it.each(["missing", "wrong_job", "wrong_quantity", "wrong_cost"])(
    "refuses unprepared or mismatched provider intent %s",
    async (change) => {
      const value = snapshot();
      const write = value.providerIntent?.preparedWrite;
      if (change === "missing") delete value.providerIntent;
      else if (write && change === "wrong_job") write.jobId = "other_job";
      else if (write?.body.job_input_materials[0] && change === "wrong_quantity")
        write.body.job_input_materials[0].quantity = 2;
      else if (write?.body.job_input_materials[0])
        write.body.job_input_materials[0].unit_cost = 100;
      await expect(createSupabaseLaborApproval(value, 7, actor)).rejects.toMatchObject({
        code: "labor_approval_invalid_snapshot",
      });
      expect(rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed actor/revision before the SDK call", async () => {
    await expect(
      createSupabaseLaborApproval(snapshot(), 7, "local-development"),
    ).rejects.toMatchObject({ code: "unauthenticated" });
    await expect(createSupabaseLaborApproval(snapshot(), -1, actor)).rejects.toMatchObject({
      code: "labor_approval_invalid_request",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("returns only public history fields and detached immutable snapshot data", async () => {
    const data = row();
    rpc.mockResolvedValue({ data: [data], error: null });
    const result = await listSupabaseLaborApprovals();
    expect(JSON.stringify(result)).not.toMatch(/DO_NOT_LEAK|PRIVATE_INTERNAL|INTERNAL_HASH/);
    result[0]?.snapshot.entries.push({} as never);
    expect(data.snapshot.entries).toEqual([]);
  });
  it("rejects altered persisted snapshots rather than trusting a returned hash", async () => {
    const data = row();
    data.snapshot.totalHourHundredths = 999;
    rpc.mockResolvedValue({ data: [data], error: null });
    await expect(listSupabaseLaborApprovals()).rejects.toMatchObject({
      code: "labor_approval_invalid_response",
    });
  });
  it("forwards stale/duplicate ledger conflicts while redacting provider/SDK error details", async () => {
    for (const message of ["labor_approval_stale", "labor_approval_duplicate_interval"]) {
      rpc.mockResolvedValueOnce({ data: null, error: { message } });
      await expect(createSupabaseLaborApproval(snapshot(), 7, actor)).rejects.toMatchObject({
        code: message,
      });
    }
    rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "PRIVATE_SECRET provider failure" },
    });
    await expect(listSupabaseLaborApprovals()).rejects.toThrow("labor_approval_storage_failed");
  });
  it("requires a distinct manual claim and a private one-time dispatch lease", async () => {
    rpc.mockResolvedValueOnce({
      data: {
        approval: { ...row(), status: "sending" },
        attempt: {
          id: attempt,
          lease_token: token,
          expires_at: "2026-10-13T22:02:00Z",
          source_revision: 7,
        },
      },
      error: null,
    });
    const claim = await claimSupabaseLaborApprovalSend(approval, digest(snapshot()), 7, actor);
    expect(claim.attempt).toEqual({
      id: attempt,
      leaseToken: token,
      expiresAt: "2026-10-13T22:02:00Z",
      sourceRevision: 7,
    });
    expect(rpc).toHaveBeenCalledWith("claim_labor_job_hour_send", {
      p_approval_id: approval,
      p_snapshot_hash: digest(snapshot()),
      p_source_revision: 7,
      p_actor_id: actor,
    });
    rpc.mockResolvedValueOnce({
      data: { allowed: false, approval: { ...row(), status: "stale" } },
      error: null,
    });
    expect((await markSupabaseLaborApprovalDispatch(approval, attempt, token)).allowed).toBe(false);
  });
  it("keeps post-dispatch uncertainty distinct from a pre-dispatch failure", async () => {
    rpc.mockResolvedValueOnce({
      data: { ...row(), status: "reconciliation_required" },
      error: null,
    });
    const result = await finishSupabaseLaborApprovalAttempt(approval, attempt, token, {
      status: "reconciliation_required",
      errorCode: "timeout",
    });
    expect(result.status).toBe("reconciliation_required");
    expect(rpc).toHaveBeenCalledWith("finish_labor_job_hour_attempt", {
      p_approval_id: approval,
      p_attempt_id: attempt,
      p_lease_token: token,
      p_outcome: { status: "reconciliation_required", errorCode: "timeout" },
    });
  });
  it("readback absence uses only reconciliation and never a new claim", async () => {
    rpc.mockResolvedValueOnce({
      data: { ...row(), status: "reconciliation_required" },
      error: null,
    });
    await reconcileSupabaseLaborApproval(
      approval,
      { status: "absent", responseHash: "a".repeat(64) },
      actor,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("reconcile_labor_job_hour_approval", {
      p_approval_id: approval,
      p_evidence: { status: "absent", responseHash: "a".repeat(64) },
      p_actor_id: actor,
    });
  });
  it("validates outcome codes and exact provider references before persistence", async () => {
    await expect(
      finishSupabaseLaborApprovalAttempt(approval, attempt, token, {
        status: "failed",
        errorCode: "Private raw provider response",
      }),
    ).rejects.toMatchObject({ code: "labor_approval_invalid_outcome" });
    await expect(
      reconcileSupabaseLaborApproval(approval, { status: "sent" }, actor),
    ).rejects.toMatchObject({ code: "labor_approval_invalid_outcome" });
    expect(rpc).not.toHaveBeenCalled();
  });
  it("supports explicit revoke or stale invalidation without changing a snapshot", async () => {
    await invalidateSupabaseLaborApproval(approval, actor, "stale");
    expect(rpc).toHaveBeenCalledWith("invalidate_labor_job_hour_approval", {
      p_approval_id: approval,
      p_actor_id: actor,
      p_reason: "stale",
    });
  });
});
