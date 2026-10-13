import {
  allocateLaborHours,
  estimateLaborPay,
  type LaborEntry,
  type LaborMappingCatalogJob,
  linkLaborAllocation,
  sourceJobKey,
} from "@svl/domain";
import type { HousecallClient } from "@svl/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { laborApprovalSnapshotHash } from "./approval-context";
import type { LaborApprovalRecord } from "./approval-persistence";
import { laborApprovalAction, loadLaborApprovalWorkspace } from "./approval-service";
import type { LaborDashboardData } from "./contract";

const manager = "00000000-0000-4000-8000-000000000001";
const approvalId = "00000000-0000-4000-8000-000000000002";
const scope = { housecallJobId: "job_test", fromDate: "2026-09-17", toDate: "2026-09-17" };
const key = sourceJobKey("TEST Customer", "TEST Address");
const source: LaborEntry & { importId: string; importHash: string } = {
  id: "TEST-ENTRY",
  kind: "work",
  date: scope.fromDate,
  workerName: "TEST Worker",
  jobName: "TEST Customer",
  jobAddress: "TEST Address",
  clockIn: "08:00",
  clockOut: "16:00",
  clockInMethod: "AutoClock",
  clockOutMethod: "AutoClock",
  timeEntryType: "",
  crew: "",
  role: "",
  jobCode: null,
  employeeId: "TEST-EMPLOYEE",
  hours: 8,
  travel: false,
  laborCostCents: 99999,
  billableCostCents: 99999,
  sourceRow: 13,
  importId: "00000000-0000-4000-8000-000000000010",
  importHash: "a".repeat(64),
};
const catalog: LaborMappingCatalogJob = {
  id: scope.housecallJobId,
  customerId: "TEST-CUSTOMER",
  customer: "TEST Customer",
  number: "1001",
  label: "TEST Project",
  address: "TEST Address",
  status: "scheduled",
  active: true,
  unavailable: false,
  syncedAt: new Date().toISOString(),
  providerUpdatedAt: null,
  scheduledAt: null,
};
const completeDates = Array.from({ length: 7 }, (_, i) => `2026-09-${17 + i}`);
function context(rate = 2400, complete = true, extras: (typeof source)[] = []) {
  const entries = [structuredClone(source), ...structuredClone(extras)];
  const rules = {
    locations: [
      {
        sourceKey: key,
        kind: "customer" as const,
        job: { key, name: "TEST Customer", address: "TEST Address", housecallJobId: null },
      },
    ],
    jobAliases: [],
  };
  const allocation = linkLaborAllocation(
    allocateLaborHours({ entries, rules, completeDates }),
    [
      {
        sourceKey: key,
        housecallJobId: catalog.id,
        fromDate: scope.fromDate,
        toDate: scope.toDate,
        method: "reviewed",
        confirmedAt: "2026-09-24T00:00:00Z",
        confirmedBy: manager,
      },
    ],
    [catalog],
  );
  const paySettings = {
    workerRates: [{ workerName: source.workerName, hourlyRateCents: rate, active: true }],
    overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
  };
  const payroll = estimateLaborPay({
    workerDays: allocation.workerDays,
    settings: paySettings,
    completeDates: complete ? completeDates : [scope.fromDate],
  });
  return {
    sourceEntries: entries,
    storageRevision: 5,
    dashboard: {
      entries,
      allocation,
      paySettings,
      payroll,
      jobCatalog: { jobs: [catalog], complete: true, fingerprint: "TEST" },
    } as unknown as LaborDashboardData,
  };
}
let records: LaborApprovalRecord[];
const loadContext = vi.fn();
const db = {
  list: vi.fn(),
  create: vi.fn(),
  invalidate: vi.fn(),
  claim: vi.fn(),
  dispatch: vi.fn(),
  finish: vi.fn(),
  reconcile: vi.fn(),
};
const client = { executePreparedWrite: vi.fn(), reconcileWrite: vi.fn() };
const makeClient = vi.fn(() => client as unknown as HousecallClient);
const env = {
  HOUSECALL_READS_ENABLED: "true",
  HOUSECALL_ACCESS_MODE: "all_jobs",
  HOUSECALL_API_KEY: "FAKE-NEVER-LIVE",
  LABOR_HOUSECALL_SEND_ENABLED: "1",
};
const deps = { context: loadContext, store: db, client: makeClient, env };
beforeEach(() => {
  vi.clearAllMocks();
  records = [];
  loadContext.mockResolvedValue(context());
  db.list.mockImplementation(async () => records);
  db.create.mockImplementation(async (snapshot, sourceRevision, approvedBy) => {
    const record: LaborApprovalRecord = {
      id: approvalId,
      snapshot,
      snapshotHash: laborApprovalSnapshotHash(snapshot),
      sourceRevision,
      status: "approved",
      approvedBy,
      approvedAt: "2026-09-24T00:00:00Z",
      sentAt: null,
      lastError: null,
      providerReference: null,
      lastAttempt: null,
    };
    records.push(record);
    return record;
  });
  db.invalidate.mockImplementation(async (id, _actor, reason) => {
    const record = records.find((row) => row.id === id) as LaborApprovalRecord;
    record.status = reason;
    return record;
  });
  db.claim.mockImplementation(async () => ({
    approval: records[0],
    attempt: {
      id: "00000000-0000-4000-8000-000000000003",
      leaseToken: "00000000-0000-4000-8000-000000000004",
      expiresAt: new Date(Date.now() + 120000).toISOString(),
      sourceRevision: 5,
    },
  }));
  db.dispatch.mockImplementation(async () => ({ allowed: true, approval: records[0] }));
  db.finish.mockImplementation(async (_id, _attempt, _lease, outcome) => ({
    ...records[0],
    status: outcome.status,
  }));
  db.reconcile.mockImplementation(async (_id, evidence) => ({
    ...records[0],
    status: evidence.status === "sent" ? "sent" : "reconciliation_required",
  }));
  client.reconcileWrite.mockResolvedValue({ status: "absent" });
  client.executePreparedWrite.mockResolvedValue({ status: "accepted", httpStatus: 200 });
});
async function approve() {
  const workspace = await loadLaborApprovalWorkspace(scope, deps);
  await laborApprovalAction(
    {
      ...scope,
      action: "approve",
      reviewed: true,
      expectedSnapshotHash: workspace.preview.snapshotHash,
      expectedStorageRevision: workspace.preview.storageRevision,
    },
    manager,
    deps,
  );
  return records[0];
}
function send(record = records[0]) {
  return {
    action: "send",
    approvalId,
    expectedSnapshotHash: record?.snapshotHash,
    confirmed: true,
  };
}

