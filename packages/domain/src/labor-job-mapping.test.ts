import { describe, expect, it } from "vitest";
import { type LaborEntry, sourceJobKey } from "./labor";
import { allocateLaborHours, type LaborAllocationRules } from "./labor-allocation";
import {
  collectLaborMappingSources,
  type LaborJobMapping,
  type LaborMappingCatalogJob,
  type LaborMappingSource,
  linkLaborAllocation,
  matchLaborJobs,
} from "./labor-job-mapping";

const now = Date.parse("2026-10-13T12:00:00Z");
const source: LaborMappingSource = {
  sourceKey: sourceJobKey("TEST Source, TEST Customer", "123 Test Road, Toledo, OH 43614"),
  name: "TEST Source, TEST Customer",
  address: "123 Test Road, Toledo, OH 43614",
  jobCodes: [],
  fromDate: "2026-09-17",
  toDate: "2026-10-07",
  classification: "customer",
};
const job = (overrides: Partial<LaborMappingCatalogJob> = {}): LaborMappingCatalogJob => ({
  id: "TEST-HCP",
  customerId: "TEST-CUSTOMER",
  customer: "TEST Customer TEST Source",
  number: "TEST-1991",
  label: "TEST Job 1991",
  address: source.address,
  status: "completed",
  scheduledAt: "2026-09-20T12:00:00Z",
  active: false,
  unavailable: false,
  syncedAt: "2026-10-13T10:00:00Z",
  providerUpdatedAt: null,
  ...overrides,
});
const match = (
  catalog: LaborMappingCatalogJob[],
  override: Partial<LaborMappingSource> = {},
  complete = true,
) => matchLaborJobs([{ ...source, ...override }], catalog, { catalogComplete: complete, now })[0];
const mapping = (overrides: Partial<LaborJobMapping> = {}): LaborJobMapping => ({
  sourceKey: source.sourceKey,
  housecallJobId: "TEST-HCP",
  fromDate: source.fromDate,
  toDate: source.toDate,
  confirmedAt: "2026-10-13T12:00:00Z",
  confirmedBy: "TEST-MANAGER",
  method: "reviewed",
  ...overrides,
});
const row = (
  id: string,
  name: string,
  address: string,
  date = "2026-09-24",
  workerName = "Worker, Test",
): LaborEntry => ({
  id,
  kind: "work",
  date,
  workerName,
  jobName: name,
  jobAddress: address,
  clockIn: "08:00",
  clockOut: "10:00",
  clockInMethod: "Manual",
  clockOutMethod: "Manual",
  timeEntryType: "",
  crew: "",
  role: "",
  jobCode: "TEST-1991",
  employeeId: null,
  hours: 2,
  travel: false,
  laborCostCents: 9876,
  billableCostCents: 0,
  sourceRow: 1,
});
const location = (name: string, address: string) => ({
  sourceKey: sourceJobKey(name, address),
  kind: "customer" as const,
  job: { key: sourceJobKey(name, address), name, address, housecallJobId: null },
});

describe("conservative Housecall job matching", () => {
  it("accepts one exact full customer and address including a historical completed job", () => {
    expect(match([job()])).toMatchObject({
      status: "exact_customer_address",
      automaticJobId: "TEST-HCP",
    });
  });
  it("keeps duplicate customer/address jobs in review even if one is newer or unavailable", () => {
    expect(
      match([job(), job({ id: "TEST-SECOND", active: true, unavailable: true })]),
    ).toMatchObject({ status: "review", automaticJobId: null });
  });
  it("does not use partial streets, changed units, customer surnames or job number alone as proof", () => {
    for (const override of [
      { address: "123 Test Road" },
      { address: "123 Test Road, Toledo, OH 43614 Unit 2" },
      { name: "Source" },
      { name: "Another Customer", address: "Other Address", jobCodes: ["TEST-1991"] },
    ])
      expect(match([job()], override)?.automaticJobId).toBeNull();
  });
  it("offers property and name-token differences as review-only suggestions", () => {
    const partial = match([job({ address: "123 Test Rd, Toledo, OH 43614" })], {
      address: "123 Test Road",
    });
    expect(partial?.candidates[0]?.reasons).toContain("property_address");
    expect(partial?.automaticJobId).toBeNull();
    const discrepancy = match([
      job({ address: "124 Test Road", customer: "TEST Customer and TEST Extra TEST Source" }),
    ]);
    expect(discrepancy?.candidates[0]?.reasons).toContain("customer_name_token");
    expect(discrepancy?.automaticJobId).toBeNull();
    expect(
      match([job({ address: "123 Test Road Unit 2" })], { address: "123 Test Road" })?.candidates[0]
        ?.reasons,
    ).not.toContain("property_address");
  });
  it("fails closed for incomplete catalog, stale entries and missing customer identity", () => {
    expect(match([job()], {}, false)?.status).toBe("catalog_incomplete");
    for (const override of [
      { syncedAt: "2026-10-10T12:00:00Z" },
      { customerId: null },
      { unavailable: true },
      { syncedAt: null },
    ])
      expect(match([job(override)])?.automaticJobId).toBeNull();
  });
  it("does not offer customer matches for suppliers or unknown locations", () => {
    expect(match([job()], { classification: "unknown" })?.status).toBe("not_customer");
    expect(match([job()], { classification: "supplier" })?.candidates).toEqual([]);
  });
  it("rejects duplicate catalog identifiers rather than silently claiming uniqueness", () => {
    expect(() => match([job(), job()])).toThrow(/unique/);
  });
});

