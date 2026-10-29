import type { LaborEntryAllocation } from "@svl/domain";
import { describe, expect, it } from "vitest";
import type { JobActivity, JobReceiptActivity } from "@/lib/labor/contract";
import { filterJobActivity, resolveJobSelection } from "./job-view";

const job = (id: string, patch: Partial<JobActivity> = {}): JobActivity => ({
  key: `housecall:${id}`,
  name: "TEST Job",
  address: "TEST Address",
  housecallJobId: id,
  hours: 1,
  travelHours: 0,
  reportedCostCents: null,
  entryCount: 1,
  workerCount: 1,
  receiptCount: 0,
  receiptTotalCents: null,
  receipts: [],
  allocationStatus: "mapped",
  ...patch,
});
const entry = (id: string, patch: Partial<LaborEntryAllocation> = {}): LaborEntryAllocation => ({
  sourceEntryId: "TEST-ENTRY",
  sourceRow: 1,
  date: "2026-09-24",
  workerName: "TEST Worker",
  sourceJobKey: "TEST-ORIGINAL",
  destinationSourceKey: "TEST-RESOLVED",
  sourceKind: "work",
  sourceHours: 1,
  status: "allocated",
  job: { key: `housecall:${id}`, name: "TEST Job", address: "TEST Address", housecallJobId: id },
  allocatedHours: 1,
  excludedHours: 0,
  pendingHours: 0,
  reason: "customer_work",
  reviewReasons: [],
  noteIds: [],
  ...patch,
});
const receipt = (
  id: string,
  submittedAt: string,
  amountCents: number | null = 1000,
): JobReceiptActivity => ({
  id,
  reference: id,
  vendor: "TEST Vendor",
  submittedAt,
  status: "submitted",
  amountCents,
  href: `/receipts/${id}`,
});

function activityFixture() {
  const jobs = [
    job("TEST-A", {
      hours: 999,
      travelHours: 888,
      entryCount: 777,
      workerCount: 666,
      receiptCount: 555,
      receiptTotalCents: 444,
      receipts: [
        receipt("TEST-A-BEFORE", "2026-10-04T16:00:00Z", 9000),
        receipt("TEST-A-START", "2026-10-05T16:00:00Z", 1000),
        receipt("TEST-A-END", "2026-10-06T16:00:00Z", 2000),
        receipt("TEST-A-AFTER", "2026-10-07T16:00:00Z", 8000),
      ],
    }),
    job("TEST-B", { receipts: [receipt("TEST-B-END", "2026-10-06T18:00:00Z", null)] }),
    job("TEST-C", { receipts: [receipt("TEST-C-AFTER", "2026-10-07T16:00:00Z")] }),
    job("TEST-EMPTY", { hours: 0, entryCount: 0, workerCount: 0 }),
  ];
  const allocation = (
    sourceEntryId: string,
    date: string,
    workerName: string,
    allocatedHours: number,
    sourceKind: "work" | "travel" = "work",
  ) =>
    entry("TEST-A", {
      sourceEntryId,
      date,
      workerName,
      sourceHours: 10,
      sourceKind,
      allocatedHours,
    });
  const allocations = [
    allocation("TEST-A-BEFORE", "2026-10-04", "TEST Alpha", 1.11),
    allocation("TEST-A-START", "2026-10-05", "TEST Alpha", 0.25, "travel"),
    allocation("TEST-A-BETA", "2026-10-05", "TEST Beta", 1.75),
    allocation("TEST-A-END", "2026-10-06", "TEST Alpha", 0.5),
    allocation("TEST-A-AFTER", "2026-10-07", "TEST Alpha", 4),
    entry("TEST-B", {
      sourceEntryId: "TEST-B-BEFORE",
      date: "2026-10-04",
      workerName: "TEST Beta",
      allocatedHours: 2,
    }),
    entry("TEST-A", {
      sourceEntryId: "TEST-PENDING",
      date: "2026-10-05",
      workerName: "TEST Alpha",
      sourceHours: 99,
      status: "pending",
      allocatedHours: 0,
      pendingHours: 99,
      reason: "no_next_customer",
    }),
    entry("TEST-A", {
      sourceEntryId: "TEST-EXCLUDED",
      date: "2026-10-05",
      workerName: "TEST Alpha",
      sourceHours: 88,
      status: "excluded",
      allocatedHours: 0,
      excludedHours: 88,
      reason: "initial_shop",
    }),
  ];
  const unassignedReceipts = [
    receipt("TEST-UNASSIGNED-BEFORE", "2026-10-04T16:00:00Z"),
    receipt("TEST-UNASSIGNED-START", "2026-10-05T16:00:00Z"),
    receipt("TEST-UNASSIGNED-AFTER", "2026-10-07T16:00:00Z"),
  ];
  return { jobs, allocations, unassignedReceipts };
}

