import type { LaborEntry } from "./labor";
import {
  type LaborAllocationReport,
  type LaborEntryAllocation,
  normalizeLaborWorkerName,
  type ReviewedLaborLocation,
} from "./labor-allocation";

export const LABOR_JOB_CATALOG_STALE_MS = 26 * 60 * 60 * 1000;

export interface LaborJobMapping {
  readonly sourceKey: string;
  readonly housecallJobId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly confirmedAt: string;
  readonly confirmedBy: string;
  readonly method: "reviewed" | "exact_customer_address";
}

export interface LaborMappingCatalogJob {
  readonly id: string;
  readonly customerId: string | null;
  readonly customer: string | null;
  readonly number: string | null;
  readonly label: string;
  readonly address: string | null;
  readonly status: string | null;
  readonly scheduledAt: string | null;
  readonly active: boolean;
  readonly unavailable: boolean;
  readonly syncedAt: string | null;
  readonly providerUpdatedAt: string | null;
}

export interface LaborJobCatalog {
  readonly jobs: readonly LaborMappingCatalogJob[];
  readonly complete: boolean;
  readonly lastSuccessfulSyncAt: string | null;
  readonly fingerprint: string | null;
  readonly warnings: readonly string[];
}

export interface LaborMappingSource {
  readonly sourceKey: string;
  readonly name: string;
  readonly address: string;
  readonly jobCodes: readonly string[];
  readonly fromDate: string;
  readonly toDate: string;
  readonly classification: ReviewedLaborLocation["kind"];
}

export interface LaborJobMappingCandidate {
  readonly job: LaborMappingCatalogJob;
  readonly reasons: readonly (
    | "exact_address"
    | "exact_customer"
    | "exact_job_number"
    | "property_address"
    | "customer_name_token"
    | "job_label_tokens"
  )[];
  readonly eligible: boolean;
}

export interface LaborJobMappingSuggestion {
  readonly sourceKey: string;
  readonly status:
    | "not_customer"
    | "catalog_incomplete"
    | "unmatched"
    | "review"
    | "exact_customer_address";
  readonly candidates: readonly LaborJobMappingCandidate[];
  readonly automaticJobId: string | null;
  readonly reviewReasons: readonly string[];
}

export function laborCatalogJobDisplayName(
  job: Pick<LaborMappingCatalogJob, "customer" | "number" | "label">,
): string {
  return [job.customer, job.number ? `#${job.number}` : null, job.label]
    .filter(Boolean)
    .join(" · ");
}

/** Formatting equivalence only; retain units, house numbers, suffixes and ZIP detail. */
export function normalizeLaborJobAddress(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
}

/** Reverse the source's explicit Last, First format without fuzzy name matching. */
export function normalizeLaborCustomerName(value: string): string {
  const parts = value.normalize("NFKC").trim().split(",");
  const full =
    parts.length === 2 && parts.every((part) => part.trim()) ? `${parts[1]} ${parts[0]}` : value;
  return full.toLowerCase().replace(/&/g, " and ").replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
}

/** Property-level formatting can suggest review but never prove full address identity. */
function propertyAddress(value: string): string {
  const suffixes: Record<string, string> = {
    rd: "road",
    st: "street",
    ct: "court",
    dr: "drive",
    ln: "lane",
    ave: "avenue",
    blvd: "boulevard",
    pkwy: "parkway",
    pl: "place",
    cir: "circle",
  };
  return normalizeLaborJobAddress(value.split(",")[0] ?? "")
    .split(" ")
    .map((token) => suffixes[token] ?? token)
    .join(" ");
}

function reviewNameTokens(value: string): string[] {
  const name = (value.split(",")[0] ?? value).replace(/^ofc[ -]*/i, "");
  return name
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (token) =>
        token.length >= 3 && !["and", "the", "salt", "snow", "job", "ofc", "hoa"].includes(token),
    );
}

export function laborCatalogJobIsStale(job: LaborMappingCatalogJob, now = Date.now()): boolean {
  const synced = job.syncedAt ? Date.parse(job.syncedAt) : NaN;
  return (
    !Number.isFinite(synced) || synced > now + 60_000 || now - synced > LABOR_JOB_CATALOG_STALE_MS
  );
}

