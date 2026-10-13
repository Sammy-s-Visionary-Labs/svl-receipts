import type {
  LaborApprovalHistoryItem,
  LaborApprovalPreview,
  LaborApprovalWorkspaceData,
} from "@/lib/labor/approval-contract";

export type LaborApprovalScope = {
  housecallJobId: string;
  fromDate: string;
  toDate: string;
  workerNames?: readonly string[];
};

export function validLaborApprovalDates(from: string, to: string) {
  const valid = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  return valid(from) && valid(to) && from <= to;
}

/** A response for an earlier selection must never authorize the currently displayed dates. */
export function laborApprovalPreviewMatches(
  preview: LaborApprovalPreview,
  scope: LaborApprovalScope,
) {
  const requested = [
    ...(scope.workerNames ?? preview.availableWorkers.map((worker) => worker.workerName)),
  ].sort();
  const actual = preview.workers.map((worker) => worker.workerName).sort();
  return (
    validLaborApprovalDates(scope.fromDate, scope.toDate) &&
    preview.housecallJobId === scope.housecallJobId &&
    preview.fromDate === scope.fromDate &&
    preview.toDate === scope.toDate &&
    JSON.stringify(requested) === JSON.stringify(actual)
  );
}

export function laborApprovalReviewKey(preview: LaborApprovalPreview) {
  return JSON.stringify([
    preview.housecallJobId,
    preview.fromDate,
    preview.toDate,
    preview.snapshotHash,
    preview.storageRevision,
    preview.workers.map((worker) => worker.workerName).sort(),
  ]);
}

export function laborApprovalCanReview(preview: LaborApprovalPreview, scope: LaborApprovalScope) {
  return (
    laborApprovalPreviewMatches(preview, scope) &&
    !!preview.snapshotHash &&
    preview.storageRevision !== null &&
    Number.isSafeInteger(preview.storageRevision) &&
    Number.isFinite(preview.totalHours) &&
    preview.totalHours > 0 &&
    preview.entryCount > 0 &&
    preview.housecallInput !== null &&
    preview.costEstimate.totalCostCents !== null &&
    Number.isSafeInteger(preview.costEstimate.totalCostCents) &&
    preview.blockers.length === 0
  );
}

/** A historical approval cannot be sent while different dates/workers/cost content are displayed. */
export function laborApprovalSendMatches(
  approval: LaborApprovalHistoryItem,
  preview: LaborApprovalPreview,
  scope: LaborApprovalScope,
) {
  return (
    laborApprovalPreviewMatches(preview, scope) &&
    !!preview.snapshotHash &&
    approval.snapshotHash === preview.snapshotHash &&
    approval.housecallJobId === preview.housecallJobId &&
    approval.fromDate === preview.fromDate &&
    approval.toDate === preview.toDate &&
    JSON.stringify([...approval.approvedWorkerNames].sort()) ===
      JSON.stringify(preview.workers.map((worker) => worker.workerName).sort())
  );
}

/** Server permission and explicit send capability are both required, even for an approved row. */
export function laborApprovalActions(
  approval: LaborApprovalHistoryItem,
  capability: LaborApprovalWorkspaceData["capability"],
) {
  return {
    send:
      ["approved", "failed"].includes(approval.status) &&
      approval.canSend &&
      capability.supported &&
      capability.sendingEnabled,
    verify:
      approval.canVerify &&
      ["sending", "failed", "reconciliation_required"].includes(approval.status),
    revoke: approval.canRevoke && ["approved", "stale", "failed"].includes(approval.status),
  };
}

export const laborApprovalStatus: Record<LaborApprovalHistoryItem["status"], string> = {
  approved: "Approved · not sent",
  stale: "Changed · review again",
  sending: "Sending · awaiting confirmation",
  sent: "Sent and confirmed",
  failed: "Failed before dispatch",
  reconciliation_required: "Needs reconciliation",
  revoked: "Approval revoked",
};