describe("Jobs activity filters", () => {
  it("recomputes all summary cards and per-job activity from inclusive dates without changing sources", () => {
    const source = activityFixture();
    const original = structuredClone(source);
    const result = filterJobActivity(source.jobs, source.allocations, source.unassignedReceipts, {
      from: "2026-10-05",
      to: "2026-10-06",
      worker: "",
    });
    expect(result.summary).toEqual({
      jobCount: 2,
      allocatedHours: 2.5,
      assignedReceiptCount: 3,
      unassignedReceiptCount: 1,
    });
    expect(result.jobs.map((value) => value.key)).toEqual(["housecall:TEST-A", "housecall:TEST-B"]);
    expect(result.jobs[0]).toMatchObject({
      hours: 2.5,
      travelHours: 0.25,
      entryCount: 3,
      workerCount: 2,
      receiptCount: 2,
      receiptTotalCents: 3000,
    });
    expect(result.jobs[1]).toMatchObject({
      hours: 0,
      travelHours: 0,
      entryCount: 0,
      workerCount: 0,
      receiptCount: 1,
      receiptTotalCents: null,
    });
    expect(result.allocations.map((value) => value.sourceEntryId)).toEqual([
      "TEST-A-START",
      "TEST-A-BETA",
      "TEST-A-END",
      "TEST-PENDING",
      "TEST-EXCLUDED",
    ]);
    expect(result.unassignedReceipts.map((value) => value.id)).toEqual(["TEST-UNASSIGNED-START"]);
    expect(source).toEqual(original);
  });

  it("filters labor by worker while keeping date-matched receipts and receipt-only jobs", () => {
    const source = activityFixture();
    const result = filterJobActivity(source.jobs, source.allocations, source.unassignedReceipts, {
      from: "2026-10-05",
      to: "2026-10-06",
      worker: "TEST Alpha",
    });
    expect(result.summary).toEqual({
      jobCount: 2,
      allocatedHours: 0.75,
      assignedReceiptCount: 3,
      unassignedReceiptCount: 1,
    });
    expect(result.jobs[0]).toMatchObject({
      hours: 0.75,
      travelHours: 0.25,
      entryCount: 2,
      workerCount: 1,
      receiptCount: 2,
      receiptTotalCents: 3000,
    });
    expect(result.allocations.every((value) => value.workerName === "TEST Alpha")).toBe(true);
    expect(result.allocations.some((value) => value.status === "pending")).toBe(true);
    expect(result.jobs[1].receiptCount).toBe(1);
  });

  it("allows either date bound on its own and restores all activity when dates are cleared", () => {
    const source = activityFixture();
    const filter = (from: string, to: string) =>
      filterJobActivity(source.jobs, source.allocations, source.unassignedReceipts, {
        from,
        to,
        worker: "",
      });
    expect(filter("2026-10-06", "").allocations.map((value) => value.date)).toEqual([
      "2026-10-06",
      "2026-10-07",
    ]);
    expect(filter("", "2026-10-04").summary).toEqual({
      jobCount: 2,
      allocatedHours: 3.11,
      assignedReceiptCount: 1,
      unassignedReceiptCount: 1,
    });
    expect(filter("2026-10-08", "2026-10-09")).toMatchObject({
      jobs: [],
      allocations: [],
      unassignedReceipts: [],
      summary: {
        jobCount: 0,
        allocatedHours: 0,
        assignedReceiptCount: 0,
        unassignedReceiptCount: 0,
      },
    });
    const cleared = filter("", "");
    expect(cleared.summary).toEqual({
      jobCount: 3,
      allocatedHours: 9.61,
      assignedReceiptCount: 6,
      unassignedReceiptCount: 3,
    });
    expect(cleared.allocations).toEqual(source.allocations);
    expect(cleared.jobs.some((value) => value.key === "housecall:TEST-EMPTY")).toBe(false);
  });

  it("uses the New York submission date at both receipt boundaries and across daylight-saving time", () => {
    for (const [date, before, start, end, after] of [
      [
        "2026-10-05",
        "2026-10-05T03:59:59Z",
        "2026-10-05T04:00:00Z",
        "2026-10-06T03:59:59Z",
        "2026-10-06T04:00:00Z",
      ],
      [
        "2026-11-01",
        "2026-11-01T03:59:59Z",
        "2026-11-01T04:00:00Z",
        "2026-11-02T04:59:59Z",
        "2026-11-02T05:00:00Z",
      ],
    ]) {
      const receipts = [
        receipt("TEST-BEFORE", before),
        receipt("TEST-START", start, 123),
        receipt("TEST-END", end, 456),
        receipt("TEST-AFTER", after),
      ];
      const result = filterJobActivity([job("TEST-A", { receipts })], [], receipts, {
        from: date,
        to: date,
        worker: "TEST Worker With No Labor",
      });
      expect(result.jobs[0].receipts.map((value) => value.id)).toEqual(["TEST-START", "TEST-END"]);
      expect(result.unassignedReceipts.map((value) => value.id)).toEqual([
        "TEST-START",
        "TEST-END",
      ]);
      expect(result.jobs[0].receiptTotalCents).toBe(579);
      expect(result.summary).toEqual({
        jobCount: 1,
        allocatedHours: 0,
        assignedReceiptCount: 2,
        unassignedReceiptCount: 2,
      });
    }
  });

  it("keeps undated legacy receipts without dates but excludes them whenever a date bound is active", () => {
    const receipts = [receipt("TEST-INVALID", "not-a-date"), receipt("TEST-EMPTY-DATE", "")];
    expect(
      filterJobActivity([job("TEST-A", { receipts })], [], receipts, {
        from: "",
        to: "",
        worker: "TEST Other Worker",
      }).summary,
    ).toEqual({
      jobCount: 1,
      allocatedHours: 0,
      assignedReceiptCount: 2,
      unassignedReceiptCount: 2,
    });
    for (const dates of [
      { from: "2026-10-05", to: "" },
      { from: "", to: "2026-10-05" },
    ])
      expect(
        filterJobActivity([job("TEST-A", { receipts })], [], receipts, {
          ...dates,
          worker: "",
        }),
      ).toMatchObject({
        jobs: [],
        allocations: [],
        unassignedReceipts: [],
        summary: {
          jobCount: 0,
          allocatedHours: 0,
          assignedReceiptCount: 0,
          unassignedReceiptCount: 0,
        },
      });
  });

  it("counts split receipts per job grouping and retains a real zero-hour entry as activity", () => {
    const result = filterJobActivity(
      [
        job("TEST-A", {
          receipts: [receipt("TEST-SPLIT", "2026-10-05T16:00:00Z", 123)],
        }),
        job("TEST-B", {
          receipts: [receipt("TEST-SPLIT", "2026-10-05T16:00:00Z", 456)],
        }),
        job("TEST-ZERO"),
        job("TEST-PENDING-ONLY"),
        job("TEST-EXCLUDED-ONLY"),
      ],
      [
        entry("TEST-ZERO", {
          sourceEntryId: "TEST-ZERO-ENTRY",
          date: "2026-10-05",
          sourceHours: 0,
          allocatedHours: 0,
        }),
        entry("TEST-PENDING-ONLY", {
          sourceEntryId: "TEST-PENDING-ONLY-ENTRY",
          date: "2026-10-05",
          status: "pending",
          allocatedHours: 0,
          pendingHours: 1,
        }),
        entry("TEST-EXCLUDED-ONLY", {
          sourceEntryId: "TEST-EXCLUDED-ONLY-ENTRY",
          date: "2026-10-05",
          status: "excluded",
          allocatedHours: 0,
          excludedHours: 1,
        }),
      ],
      [],
      { from: "2026-10-05", to: "2026-10-05", worker: "" },
    );
    expect(result.summary).toEqual({
      jobCount: 3,
      allocatedHours: 0,
      assignedReceiptCount: 2,
      unassignedReceiptCount: 0,
    });
    expect(result.jobs.map((value) => value.key)).toEqual([
      "housecall:TEST-A",
      "housecall:TEST-B",
      "housecall:TEST-ZERO",
    ]);
    expect(result.jobs[0].receiptTotalCents).toBe(123);
    expect(result.jobs[1].receiptTotalCents).toBe(456);
    expect(result.jobs[2]).toMatchObject({
      hours: 0,
      entryCount: 1,
      workerCount: 1,
      receiptCount: 0,
    });
    expect(result.allocations).toHaveLength(3);
  });
});

describe("canonical Jobs selection", () => {
  it("supports canonical keys and a uniquely mapped resolved source destination", () => {
    expect(
      resolveJobSelection([job("TEST-A")], [entry("TEST-A")], "housecall:TEST-A").job?.key,
    ).toBe("housecall:TEST-A");
    expect(resolveJobSelection([job("TEST-A")], [entry("TEST-A")], "TEST-RESOLVED").job?.key).toBe(
      "housecall:TEST-A",
    );
    expect(
      resolveJobSelection([job("TEST-A")], [entry("TEST-A")], "TEST-ORIGINAL").job,
    ).toBeUndefined();
  });
  it("does not guess a canonical job when a source has multiple scoped destinations", () => {
    expect(
      resolveJobSelection(
        [job("TEST-A"), job("TEST-B")],
        [entry("TEST-A"), entry("TEST-B")],
        "TEST-RESOLVED",
      ),
    ).toEqual({ job: undefined, ambiguous: true });
  });
});