/** Suggestions never mutate mappings. Uniqueness is evaluated across the complete catalog. */
export function matchLaborJobs(
  sources: readonly LaborMappingSource[],
  catalog: readonly LaborMappingCatalogJob[],
  options: { catalogComplete: boolean; now?: number },
): readonly LaborJobMappingSuggestion[] {
  const now = options.now ?? Date.now();
  const ids = new Set<string>();
  for (const job of catalog) {
    if (!job.id || ids.has(job.id))
      throw new Error("Housecall catalog job identifiers must be unique.");
    ids.add(job.id);
  }
  return sources.map((source) => {
    if (source.classification !== "customer")
      return {
        sourceKey: source.sourceKey,
        status: "not_customer",
        candidates: [],
        automaticJobId: null,
        reviewReasons: ["Classify this location before linking it to a Housecall customer job."],
      };
    const address = normalizeLaborJobAddress(source.address);
    const customer = normalizeLaborCustomerName(source.name);
    const property = propertyAddress(source.address);
    const nameTokens = reviewNameTokens(source.name);
    const codes = new Set(
      source.jobCodes.map((code) => code.normalize("NFKC").trim().toLowerCase()).filter(Boolean),
    );
    const candidates: LaborJobMappingCandidate[] = [];
    for (const job of catalog) {
      const reasons: LaborJobMappingCandidate["reasons"][number][] = [];
      if (address && job.address && normalizeLaborJobAddress(job.address) === address)
        reasons.push("exact_address");
      if (customer && job.customer && normalizeLaborCustomerName(job.customer) === customer)
        reasons.push("exact_customer");
      if (job.number && codes.has(job.number.normalize("NFKC").trim().toLowerCase()))
        reasons.push("exact_job_number");
      if (
        property &&
        /^\d+\s/.test(property) &&
        job.address &&
        propertyAddress(job.address) === property &&
        !reasons.includes("exact_address")
      )
        reasons.push("property_address");
      const customerTokens = new Set((job.customer ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u));
      const labelTokens = new Set(job.label.toLowerCase().split(/[^\p{L}\p{N}]+/u));
      if (
        nameTokens.length &&
        nameTokens.every((token) => customerTokens.has(token)) &&
        !reasons.includes("exact_customer")
      )
        reasons.push("customer_name_token");
      if (
        nameTokens.length &&
        nameTokens.every((token) => labelTokens.has(token)) &&
        !reasons.includes("exact_customer") &&
        !reasons.includes("customer_name_token")
      )
        reasons.push("job_label_tokens");
      if (reasons.length)
        candidates.push({
          job,
          reasons,
          eligible: !job.unavailable && !!job.customerId && !laborCatalogJobIsStale(job, now),
        });
    }
    const score = (candidate: LaborJobMappingCandidate) =>
      candidate.reasons.reduce(
        (total, reason) =>
          total +
          (["exact_address", "exact_customer", "exact_job_number"].includes(reason) ? 4 : 1),
        0,
      );
    candidates.sort((a, b) => score(b) - score(a) || a.job.id.localeCompare(b.job.id));
    const exact = candidates.filter(
      (candidate) =>
        candidate.reasons.includes("exact_address") && candidate.reasons.includes("exact_customer"),
    );
    if (!options.catalogComplete)
      return {
        sourceKey: source.sourceKey,
        status: "catalog_incomplete",
        candidates,
        automaticJobId: null,
        reviewReasons: [
          "The complete Housecall catalog is unavailable; uniqueness cannot be verified.",
        ],
      };
    if (exact.length === 1 && exact[0]?.eligible)
      return {
        sourceKey: source.sourceKey,
        status: "exact_customer_address",
        candidates,
        automaticJobId: exact[0].job.id,
        reviewReasons: [],
      };
    const reviewReasons =
      exact.length > 1
        ? [
            "Multiple Housecall jobs have this exact customer and address. Confirm one specific job.",
          ]
        : exact.length === 1
          ? [
              "The exact match is stale, unavailable, or missing its customer identity. Refresh and review it.",
            ]
          : candidates.length
            ? [
                "No unique exact customer-and-address match. Review the job number, address and customer before confirming.",
              ]
            : [
                "No exact customer, address or job-number candidate. Search the Housecall catalog and confirm the destination.",
              ];
    return {
      sourceKey: source.sourceKey,
      status: candidates.length ? "review" : "unmatched",
      candidates,
      automaticJobId: null,
      reviewReasons,
    };
  });
}