describe("manager approval and explicit labor send", () => {
  it("previews exact paid hours/cents and approval stores the immutable provider intent without provider calls", async () => {
    const workspace = await loadLaborApprovalWorkspace(scope, deps);
    expect(workspace.preview.totalHours).toBe(8);
    expect(workspace.preview.costEstimate).toMatchObject({
      paidHours: 7.5,
      regularHours: 7.5,
      overtimeHours: 0,
      totalCostCents: 18000,
    });
    expect(workspace.preview.housecallInput).toMatchObject({ quantity: 1, unitCostCents: 18000 });
    expect(workspace.preview.costEstimate.policyDescription).toContain(
      "0.5 hours once per worker-day with at least 6 gross hours",
    );
    expect(workspace.preview.costEstimate.policyDescription).toContain("Thursday–Wednesday");
    expect(workspace.preview.costEstimate.policyDescription).toContain(
      "Source break deductions are not subtracted again",
    );
    const record = await approve();
    expect(record.snapshot.providerIntent?.preparedWrite.body.job_input_materials[0]).toMatchObject(
      { quantity: 1, unit_cost: 18000 },
    );
    expect(record.snapshot.disclosures).toMatchObject({
      lunchRedistributed: true,
      wageCostsIncluded: true,
    });
    expect(makeClient).not.toHaveBeenCalled();
  });
  it("rejects unchecked, changed-hash and stale-revision reviews before creating approval", async () => {
    const preview = (await loadLaborApprovalWorkspace(scope, deps)).preview;
    for (const override of [
      { reviewed: false },
      { expectedSnapshotHash: "b".repeat(64) },
      { expectedStorageRevision: 4 },
    ])
      await expect(
        laborApprovalAction(
          {
            ...scope,
            action: "approve",
            reviewed: true,
            expectedSnapshotHash: preview.snapshotHash,
            expectedStorageRevision: 5,
            ...override,
          },
          manager,
          deps,
        ),
      ).rejects.toThrow();
    expect(db.create).not.toHaveBeenCalled();
    expect(makeClient).not.toHaveBeenCalled();
  });
  it("does not authorize sending when receipt exports are enabled but the labor switch is off", async () => {
    await approve();
    await expect(
      laborApprovalAction(send(), manager, {
        ...deps,
        env: {
          ...env,
          HOUSECALL_EXPORT_MODE: "manager_approved",
          LABOR_HOUSECALL_SEND_ENABLED: "0",
        },
      }),
    ).rejects.toThrow("disabled");
    expect(db.claim).not.toHaveBeenCalled();
    expect(makeClient).not.toHaveBeenCalled();
  });
  it("blocks incomplete weekly cost approval while still showing provisional estimated cents", async () => {
    loadContext.mockResolvedValue(context(2400, false));
    const preview = (await loadLaborApprovalWorkspace(scope, deps)).preview;
    expect(preview.costEstimate.totalCostCents).toBe(18000);
    expect(preview.blockers.join(" ")).toContain("complete workweek");
    await expect(
      laborApprovalAction({ ...scope, action: "approve", reviewed: true }, manager, deps),
    ).rejects.toThrow("complete workweek");
    expect(db.create).not.toHaveBeenCalled();
  });
  it("invalidates a prior approval after rates change, including before any send claim", async () => {
    await approve();
    loadContext.mockResolvedValue(context(2500));
    const history = (await loadLaborApprovalWorkspace(scope, deps)).approvals[0];
    expect(history.status).toBe("stale");
    expect(history.canSend).toBe(false);
    await expect(laborApprovalAction(send(), manager, deps)).rejects.toThrow("changed");
    expect(db.invalidate).toHaveBeenCalledWith(approvalId, manager, "stale");
    expect(db.claim).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
  it("lets a manager explicitly select priced workers without treating an owner's missing rate as zero", async () => {
    const owner = {
      ...source,
      id: "TEST-OWNER",
      workerName: "TEST Owner",
      employeeId: "TEST-OWNER-ID",
      sourceRow: 14,
    };
    loadContext.mockResolvedValue(context(2400, true, [owner]));
    const all = (await loadLaborApprovalWorkspace(scope, deps)).preview;
    expect(all.costEstimate.totalCostCents).toBeNull();
    expect(all.costEstimate.unpricedHours).toBe(7.5);
    const selected = { ...scope, workerNames: [source.workerName] };
    const preview = (await loadLaborApprovalWorkspace(selected, deps)).preview;
    expect(preview.availableWorkers).toHaveLength(2);
    expect(preview.costEstimate.totalCostCents).toBe(18000);
    expect(preview.blockers).toEqual([]);
    await laborApprovalAction(
      {
        ...selected,
        action: "approve",
        reviewed: true,
        expectedSnapshotHash: preview.snapshotHash,
        expectedStorageRevision: 5,
      },
      manager,
      deps,
    );
    expect(records[0].snapshot.approvedWorkerNames).toEqual([source.workerName]);
    expect(records[0].snapshot.entries).toHaveLength(1);
    expect((await loadLaborApprovalWorkspace(selected, deps)).approvals[0].status).toBe("approved");
    expect(makeClient).not.toHaveBeenCalled();
  });
  it("recalculates the reviewed job's lunch cost when non-job time changes in the same worker day", async () => {
    await approve();
    loadContext.mockResolvedValue(
      context(2400, true, [
        {
          ...source,
          id: "TEST-OTHER-TIME",
          jobName: "TEST Other",
          clockIn: "16:00",
          clockOut: "17:00",
          hours: 1,
          sourceRow: 14,
        },
      ]),
    );
    const next = await loadLaborApprovalWorkspace(scope, deps);
    expect(next.preview.totalHours).toBe(8);
    expect(next.preview.costEstimate.paidHours).toBe(7.56);
    expect(next.preview.costEstimate.totalCostCents).toBe(18144);
    expect(next.approvals[0].status).toBe("stale");
    expect(next.approvals[0].canSend).toBe(false);
  });
  it("retains zero-hour source evidence without blocking approval of positive job time", async () => {
    loadContext.mockResolvedValue(
      context(2400, true, [
        {
          ...source,
          id: "TEST-ZERO",
          hours: 0,
          clockIn: "16:00",
          clockOut: "16:00",
          sourceRow: 14,
        },
      ]),
    );
    const preview = (await loadLaborApprovalWorkspace(scope, deps)).preview;
    expect(preview.entryCount).toBe(1);
    expect(preview.totalHours).toBe(8);
    expect(preview.blockers).toEqual([]);
    expect(preview.warnings.join(" ")).toContain("Zero-hour source rows");
    await laborApprovalAction(
      {
        ...scope,
        action: "approve",
        reviewed: true,
        expectedSnapshotHash: preview.snapshotHash,
        expectedStorageRevision: 5,
      },
      manager,
      deps,
    );
    expect(records[0].snapshot.entries).toHaveLength(1);
  });
  it("keeps rounded same-minute hundredths in reviewed paid hours and exact cents", async () => {
    loadContext.mockResolvedValue(
      context(2400, true, [
        {
          ...source,
          id: "TEST-POINT",
          hours: 0.01,
          clockIn: "08:00",
          clockOut: "08:00",
          sourceRow: 14,
        },
      ]),
    );
    const preview = (await loadLaborApprovalWorkspace(scope, deps)).preview;
    expect(preview.entryCount).toBe(2);
    expect(preview.totalHours).toBe(8.01);
    expect(preview.costEstimate).toMatchObject({ paidHours: 7.51, totalCostCents: 18024 });
    expect(preview.warnings.join(" ")).toContain("short source interval");
    expect(preview.blockers).toEqual([]);
  });
  it("checks the final durable dispatch guard before a provider write", async () => {
    await approve();
    db.dispatch.mockResolvedValue({ allowed: false, approval: records[0] });
    await expect(laborApprovalAction(send(), manager, deps)).rejects.toThrow("before dispatch");
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
  it("sends exactly the frozen request once with a fresh manual-send permit then verifies readback", async () => {
    await approve();
    client.reconcileWrite
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "found", providerId: "TEST-MATERIAL" });
    const result = await laborApprovalAction(send(), manager, deps);
    expect(result.approval.status).toBe("sent");
    expect(client.executePreparedWrite).toHaveBeenCalledTimes(1);
    expect(client.executePreparedWrite.mock.calls[0][0]).toEqual(
      records[0].snapshot.providerIntent?.preparedWrite,
    );
    expect(client.executePreparedWrite.mock.calls[0][1]).toMatchObject({
      approvedBy: manager,
      expectedCustomerId: catalog.customerId,
    });
    expect(Date.parse(client.executePreparedWrite.mock.calls[0][1].approvedAt)).toBeGreaterThan(
      Date.now() - 5000,
    );
  });
  it("does not resend when the exact provider reference already exists", async () => {
    await approve();
    client.reconcileWrite.mockResolvedValue({ status: "found", providerId: "TEST-EXISTING" });
    expect((await laborApprovalAction(send(), manager, deps)).approval.status).toBe("sent");
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
  it("retains uncertain dispatch and verification never grants another write even when readback is absent", async () => {
    await approve();
    client.executePreparedWrite.mockRejectedValueOnce(new Error("TEST lost response"));
    expect((await laborApprovalAction(send(), manager, deps)).approval.status).toBe(
      "reconciliation_required",
    );
    records[0].status = "reconciliation_required";
    client.executePreparedWrite.mockClear();
    client.reconcileWrite.mockResolvedValue({ status: "absent" });
    expect(
      (await laborApprovalAction({ action: "verify", approvalId }, manager, deps)).approval.status,
    ).toBe("reconciliation_required");
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    await expect(laborApprovalAction(send(), manager, deps)).rejects.toThrow(
      "cannot be sent again",
    );
  });
  it("refuses sent/revoked/stale records and tampered frozen requests before writes", async () => {
    await approve();
    for (const status of ["sent", "revoked", "stale"] as const) {
      records[0].status = status;
      await expect(laborApprovalAction(send(), manager, deps)).rejects.toThrow(
        "cannot be sent again",
      );
    }
    records[0].status = "approved";
    const write = records[0].snapshot.providerIntent?.preparedWrite;
    if (write) write.body.job_input_materials[0].unit_cost++;
    await expect(laborApprovalAction(send(), manager, deps)).rejects.toThrow(
      "could not be verified",
    );
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
});
