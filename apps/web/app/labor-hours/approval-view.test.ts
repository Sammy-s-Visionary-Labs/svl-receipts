import { describe, expect, it } from "vitest";
import type { LaborApprovalHistoryItem, LaborApprovalPreview } from "@/lib/labor/approval-contract";
import {
  laborApprovalActions,
  laborApprovalCanReview,
  laborApprovalPreviewMatches,
  laborApprovalReviewKey,
  laborApprovalSendMatches,
  validLaborApprovalDates,
} from "./approval-view";

const scope = {
  housecallJobId: "TEST-HOUSECALL-JOB",
  fromDate: "2026-10-01",
  toDate: "2026-10-12",
};
const preview: LaborApprovalPreview = {
  ...scope,
  jobName: "TEST Job",
  address: "TEST Address",
  snapshotHash: "TEST-SNAPSHOT",
  storageRevision: 12,
  totalHours: 4,
  travelHours: 1,
  entryCount: 2,
  workers: [],
  availableWorkers: [],
  entries: [],
  lunchDisclosure: "Job hours are before the separate worker-day lunch deduction.",
  blockers: [],
  warnings: [],
  unresolved: { entryCount: 0, hours: 0 },
  costEstimate: {
    policyDescription: "TEST proportional lunch and chronological weekly overtime",
    paidHours: 4,
    regularHours: 4,
    overtimeHours: 0,
    totalCostCents: 10000,
    unpricedHours: 0,
    workers: [],
  },
  housecallInput: {
    name: "TEST labor estimate",
    description: "TEST approved source hours and costs",
    quantity: 1,
    unitCostCents: 10000,
  },
};
const approval: LaborApprovalHistoryItem = {
  ...scope,
  id: "TEST-APPROVAL",
  jobName: "TEST Job",
  snapshotHash: "TEST-SNAPSHOT",
  hours: 4,
  paidHours: 4,
  estimatedCostCents: 10000,
  approvedWorkerNames: [],
  status: "approved",
  approvedAt: "2026-10-13T12:00:00Z",
  approvedBy: "TEST-MANAGER",
  sentAt: null,
  lastError: null,
  canSend: true,
  canVerify: true,
  canRevoke: true,
};
const enabled = { supported: true, sendingEnabled: true, message: "TEST capability" };

describe("job-hour review and send boundaries", () => {
  it("rejects impossible/reversed dates and earlier-job or earlier-date responses", () => {
    expect(validLaborApprovalDates("2026-02-30", "2026-03-01")).toBe(false);
    expect(validLaborApprovalDates("2026-10-12", "2026-10-01")).toBe(false);
    expect(validLaborApprovalDates("2026-10-01", "2026-10-12")).toBe(true);
    expect(laborApprovalPreviewMatches(preview, scope)).toBe(true);
    expect(laborApprovalPreviewMatches(preview, { ...scope, housecallJobId: "TEST-OTHER" })).toBe(
      false,
    );
    expect(laborApprovalPreviewMatches(preview, { ...scope, toDate: "2026-10-13" })).toBe(false);
  });

  it("invalidates a checked review on source hash, storage revision or scope changes", () => {
    for (const changed of [
      { ...preview, snapshotHash: "TEST-CHANGED" },
      { ...preview, storageRevision: 13 },
      { ...preview, housecallJobId: "TEST-OTHER" },
      { ...preview, fromDate: "2026-10-02" },
    ])
      expect(laborApprovalReviewKey(changed)).not.toBe(laborApprovalReviewKey(preview));
  });

  it("requires server permission, supported destination and enabled sending together", () => {
    expect(laborApprovalActions(approval, enabled).send).toBe(true);
    expect(laborApprovalActions({ ...approval, canSend: false }, enabled).send).toBe(false);
    expect(laborApprovalActions(approval, { ...enabled, supported: false }).send).toBe(false);
    expect(laborApprovalActions(approval, { ...enabled, sendingEnabled: false }).send).toBe(false);
  });

  it("requires a current shared snapshot with positive unblocked hours for approval", () => {
    expect(laborApprovalCanReview(preview, scope)).toBe(true);
    for (const changed of [
      { ...preview, storageRevision: null },
      { ...preview, snapshotHash: "" },
      { ...preview, blockers: ["TEST unresolved clock"] },
      { ...preview, totalHours: 0 },
      { ...preview, totalHours: Number.NaN },
      { ...preview, entryCount: 0 },
      { ...preview, costEstimate: { ...preview.costEstimate, totalCostCents: null } },
      { ...preview, housecallInput: null },
    ])
      expect(laborApprovalCanReview(changed, scope)).toBe(false);
  });

  it("requires the exact displayed workers and cost snapshot before sending a historical approval", () => {
    expect(laborApprovalSendMatches(approval, preview, scope)).toBe(true);
    expect(
      laborApprovalSendMatches({ ...approval, snapshotHash: "TEST-OLD-COST" }, preview, scope),
    ).toBe(false);
    expect(
      laborApprovalSendMatches(
        { ...approval, approvedWorkerNames: ["TEST Other"] },
        preview,
        scope,
      ),
    ).toBe(false);
    const subset = {
      ...preview,
      availableWorkers: [
        { workerName: "TEST A", hours: 2 },
        { workerName: "TEST B", hours: 2 },
      ],
      workers: [{ workerName: "TEST A", hours: 2, days: [] }],
    };
    expect(laborApprovalPreviewMatches(subset, scope)).toBe(false);
    expect(laborApprovalPreviewMatches(subset, { ...scope, workerNames: ["TEST A"] })).toBe(true);
    expect(laborApprovalPreviewMatches(subset, { ...scope, workerNames: [] })).toBe(false);
  });

  it("offers verification instead of another send for uncertain or in-flight attempts", () => {
    for (const status of ["reconciliation_required", "sending"] as const) {
      const actions = laborApprovalActions({ ...approval, status }, enabled);
      expect(actions).toEqual({ send: false, verify: true, revoke: false });
    }
  });

  it("allows a proven pre-dispatch failure to retry/revoke only with explicit server permission", () => {
    const failed = { ...approval, status: "failed" as const, canVerify: false };
    expect(laborApprovalActions(failed, enabled)).toEqual({
      send: true,
      verify: false,
      revoke: true,
    });
    expect(laborApprovalActions({ ...failed, canSend: false, canRevoke: false }, enabled)).toEqual({
      send: false,
      verify: false,
      revoke: false,
    });
    expect(laborApprovalActions(failed, { ...enabled, sendingEnabled: false }).send).toBe(false);
    expect(laborApprovalActions(failed, { ...enabled, supported: false }).send).toBe(false);
  });

  it("never sends sent, revoked or stale approvals and respects verification/revoke permission", () => {
    for (const status of ["sent", "revoked", "stale"] as const)
      expect(laborApprovalActions({ ...approval, status }, enabled).send).toBe(false);
    expect(
      laborApprovalActions({ ...approval, canVerify: false, status: "failed" }, enabled).verify,
    ).toBe(false);
    expect(laborApprovalActions({ ...approval, canRevoke: false }, enabled).revoke).toBe(false);
  });
});
