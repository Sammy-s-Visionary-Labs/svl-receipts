import type { SupabaseClient } from "@supabase/supabase-js";
import {
  allocateLaborHours,
  type LaborEntry,
  linkLaborAllocation,
  sourceJobKey,
} from "@svl/domain";
import { describe, expect, it, vi } from "vitest";
import type { JobActivity } from "./contract";
import { addLocalReceiptActivities, addReceiptActivities, loadJobsDashboard } from "./jobs";
import type { LocalReceipt } from "./store";

vi.mock("./store", () => ({
  loadLaborDashboard: async () => ({ development: true, jobs: [], entries: [] }),
  loadLocalReceipts: async () => [],
}));

const receipt = (id = "TEST-RECEIPT") => ({
  id,
  status: "ingested",
  submitted_at: null,
  created_at: "2026-09-24",
});
const localReceipt = (overrides: Partial<LocalReceipt> = {}): LocalReceipt => ({
  id: "TEST-LOCAL-RECEIPT",
  reference: "TEST-LOCAL",
  vendor: "TEST Vendor",
  submittedAt: "2026-09-24",
  status: "ingested",
  amountCents: 1000,
  jobKey: JSON.stringify(["TEST Receipts-only job", "TEST Address"]),
  href: "/?receipt=unsupported",
  developmentFixture: true,
  ...overrides,
});
const job = (overrides: Partial<JobActivity> = {}): JobActivity => ({
  key: "TEST-SOURCE-JOB",
  name: "TEST Source job",
  address: "TEST Address",
  housecallJobId: null,
  hours: 1,
  travelHours: 0,
  reportedCostCents: 0,
  entryCount: 1,
  workerCount: 1,
  receiptCount: 0,
  receiptTotalCents: null,
  receipts: [],
  allocationStatus: "source_only",
  ...overrides,
});

describe("job receipt attribution", () => {
  it("uses each job's assigned line cost rather than repeating the receipt total", () => {
    const result = addReceiptActivities(
      [],
      [
        {
          id: "TEST-RECEIPT-1",
          status: "approved",
          submitted_at: "2026-09-24",
          created_at: "2026-09-24",
        },
      ],
      [
        { receipt_id: "TEST-RECEIPT-1", job_id: "TEST-JOB-A", qty: "2", unit_cost_cents: 500 },
        { receipt_id: "TEST-RECEIPT-1", job_id: "TEST-JOB-B", qty: "3", unit_cost_cents: 700 },
      ],
      [
        { id: "TEST-JOB-A", label: "TEST job A", customer: null, service_address: null },
        { id: "TEST-JOB-B", label: "TEST job B", customer: null, service_address: null },
      ],
    );
    expect(result.jobs.map((job) => job.receiptTotalCents)).toEqual([1000, 2100]);
    expect(result.jobs.map((job) => job.receiptCount)).toEqual([1, 1]);
  });

  it("keeps unassigned receipts visible without guessing a job", () => {
    const result = addReceiptActivities(
      [],
      [{ id: "TEST-UNASSIGNED", status: "ingested", submitted_at: null, created_at: "2026-09-24" }],
      [],
      [],
    );
    expect(result.jobs).toEqual([]);
    expect(result.unassignedReceipts.map((receipt) => receipt.id)).toEqual(["TEST-UNASSIGNED"]);
    expect(result.unassignedReceipts[0]?.href).toBe("/receipts/TEST-UNASSIGNED");
  });

  it("shows mixed unassigned portions without repeating an assigned job's amount", () => {
    const result = addReceiptActivities(
      [],
      [receipt()],
      [
        { receipt_id: "TEST-RECEIPT", job_id: "TEST-JOB", qty: "2", unit_cost_cents: 500 },
        { receipt_id: "TEST-RECEIPT", job_id: null, qty: "3", unit_cost_cents: 700 },
      ],
      [],
    );
    expect(result.jobs[0]?.receiptTotalCents).toBe(1000);
    expect(result.unassignedReceipts[0]?.amountCents).toBe(2100);
    expect(result.jobs[0]?.receipts[0]?.href).toBe("/receipts/TEST-RECEIPT");
  });

  it("uses the real receipt review path and encodes the complete identifier", () => {
    const result = addReceiptActivities([], [receipt("TEST/RECEIPT?ID")], [], []);
    expect(result.unassignedReceipts[0]?.href).toBe("/receipts/TEST%2FRECEIPT%3FID");
  });

  it("retains unknown line amounts and uses exact decimal half-cent rounding", () => {
    const result = addReceiptActivities(
      [],
      [receipt()],
      [
        { receipt_id: "TEST-RECEIPT", job_id: "TEST-JOB", qty: "0.29", unit_cost_cents: 50 },
        { receipt_id: "TEST-RECEIPT", job_id: null, qty: "", unit_cost_cents: 700 },
      ],
      [],
    );
    // 0.29 * 50 is 14.499999999999998 in binary arithmetic, but 14.5 in source decimal units.
    expect(result.jobs[0]?.receiptTotalCents).toBe(15);
    expect(result.unassignedReceipts[0]?.amountCents).toBeNull();
    const unknownAssigned = addReceiptActivities(
      [],
      [receipt()],
      [{ receipt_id: "TEST-RECEIPT", job_id: "TEST-JOB", qty: "not known", unit_cost_cents: 50 }],
      [],
    );
    expect(unknownAssigned.jobs[0]?.receiptTotalCents).toBeNull();
  });

  it("does not count an existing receipt twice when adding the same reviewed destination", () => {
    const existing = localReceipt({ id: "TEST-RECEIPT", jobKey: "TEST-SOURCE-JOB" });
    const source = job({
      housecallJobId: "TEST-JOB",
      receipts: [existing],
      receiptCount: 1,
      receiptTotalCents: 1000,
    });
    const result = addReceiptActivities(
      [source],
      [receipt(), receipt()],
      [{ receipt_id: "TEST-RECEIPT", job_id: "TEST-JOB", qty: 2, unit_cost_cents: 600 }],
      [],
    );
    expect(result.jobs[0]?.receiptCount).toBe(1);
    expect(result.jobs[0]?.receiptTotalCents).toBe(1200);
    expect(source.receipts[0]?.amountCents).toBe(1000);
  });
});