/** Include imported source locations and resolved allocation destinations, retaining date scope. */
export function collectLaborMappingSources(
  report: LaborAllocationReport,
  locations: readonly ReviewedLaborLocation[],
  sourceEntries: readonly LaborEntry[] = [],
): readonly LaborMappingSource[] {
  const reviewed = new Map(locations.map((location) => [location.sourceKey, location]));
  const groups = new Map<string, { dates: Set<string>; codes: Set<string> }>();
  const add = (key: string, date: string, code?: string | null) => {
    const group = groups.get(key) ?? { dates: new Set<string>(), codes: new Set<string>() };
    group.dates.add(date);
    if (code?.trim()) group.codes.add(code.trim());
    groups.set(key, group);
  };
  const originals = new Map(sourceEntries.map((entry) => [entry.id, entry]));
  for (const entry of report.entries) {
    if (entry.sourceKind === "unpaid_break") continue;
    add(entry.sourceJobKey, entry.date, originals.get(entry.sourceEntryId)?.jobCode);
    if (entry.status === "allocated" && entry.job)
      add(entry.destinationSourceKey ?? entry.job.key, entry.date);
  }
  return [...groups.entries()]
    .map(([sourceKey, group]) => {
      const location = reviewed.get(sourceKey);
      let name = location?.job?.name ?? sourceKey;
      let address = location?.job?.address ?? "";
      try {
        const source: unknown = JSON.parse(sourceKey);
        if (
          Array.isArray(source) &&
          source.length === 2 &&
          source.every((part) => typeof part === "string")
        )
          [name, address] = source as [string, string];
      } catch {
        /* Preserve opaque historical source keys. */
      }
      const dates = [...group.dates].sort();
      return {
        sourceKey,
        name,
        address,
        jobCodes: [...group.codes].sort(),
        fromDate: dates[0] ?? "",
        toDate: dates.at(-1) ?? "",
        classification: location?.kind ?? "unknown",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.sourceKey.localeCompare(b.sourceKey));
}

function calendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Canonical destination linking is separate from source allocation and paid worker-day hours. */
export function linkLaborAllocation(
  report: LaborAllocationReport,
  mappings: readonly LaborJobMapping[],
  catalog: readonly LaborMappingCatalogJob[],
): LaborAllocationReport {
  const indexed = new Map<string, LaborJobMapping[]>();
  for (const mapping of mappings) {
    if (
      !calendarDate(mapping.fromDate) ||
      !calendarDate(mapping.toDate) ||
      mapping.fromDate > mapping.toDate ||
      !mapping.housecallJobId ||
      !mapping.sourceKey
    )
      throw new Error(
        "Labor job mappings require an explicit valid work-date range and destination.",
      );
    const previous = indexed.get(mapping.sourceKey) ?? [];
    if (
      previous.some((other) => other.fromDate <= mapping.toDate && mapping.fromDate <= other.toDate)
    )
      throw new Error("Overlapping labor job mapping ranges require review.");
    previous.push(mapping);
    indexed.set(mapping.sourceKey, previous);
  }
  const jobs = new Map(catalog.map((job) => [job.id, job]));
  if (jobs.size !== catalog.length)
    throw new Error("Housecall catalog job identifiers must be unique.");
  const entries = report.entries.map((entry): LaborEntryAllocation => {
    if (entry.status !== "allocated" || !entry.job) return entry;
    const destinationSourceKey = entry.destinationSourceKey ?? entry.job.key;
    const mapping = indexed
      .get(destinationSourceKey)
      ?.find((value) => value.fromDate <= entry.date && entry.date <= value.toDate);
    // Keep an unlinked source destination visible; never reuse a legacy unscoped ID.
    if (!mapping) {
      let name = entry.job.name;
      let address = entry.job.address;
      try {
        const source: unknown = JSON.parse(destinationSourceKey);
        if (
          Array.isArray(source) &&
          source.length === 2 &&
          source.every((part) => typeof part === "string")
        )
          [name, address] = source as [string, string];
      } catch {
        /* Preserve opaque source display. */
      }
      return {
        ...entry,
        destinationSourceKey,
        jobMapping: undefined,
        job: { key: destinationSourceKey, name, address, housecallJobId: null },
      };
    }
    const catalogJob = jobs.get(mapping.housecallJobId);
    return {
      ...entry,
      destinationSourceKey,
      jobMapping: { ...mapping },
      job: {
        key: `housecall:${mapping.housecallJobId}`,
        name: catalogJob
          ? laborCatalogJobDisplayName(catalogJob) || entry.job.name
          : entry.job.name,
        address: catalogJob?.address || entry.job.address,
        housecallJobId: mapping.housecallJobId,
      },
    };
  });
  const grouped = new Map<
    string,
    {
      job: NonNullable<LaborEntryAllocation["job"]>;
      hours: number;
      ids: Set<string>;
      workers: Set<string>;
    }
  >();
  for (const entry of entries) {
    if (entry.status !== "allocated" || !entry.job) continue;
    const group = grouped.get(entry.job.key) ?? {
      job: entry.job,
      hours: 0,
      ids: new Set<string>(),
      workers: new Set<string>(),
    };
    if (!group.ids.has(entry.sourceEntryId)) group.hours += Math.round(entry.allocatedHours * 100);
    group.ids.add(entry.sourceEntryId);
    group.workers.add(normalizeLaborWorkerName(entry.workerName));
    grouped.set(entry.job.key, group);
  }
  return {
    ...report,
    entries,
    jobs: [...grouped.values()]
      .map((group) => ({
        job: group.job,
        hours: group.hours / 100,
        entryCount: group.ids.size,
        workerCount: group.workers.size,
        costCents: null,
      }))
      .sort((a, b) => a.job.name.localeCompare(b.job.name) || a.job.key.localeCompare(b.job.key)),
  };
}
