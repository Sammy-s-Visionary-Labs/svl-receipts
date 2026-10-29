import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: () => ({ rpc: mocks.rpc }) }));

import { listLaborManualCorrections, recordLaborManualCorrection } from "./corrections";

const actor = "00000000-0000-4000-8000-000000000001";
const approvalId = "00000000-0000-4000-8000-000000000002";
const requestId = "00000000-0000-4000-8000-000000000003";
const input = {
  approvalId,
  requestId,
  expectedSnapshotHash: "a".repeat(64),
  confirmed: true,
  reason: "TEST corrected cost after review",
  providerReference: "TEST-HCP-REFERENCE",
  evidence: "TEST manager reviewed the corrected material on the job.",
};
const stored = {
  id: requestId,
  approval_id: approvalId,
  snapshot_hash: input.expectedSnapshotHash,
  recorded_by: actor,
  recorded_at: "2026-10-01T12:00:00Z",
  reason: input.reason,
  provider_reference: input.providerReference,
  evidence: input.evidence,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: stored, error: null });
});

describe("audited manual labor resolutions", () => {
  it("records only the authenticated actor and exact reviewed hash with a stable retry key", async () => {
    const result = await recordLaborManualCorrection(
      { ...input, recordedBy: "ATTACKER", reason: `  ${input.reason}  ` },
      actor,
    );
    expect(result.correction).toMatchObject({
      id: requestId,
      approvalId,
      recordedBy: actor,
      snapshotHash: input.expectedSnapshotHash,
    });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("record_labor_manual_correction", {
      p_approval_id: approvalId,
      p_request_id: requestId,
      p_snapshot_hash: input.expectedSnapshotHash,
      p_actor_id: actor,
      p_reason: input.reason,
      p_provider_reference: input.providerReference,
      p_evidence: input.evidence,
    });
  });
  it("requires attestation and all evidence before touching storage", async () => {
    for (const override of [
      { confirmed: false },
      { expectedSnapshotHash: "changed" },
      { requestId: "missing" },
      { reason: "short" },
      { providerReference: " " },
      { evidence: " " },
    ])
      await expect(recordLaborManualCorrection({ ...input, ...override }, actor)).rejects.toThrow();
    await expect(recordLaborManualCorrection(input, "local-development")).rejects.toMatchObject({
      status: 403,
    });
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("reads immutable history without exposing provider payloads", async () => {
    mocks.rpc.mockResolvedValue({ data: [stored], error: null });
    const result = await listLaborManualCorrections(approvalId, actor);
    expect(result.corrections[0]).toEqual({
      id: requestId,
      approvalId,
      snapshotHash: input.expectedSnapshotHash,
      recordedBy: actor,
      recordedAt: stored.recorded_at,
      reason: input.reason,
      providerReference: input.providerReference,
      evidence: input.evidence,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("read_labor_manual_corrections", {
      p_approval_id: approvalId,
      p_actor_id: actor,
    });
  });
  it("surfaces active-send and replay conflicts without leaking database details", async () => {
    for (const code of [
      "labor_approval_dispatch_busy",
      "labor_correction_conflict",
      "labor_approval_stale",
    ]) {
      mocks.rpc.mockResolvedValue({ data: null, error: { message: code } });
      await expect(recordLaborManualCorrection(input, actor)).rejects.toMatchObject({
        status: 409,
        code,
      });
    }
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "TEST INTERNAL SQL" } });
    await expect(recordLaborManualCorrection(input, actor)).rejects.toMatchObject({
      status: 503,
      code: "labor_correction_storage_failed",
    });
    mocks.rpc.mockResolvedValue({ data: { ...stored, snapshot_hash: "wrong" }, error: null });
    await expect(recordLaborManualCorrection(input, actor)).rejects.toMatchObject({
      status: 503,
      code: "labor_correction_invalid_response",
    });
  });
});
