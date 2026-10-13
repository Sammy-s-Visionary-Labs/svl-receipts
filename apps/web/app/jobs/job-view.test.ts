import type { LaborEntryAllocation } from "@svl/domain";
import { describe, expect, it } from "vitest";
import type { JobActivity } from "@/lib/labor/contract";
import { resolveJobSelection } from "./job-view";

const job = (id: string): JobActivity => ({
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
});
const entry = (id: string): LaborEntryAllocation => ({
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