describe("scoped canonical labor links", () => {
  const other = location("Other Source", "TEST Second Address");
  const rules: LaborAllocationRules = {
    locations: [location(source.name, source.address), other],
    jobAliases: [],
  };
  const entries = [
    row("TEST-A", source.name, source.address),
    row("TEST-B", other.job.name, other.job.address, "2026-09-25", "Test Worker"),
    row("TEST-FUTURE", source.name, source.address, "2026-10-08"),
  ];
  const report = allocateLaborHours({ entries, rules, completeDates: entries.map((e) => e.date) });
  it("consolidates source aliases into one Housecall job while retaining audit and all totals", () => {
    const before = JSON.stringify(report);
    const result = linkLaborAllocation(
      report,
      [mapping(), mapping({ sourceKey: other.sourceKey })],
      [job()],
    );
    expect(result.jobs.find((j) => j.job.key === "housecall:TEST-HCP")).toMatchObject({
      hours: 4,
      entryCount: 2,
      workerCount: 1,
      costCents: null,
    });
    expect(result.entries.find((e) => e.sourceEntryId === "TEST-A")).toMatchObject({
      sourceJobKey: source.sourceKey,
      destinationSourceKey: source.sourceKey,
      jobMapping: mapping(),
    });
    expect(result.totals).toEqual(report.totals);
    expect(result.workerDays).toEqual(report.workerDays);
    expect(JSON.stringify(report)).toBe(before);
  });
  it("does not carry a confirmed imported-date link to future imports", () => {
    const result = linkLaborAllocation(report, [mapping()], [job()]);
    expect(
      result.entries.find((e) => e.sourceEntryId === "TEST-FUTURE")?.job?.housecallJobId,
    ).toBeNull();
  });
  it("maps the resolved correction destination rather than the original source", () => {
    const corrected = {
      ...report,
      entries: report.entries.map((e) =>
        e.sourceEntryId === "TEST-A" ? { ...e, job: other.job } : e,
      ),
    };
    const result = linkLaborAllocation(
      corrected,
      [mapping({ sourceKey: other.sourceKey, housecallJobId: "TEST-CORRECTED" })],
      [job({ id: "TEST-CORRECTED" })],
    );
    expect(result.entries.find((e) => e.sourceEntryId === "TEST-A")).toMatchObject({
      sourceJobKey: source.sourceKey,
      destinationSourceKey: other.sourceKey,
      job: { housecallJobId: "TEST-CORRECTED" },
    });
  });
  it("clears canonical provenance when links are removed and restores the raw source name", () => {
    const linked = linkLaborAllocation(report, [mapping()], [job()]);
    const unlinked = linkLaborAllocation(linked, [], [job()]);
    expect(unlinked.entries.find((e) => e.sourceEntryId === "TEST-A")).toMatchObject({
      destinationSourceKey: source.sourceKey,
      jobMapping: undefined,
      job: {
        key: source.sourceKey,
        name: source.name,
        address: source.address,
        housecallJobId: null,
      },
    });
  });
  it("rejects invalid or overlapping date scopes; supports nonoverlapping same-source assignments", () => {
    expect(() => linkLaborAllocation(report, [mapping({ fromDate: "2026-02-30" })], [])).toThrow(
      /valid/,
    );
    expect(() =>
      linkLaborAllocation(report, [mapping(), mapping({ housecallJobId: "TEST-OTHER" })], []),
    ).toThrow(/Overlapping/);
    expect(() =>
      linkLaborAllocation(
        report,
        [
          mapping(),
          mapping({ fromDate: "2026-10-08", toDate: "2026-10-08", housecallJobId: "TEST-OTHER" }),
        ],
        [],
      ),
    ).not.toThrow();
  });
  it("collects source identities, codes and resolved destination work-date scope without breaks", () => {
    const corrected = {
      ...report,
      entries: report.entries.map((e) =>
        e.sourceEntryId === "TEST-A" ? { ...e, job: other.job } : e,
      ),
    };
    const sources = collectLaborMappingSources(corrected, rules.locations, entries);
    expect(sources.find((s) => s.sourceKey === other.sourceKey)).toMatchObject({
      name: other.job.name,
      address: other.job.address,
      fromDate: "2026-09-24",
      toDate: "2026-09-25",
      classification: "customer",
      jobCodes: ["TEST-1991"],
    });
    expect(sources.find((s) => s.sourceKey === source.sourceKey)?.toDate).toBe("2026-10-08");
  });
});