describe("canonical labor and receipt consolidation", () => {
  it("combines two source destinations with one worker and attaches assigned receipt lines once", () => {
    const entries: LaborEntry[] = ["TEST Source A", "TEST Source B"].map((name, index) => ({
      id: `TEST-ENTRY-${index}`,
      kind: "work",
      date: `2026-09-${24 + index}`,
      workerName: index ? "Test Worker" : "Worker, Test",
      jobName: name,
      jobAddress: "123 TEST Address",
      clockIn: "08:00",
      clockOut: "10:00",
      clockInMethod: "Manual",
      clockOutMethod: "Manual",
      timeEntryType: "",
      crew: "",
      role: "",
      jobCode: null,
      employeeId: null,
      hours: 2,
      travel: false,
      laborCostCents: 4321,
      billableCostCents: 0,
      sourceRow: index + 1,
    }));
    const locations = entries.map((entry) => {
      const key = sourceJobKey(entry.jobName, entry.jobAddress);
      return {
        sourceKey: key,
        kind: "customer" as const,
        job: { key, name: entry.jobName, address: entry.jobAddress, housecallJobId: null },
      };
    });
    const raw = allocateLaborHours({
      entries,
      rules: { locations, jobAliases: [] },
      completeDates: entries.map((entry) => entry.date),
    });
    const linked = linkLaborAllocation(
      raw,
      locations.map((location) => ({
        sourceKey: location.sourceKey,
        housecallJobId: "TEST-HCP",
        fromDate: "2026-09-24",
        toDate: "2026-09-25",
        confirmedAt: "2026-10-13T12:00:00Z",
        confirmedBy: "TEST-MANAGER",
        method: "reviewed" as const,
      })),
      [],
    );
    const activities = linked.jobs.map((summary) =>
      job({
        key: summary.job.key,
        housecallJobId: summary.job.housecallJobId,
        hours: summary.hours,
        entryCount: summary.entryCount,
        workerCount: summary.workerCount,
        reportedCostCents: null,
        allocationStatus: "mapped",
      }),
    );
    const result = addReceiptActivities(
      activities,
      [receipt()],
      [{ receipt_id: "TEST-RECEIPT", job_id: "TEST-HCP", qty: "0.29", unit_cost_cents: 50 }],
      [],
    );
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      key: "housecall:TEST-HCP",
      hours: 4,
      entryCount: 2,
      workerCount: 1,
      receiptCount: 1,
      receiptTotalCents: 15,
      reportedCostCents: null,
    });
    expect(linked.totals).toEqual(raw.totals);
    expect(entries.map((entry) => entry.laborCostCents)).toEqual([4321, 4321]);
  });
  it("rejects unmerged aliases instead of assigning receipts to only the first matching job", () => {
    expect(() =>
      addReceiptActivities(
        [
          job({ housecallJobId: "TEST-HCP" }),
          job({ key: "TEST-SECOND", housecallJobId: "TEST-HCP" }),
        ],
        [receipt()],
        [],
        [],
      ),
    ).toThrow(/consolidated/);
  });
});

