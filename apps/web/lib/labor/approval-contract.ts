/** Browser-safe review model; frozen provider intents and credentials remain server-only. */
export type LaborApprovalPreview = {
  housecallJobId: string;
  jobName: string;
  address: string;
  fromDate: string;
  toDate: string;
  snapshotHash: string;
  storageRevision: number | null;
  totalHours: number;
  travelHours: number;
  entryCount: number;
  availableWorkers: { workerName: string; hours: number }[];
  workers: {
    workerName: string;
    hours: number;
    days: { date: string; hours: number; travelHours: number; entryCount: number }[];
  }[];
  entries: {
    sourceEntryId: string;
    workerName: string;
    date: string;
    sourceJobName: string;
    clockIn: string;
    clockOut: string;
    sourceHours: number;
    hours: number;
    reason: string;
    originalUrl: string;
    sourceRow: number;
  }[];
  lunchDisclosure: string;
  warnings: string[];
  blockers: string[];
  unresolved: { entryCount: number; hours: number };
  costEstimate: {
    policyDescription: string;
    paidHours: number;
    regularHours: number | null;
    overtimeHours: number | null;
    totalCostCents: number | null;
    unpricedHours: number;
    workers: {
      workerName: string;
      hourlyRateCents: number | null;
      overtimeMultiplier: number;
      paidHours: number;
      regularHours: number | null;
      overtimeHours: number | null;
      costCents: number | null;
    }[];
  };
  housecallInput: {
    name: string;
    description: string;
    quantity: number;
    unitCostCents: number;
  } | null;
};

export type LaborApprovalHistoryItem = {
  id: string;
  housecallJobId: string;
  jobName: string;
  fromDate: string;
  toDate: string;
  snapshotHash: string;
  hours: number;
  paidHours: number;
  estimatedCostCents: number;
  approvedWorkerNames: string[];
  status:
    | "approved"
    | "stale"
    | "sending"
    | "sent"
    | "failed"
    | "reconciliation_required"
    | "revoked";
  approvedAt: string;
  approvedBy: string;
  sentAt: string | null;
  lastError: string | null;
  canSend: boolean;
  canVerify: boolean;
  canRevoke: boolean;
};

export type LaborApprovalWorkspaceData = {
  capability: {
    supported: boolean;
    sendingEnabled: boolean;
    message: string;
  };
  preview: LaborApprovalPreview;
  approvals: LaborApprovalHistoryItem[];
};