describe("development database receipt visibility", () => {
  it("excludes pending, unsubmitted, deleted and purge-claimed receipts from job activity", async () => {
    const visible = {
      ...receipt("TEST-VISIBLE"),
      submitted_at: "2026-09-24",
      content_deleted_at: null,
      purge_claimed_at: null,
    };
    const records = [
      visible,
      { ...visible, id: "TEST-DELETED", content_deleted_at: "2026-09-25" },
      { ...visible, id: "TEST-PURGING", purge_claimed_at: "2026-09-25" },
      { ...visible, id: "TEST-UNSUBMITTED", submitted_at: null },
      { ...visible, id: "TEST-PENDING", status: "upload_pending" },
    ];
    const tables: Record<string, Record<string, unknown>[]> = {
      receipts: records,
      receipt_lines: records.map((value) => ({
        receipt_id: value.id,
        job_id: "TEST-JOB",
        qty: 1,
        unit_cost_cents: 500,
      })),
      manager_job_catalog: [
        { id: "TEST-JOB", label: "TEST Job", customer: null, service_address: null },
      ],
    };
    // A small in-memory database double applies the actual PostgREST predicates to source fixtures.
    const db = {
      from(table: string) {
        let rows = [...(tables[table] ?? [])];
        const query = {
          select: () => query,
          order: () => query,
          not(column: string, operator: string, value: unknown) {
            if (operator !== "is") throw new Error("Unsupported TEST operator");
            rows = rows.filter((row) => row[column] !== value);
            return query;
          },
          is(column: string, value: unknown) {
            rows = rows.filter((row) => row[column] === value);
            return query;
          },
          neq(column: string, value: unknown) {
            rows = rows.filter((row) => row[column] !== value);
            return query;
          },
          range: async (from: number, to: number) => ({
            data: rows.slice(from, to + 1),
            error: null,
          }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const result = await loadJobsDashboard(db);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]?.receipts.map((value) => value.id)).toEqual(["TEST-VISIBLE"]);
    expect(result.jobs[0]?.receiptTotalCents).toBe(500);
  });
});

describe("local source receipt destinations", () => {
  it("keeps a receipts-only job visible without inventing a Housecall mapping", () => {
    const result = addLocalReceiptActivities([], [localReceipt()]);
    expect(result.jobs[0]).toMatchObject({
      name: "TEST Receipts-only job",
      address: "TEST Address",
      housecallJobId: null,
      hours: 0,
      entryCount: 0,
      receiptCount: 1,
      receiptTotalCents: 1000,
      allocationStatus: "source_only",
    });
    expect(result.jobs[0]?.receipts[0]?.href).toBeNull();
  });

  it("adds local receipts once and keeps totals unknown when one amount is unknown", () => {
    const first = localReceipt({ jobKey: "TEST-SOURCE-JOB" });
    const source = job({ receipts: [first], receiptCount: 1, receiptTotalCents: 1000 });
    const unknown = localReceipt({
      id: "TEST-UNKNOWN",
      jobKey: "TEST-SOURCE-JOB",
      amountCents: null,
    });
    const result = addLocalReceiptActivities([source], [first, unknown]);
    expect(result.jobs[0]?.receiptCount).toBe(2);
    expect(result.jobs[0]?.receiptTotalCents).toBeNull();
    expect(source.receipts).toHaveLength(1);
  });

  it("keeps unassigned local receipts separate from source jobs", () => {
    const result = addLocalReceiptActivities(
      [],
      [localReceipt({ jobKey: null, amountCents: null })],
    );
    expect(result.jobs).toEqual([]);
    expect(result.unassignedReceipts).toHaveLength(1);
    expect(result.unassignedReceipts[0]?.amountCents).toBeNull();
  });
});
