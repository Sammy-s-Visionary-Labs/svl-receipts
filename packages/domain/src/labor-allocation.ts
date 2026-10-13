import { type LaborEntry, sourceJobKey } from "./labor";
import { parseLaborJobComment } from "./labor-comment";
import type { LaborJobMapping } from "./labor-job-mapping";

export interface LaborNote {
  id: string;
  date: string | null;
  rawDate: string;
  workerName: string;
  notetaker: string;
  text: string;
  project: string;
  punchInfo: string;
  punchDuration: string;
  sourceRow: number;
  kind: "daily_candidate" | "entry" | "other";
  /** Explicit verification of the daily-note type and work-date join in the source UI. */
  dailyVerified?: boolean;
  /** A reviewed rejection overrides source scope and coverage verification. */
  dailyRejected?: boolean;
}

export interface LaborNotesCoverage {
  from: string;
  to: string;
  complete: boolean;
  dailyOnly: boolean;
  datesVerified: boolean;
}

export interface LaborAllocationJob {
  key: string;
  name: string;
  address: string;
  housecallJobId: string | null;
}

export interface ReviewedLaborLocation {
  sourceKey: string;
  kind: "shop" | "supplier" | "customer" | "excluded" | "unknown";
  job: LaborAllocationJob | null;
}

export interface LaborAllocationRules {
  locations: readonly ReviewedLaborLocation[];
  jobAliases: readonly {
    alias: string;
    sourceKey: string;
    /** A scoped alias requires both the worker and work date. */
    workerName?: string;
    date?: string;
  }[];
  workerAliases?: readonly { alias: string; workerName: string }[];
}

export interface LaborEntryAllocation {
  readonly sourceEntryId: string;
  readonly sourceRow: number;
  readonly date: string;
  readonly workerName: string;
  readonly sourceJobKey: string;
  /** Resolved source destination before canonical Housecall linking (including comment corrections). */
  readonly destinationSourceKey?: string;
  readonly jobMapping?: LaborJobMapping;
  readonly sourceKind: LaborEntry["kind"];
  readonly sourceHours: number;
  readonly status: "allocated" | "excluded" | "pending" | "day_adjustment";
  readonly job: LaborAllocationJob | null;
  readonly allocatedHours: number;
  readonly excludedHours: number;
  readonly pendingHours: number;
  readonly reason: string;
  readonly reviewReasons: readonly string[];
  readonly noteIds: readonly string[];
}

export interface LaborWorkerDayAllocation {
  readonly key: string;
  readonly date: string;
  readonly workerName: string;
  readonly grossHours: number;
  readonly sourceBreakHours: number;
  readonly sourceNetHours: number;
  readonly lunchAdjustmentHours: number;
  readonly breakDifferenceHours: number;
  readonly netHours: number;
  readonly allocatedHours: number;
  readonly excludedHours: number;
  readonly pendingHours: number;
  readonly reviewReasons: readonly string[];
}

export interface LaborJobAllocationSummary {
  readonly job: LaborAllocationJob;
  readonly hours: number;
  readonly entryCount: number;
  readonly workerCount: number;
  /** Cost redistribution and pay rates remain unconfigured. */
  readonly costCents: null;
}

export interface LaborAllocationInput {
  entries: readonly LaborEntry[];
  notes?: readonly LaborNote[];
  notesCoverage?: LaborNotesCoverage | null;
  notesCoverages?: readonly LaborNotesCoverage[];
  rules: LaborAllocationRules;
  /** Only complete worker days can establish an excluded final return. */
  completeThrough?: string | null;
  completeDates?: readonly string[];
}

export interface LaborAllocationReport {
  readonly rulesVersion: string;
  readonly entries: readonly LaborEntryAllocation[];
  readonly workerDays: readonly LaborWorkerDayAllocation[];
  readonly jobs: readonly LaborJobAllocationSummary[];
  readonly totals: {
    readonly grossHours: number;
    readonly sourceBreakHours: number;
    readonly sourceNetHours: number;
    readonly lunchAdjustmentHours: number;
    readonly netHours: number;
    readonly allocatedHours: number;
    readonly excludedHours: number;
    readonly pendingHours: number;
  };
  readonly warnings: readonly string[];
}

export const LABOR_ALLOCATION_POLICY = Object.freeze({
  version: "marcy-2026-10-08-v2",
  abnormalTravelHours: 2,
  clockToleranceMinutes: 5,
  lunchThresholdHours: 6,
  lunchHours: 0.5,
});

export function normalizeLaborJobAlias(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Deliberately handles the export's Last, First and notes' First Last formats. */
export function normalizeLaborWorkerName(value: string): string {
  const parts = value.normalize("NFKC").trim().split(",");
  return normalizeLaborJobAlias(parts.length === 2 ? `${parts[1]} ${parts[0]}` : value);
}

type Row = {
  entry: LaborEntry;
  start: number | null;
  end: number | null;
  location: ReviewedLaborLocation | undefined;
  job: LaborAllocationJob | null;
  anchor: boolean;
  corrected: boolean;
  sourceCorrection?: boolean;
  fallback?: boolean;
  reviews: string[];
  noteIds: string[];
};

const hundredths = (hours: number) => Math.round(hours * 100);
const quantity = (hours: number) => hundredths(hours) / 100;
const unique = (values: readonly string[]) => [...new Set(values)];

function clockMinutes(clock: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hasClockGap(rows: readonly Row[]): boolean {
  return rows.some((row, position) => {
    if (position === 0) return false;
    const previous = rows[position - 1];
    return (
      row.start === null ||
      previous?.end === null ||
      previous?.end === undefined ||
      row.start - previous.end > LABOR_ALLOCATION_POLICY.clockToleranceMinutes
    );
  });
}

function workerAliases(rules: LaborAllocationRules) {
  const aliases = new Map<string, Set<string>>();
  for (const alias of rules.workerAliases ?? []) {
    const key = normalizeLaborWorkerName(alias.alias);
    const values = aliases.get(key) ?? new Set<string>();
    values.add(normalizeLaborWorkerName(alias.workerName));
    aliases.set(key, values);
  }
  return (name: string) => {
    const normalized = normalizeLaborWorkerName(name);
    const values = aliases.get(normalized);
    return values?.size === 1 ? ([...values][0] as string) : normalized;
  };
}

function jobAliasIndex(rules: LaborAllocationRules) {
  const locations = new Map<string, ReviewedLaborLocation>();
  const aliases = new Map<string, Set<string>>();
  const add = (alias: string, sourceKey: string) => {
    const key = normalizeLaborJobAlias(alias);
    if (!key) return;
    const values = aliases.get(key) ?? new Set<string>();
    values.add(sourceKey);
    aliases.set(key, values);
  };
  for (const location of rules.locations) {
    const previous = locations.get(location.sourceKey);
    if (previous && (previous.kind !== location.kind || previous.job?.key !== location.job?.key)) {
      locations.set(location.sourceKey, {
        sourceKey: location.sourceKey,
        kind: "unknown",
        job: null,
      });
      continue;
    }
    locations.set(location.sourceKey, location);
    if (location.kind === "customer" && location.job) add(location.job.name, location.sourceKey);
  }
  const scopedAliases: LaborAllocationRules["jobAliases"][number][] = [];
  for (const alias of rules.jobAliases) {
    // Partial scopes must never become global aliases, even in unvalidated input.
    if (alias.workerName !== undefined || alias.date !== undefined) {
      if (alias.workerName && alias.date) scopedAliases.push(alias);
    } else add(alias.alias, alias.sourceKey);
  }
  return { locations, aliases, scopedAliases };
}

function jobAliasKeys(
  alias: string,
  day: string,
  worker: string,
  workerToken: (name: string) => string,
  index: ReturnType<typeof jobAliasIndex>,
) {
  const normalized = normalizeLaborJobAlias(alias);
  const keys = new Set(index.aliases.get(normalized) ?? []);
  for (const scoped of index.scopedAliases)
    if (
      scoped.date === day &&
      workerToken(scoped.workerName ?? "") === worker &&
      normalizeLaborJobAlias(scoped.alias) === normalized
    )
      keys.add(scoped.sourceKey);
  return keys;
}

function noteDestination(
  day: string,
  worker: string,
  notes: readonly LaborNote[],
  coverage: readonly LaborNotesCoverage[],
  workerToken: (name: string) => string,
  index: ReturnType<typeof jobAliasIndex>,
  ownerCollision: boolean,
  correctionSourceKey?: string,
): {
  job: LaborAllocationJob | null;
  noteIds: string[];
  reviews: string[];
  fallbackAllowed: boolean;
} {
  const candidates = notes.filter((note) => {
    if (
      note.date !== day ||
      workerToken(note.workerName) !== worker ||
      note.kind !== "daily_candidate"
    )
      return false;
    const parsed = parseLaborJobComment(note.text);
    // A = B is evidence about A's source intervals, not a job-only override
    // for every unrelated abnormal interval owned by the same worker that day.
    if (!correctionSourceKey) return !parsed?.sourceAlias;
    return (
      !!parsed?.sourceAlias &&
      jobAliasKeys(parsed.sourceAlias, day, worker, workerToken, index).has(correctionSourceKey)
    );
  });
  if (ownerCollision)
    return {
      job: null,
      noteIds: candidates.map((note) => note.id),
      reviews: ["The note owner matches multiple source workers; verify worker identity."],
      fallbackAllowed: false,
    };
  if (!candidates.length)
    return {
      job: null,
      noteIds: [],
      reviews: ["Abnormal travel needs a daily job comment for this worker and date."],
      fallbackAllowed: true,
    };
  const jobs = new Map<string, LaborAllocationJob>();
  const reviews: string[] = [];
  let fallbackAllowed = true;
  for (const note of candidates) {
    const covered = coverage.some(
      (scope) =>
        scope.complete &&
        scope.dailyOnly &&
        scope.datesVerified &&
        day >= scope.from &&
        day <= scope.to,
    );
    if (note.dailyRejected) {
      reviews.push("Daily comment confirmation was revoked; automatic allocation needs review.");
      fallbackAllowed = false;
    } else if (!note.dailyVerified && !covered) {
      reviews.push("Daily-note type, date or report coverage is not verified.");
      fallbackAllowed = false;
    }
    const parsed = parseLaborJobComment(note.text);
    if (!parsed) {
      reviews.push("A daily comment does not match one exact reviewed job alias.");
      fallbackAllowed = false;
      continue;
    }
    const keys = jobAliasKeys(parsed.destinationAlias, day, worker, workerToken, index);
    if (keys.size !== 1) {
      reviews.push("A daily comment does not match one exact reviewed job alias.");
      if (keys.size || parsed.sourceAlias) fallbackAllowed = false;
      continue;
    }
    fallbackAllowed = false;
    if (
      correctionSourceKey &&
      parsed.sourceAlias &&
      jobAliasKeys(parsed.sourceAlias, day, worker, workerToken, index).size !== 1
    )
      reviews.push("A correction source does not match one exact reviewed job alias.");
    const location = index.locations.get([...keys][0] as string);
    if (location?.kind !== "customer" || !location.job) {
      reviews.push("The comment destination is not a reviewed customer job.");
      continue;
    }
    jobs.set(location.job.key, location.job);
  }
  if (jobs.size > 1) reviews.push("Daily comments name conflicting customer jobs.");
  return {
    job: jobs.size === 1 ? ([...jobs.values()][0] as LaborAllocationJob) : null,
    noteIds: candidates.map((note) => note.id),
    reviews: unique(reviews),
    fallbackAllowed: fallbackAllowed && jobs.size === 0,
  };
}

function result(
  row: Row,
  status: LaborEntryAllocation["status"],
  reason: string,
  job: LaborAllocationJob | null = row.job,
  extraReviews: readonly string[] = [],
): LaborEntryAllocation {
  const reviews = unique([...row.reviews, ...extraReviews]);
  // Reviewed non-job locations exclude source hours without resolving their clock warnings.
  const finalStatus =
    status !== "day_adjustment" && reason !== "excluded_location" && reviews.length
      ? "pending"
      : status;
  return Object.freeze({
    sourceEntryId: row.entry.id,
    sourceRow: row.entry.sourceRow,
    date: row.entry.date,
    workerName: row.entry.workerName,
    sourceJobKey: sourceJobKey(row.entry.jobName, row.entry.jobAddress),
    sourceKind: row.entry.kind,
    sourceHours: row.entry.hours,
    status: finalStatus,
    job: job ? Object.freeze({ ...job }) : null,
    allocatedHours: finalStatus === "allocated" ? row.entry.hours : 0,
    excludedHours: finalStatus === "excluded" ? row.entry.hours : 0,
    pendingHours: finalStatus === "pending" ? row.entry.hours : 0,
    reason,
    reviewReasons: Object.freeze(reviews),
    noteIds: Object.freeze([...row.noteIds]),
  });
}

/** Pure development calculation. Source facts and reported costs are never changed. */
export function allocateLaborHours(input: LaborAllocationInput): LaborAllocationReport {
  const index = jobAliasIndex(input.rules);
  const workerToken = workerAliases(input.rules);
  const coverages = [
    ...(input.notesCoverages ?? []),
    ...(input.notesCoverage ? [input.notesCoverage] : []),
  ];
  const notes = input.notes ?? [];
  const completeDates = new Set(input.completeDates ?? []);
  const days = new Map<
    string,
    { workerKey: string; worker: string; date: string; entries: LaborEntry[] }
  >();
  const owners = new Map<string, Set<string>>();
  const ids = new Set<string>();
  for (const entry of input.entries) {
    if (
      !Number.isFinite(entry.hours) ||
      Math.abs(entry.hours * 100 - hundredths(entry.hours)) > 0.000001 ||
      (entry.kind !== "unpaid_break" && entry.hours < 0) ||
      (entry.kind === "unpaid_break" && entry.hours > 0)
    )
      throw new Error("Labor allocation requires valid source hours and signed break adjustments.");
    if (ids.has(entry.id))
      throw new Error("Source entry identifiers must be unique within the allocation snapshot.");
    ids.add(entry.id);
    const worker = workerToken(entry.workerName);
    const workerKey = entry.employeeId
      ? JSON.stringify(["employee", entry.employeeId])
      : JSON.stringify(["name", worker]);
    const key = JSON.stringify([workerKey, entry.date]);
    const group = days.get(key) ?? { workerKey, worker, date: entry.date, entries: [] };
    group.entries.push(entry);
    days.set(key, group);
    const ownerKey = JSON.stringify([worker, entry.date]);
    const matching = owners.get(ownerKey) ?? new Set<string>();
    matching.add(workerKey);
    owners.set(ownerKey, matching);
  }
  const decisions: LaborEntryAllocation[] = [];
  const workerDays: LaborWorkerDayAllocation[] = [];
  const entryWorkers = new Map<string, string>();
  for (const [key, day] of [...days].sort(
    (a, b) => a[1].date.localeCompare(b[1].date) || a[0].localeCompare(b[0]),
  )) {
    const dayReviews: string[] = [];
    const rows: Row[] = day.entries
      .filter((entry) => entry.kind !== "unpaid_break")
      .map((entry) => {
        const location = index.locations.get(sourceJobKey(entry.jobName, entry.jobAddress));
        const start = clockMinutes(entry.clockIn);
        const end = clockMinutes(entry.clockOut);
        const reviews: string[] = [];
        if (start === null || end === null || end < start)
          reviews.push("Missing or overnight clock boundaries require review.");
        else if (
          Math.abs(end - start - entry.hours * 60) >
          LABOR_ALLOCATION_POLICY.clockToleranceMinutes + 0.000001
        )
          reviews.push(
            "Clock duration differs from Excel Hours by more than 5 minutes; source Hours were preserved.",
          );
        const customer = entry.kind === "work" && location?.kind === "customer" && !!location.job;
        return {
          entry,
          start,
          end,
          location,
          job: customer ? location.job : null,
          anchor: customer,
          corrected: false,
          reviews,
          noteIds: [],
        };
      })
      .sort(
        (a, b) =>
          (a.start ?? Infinity) - (b.start ?? Infinity) ||
          (a.end ?? Infinity) - (b.end ?? Infinity) ||
          a.entry.id.localeCompare(b.entry.id),
      );
    const ownerCollision = (owners.get(JSON.stringify([day.worker, day.date]))?.size ?? 0) > 1;
    const destination = noteDestination(
      day.date,
      day.worker,
      notes,
      coverages,
      workerToken,
      index,
      ownerCollision,
    );
    let furthest: Row | undefined;
    for (const row of rows) {
      if (row.start === null || row.end === null || row.end <= row.start) continue;
      if (furthest?.end !== null && furthest?.end !== undefined && row.start < furthest.end) {
        const reason = "Overlapping source intervals require review; no interval was removed.";
        if (!row.reviews.includes(reason)) row.reviews.push(reason);
        if (!furthest.reviews.includes(reason)) furthest.reviews.push(reason);
      }
      if (!furthest || row.end > (furthest.end ?? -1)) furthest = row;
    }
    // Explicit A = B corrections apply only to this owner's matching source
    // intervals on this work date; source labels and other jobs remain intact.
    for (const row of rows) {
      if (row.location?.kind === "excluded") continue;
      const correction = noteDestination(
        day.date,
        day.worker,
        notes,
        coverages,
        workerToken,
        index,
        ownerCollision,
        sourceJobKey(row.entry.jobName, row.entry.jobAddress),
      );
      if (!correction.noteIds.length) continue;
      row.sourceCorrection = true;
      row.noteIds = correction.noteIds;
      row.reviews.push(...correction.reviews);
      if (correction.job) row.job = correction.job;
      row.corrected = !!correction.job && correction.reviews.length === 0;
      row.anchor = row.corrected || row.anchor;
    }
    const abnormalCount = rows.filter(
      (row) =>
        row.location?.kind !== "excluded" &&
        row.entry.kind === "travel" &&
        row.entry.hours >= LABOR_ALLOCATION_POLICY.abnormalTravelHours,
    ).length;
    for (const row of rows) {
      if (
        row.location?.kind === "excluded" ||
        row.sourceCorrection ||
        row.corrected ||
        row.entry.kind !== "travel" ||
        row.entry.hours < LABOR_ALLOCATION_POLICY.abnormalTravelHours
      )
        continue;
      row.job = destination.job;
      row.noteIds = destination.noteIds;
      if (!destination.fallbackAllowed) row.reviews.push(...destination.reviews);
      if (destination.job && abnormalCount > 1)
        row.reviews.push(
          "Multiple abnormal travel intervals cannot be selected from a job-only daily comment.",
        );
      row.corrected = !!destination.job && destination.reviews.length === 0 && abnormalCount === 1;
      row.anchor = row.corrected;
    }
    // Without a usable job comment, a continuous source chain can still identify
    // the next reviewed customer. Stop at unknown work or another unresolved
    // abnormal interval; never use a previous or next-day customer as a fallback.
    if (destination.fallbackAllowed)
      for (let position = 0; position < rows.length; position++) {
        const row = rows[position] as Row;
        if (
          row.location?.kind === "excluded" ||
          row.sourceCorrection ||
          row.corrected ||
          row.entry.kind !== "travel" ||
          row.entry.hours < LABOR_ALLOCATION_POLICY.abnormalTravelHours
        )
          continue;
        let next: Row | undefined;
        for (const candidate of rows.slice(position + 1)) {
          if (candidate.anchor && candidate.job) {
            next = candidate;
            break;
          }
          if (
            candidate.location?.kind !== "excluded" &&
            ((candidate.entry.kind === "work" &&
              (!candidate.location ||
                candidate.location.kind === "unknown" ||
                (candidate.location.kind === "customer" && !candidate.location.job))) ||
              (candidate.entry.kind === "travel" &&
                candidate.entry.hours >= LABOR_ALLOCATION_POLICY.abnormalTravelHours &&
                !candidate.corrected))
          )
            break;
        }
        const chain = next ? rows.slice(Math.max(0, position - 1), rows.indexOf(next) + 1) : [];
        if (next?.job && chain.every((part) => part.reviews.length === 0) && !hasClockGap(chain)) {
          row.job = next.job;
          row.corrected = true;
          row.fallback = true;
          row.anchor = true;
        } else row.reviews.push(...destination.reviews);
      }
    const dayComplete =
      completeDates.has(day.date) || (!!input.completeThrough && day.date <= input.completeThrough);
    let lastAnchor = -1;
    for (let position = 0; position < rows.length; position++)
      if (rows[position]?.anchor) lastAnchor = position;
    let initialShopEnd = 0;
    while (
      initialShopEnd < rows.length &&
      (rows[initialShopEnd]?.location?.kind === "excluded" ||
        (rows[initialShopEnd]?.entry.kind === "work" &&
          rows[initialShopEnd]?.location?.kind === "shop" &&
          !rows[initialShopEnd]?.corrected))
    )
      initialShopEnd++;
    let finalShopStart = rows.length;
    while (
      finalShopStart > initialShopEnd &&
      (rows[finalShopStart - 1]?.location?.kind === "excluded" ||
        (rows[finalShopStart - 1]?.entry.kind === "work" &&
          rows[finalShopStart - 1]?.location?.kind === "shop" &&
          !rows[finalShopStart - 1]?.corrected))
    )
      finalShopStart--;
    const terminalShop = rows
      .slice(finalShopStart)
      .find((row) => row.entry.kind === "work" && row.location?.kind === "shop");
    const tail = lastAnchor >= 0 ? rows.slice(lastAnchor + 1, finalShopStart) : [];
    const terminalTravel = rows[rows.length - 1];
    const departure = rows[lastAnchor];
    // A completed return may end with an explicit SVL travel destination; the
    // export does not need a separate shop work row to establish that return.
    const travelOnlyReturn =
      !terminalShop &&
      departure?.entry.kind === "work" &&
      departure.location?.kind === "customer" &&
      !!departure.job &&
      terminalTravel?.entry.kind === "travel" &&
      terminalTravel.location?.kind === "shop" &&
      terminalTravel.entry.hours < LABOR_ALLOCATION_POLICY.abnormalTravelHours;
    const finalCandidate =
      lastAnchor >= 0 &&
      (!!terminalShop || travelOnlyReturn) &&
      tail.some((row) => row.location?.kind !== "excluded") &&
      tail.every(
        (row) =>
          row.location?.kind === "excluded" ||
          (row.entry.kind === "travel" &&
            row.entry.hours < LABOR_ALLOCATION_POLICY.abnormalTravelHours &&
            row.reviews.length === 0),
      );
    // Keep excluded stops in the boundary chain so genuine gaps remain reviewable.
    const finalBoundaries = finalCandidate
      ? rows.slice(lastAnchor, terminalShop ? rows.indexOf(terminalShop) + 1 : rows.length)
      : [];
    const finalBoundaryReview =
      finalCandidate &&
      (hasClockGap(finalBoundaries) || (rows[lastAnchor]?.reviews.length ?? 0) > 0);
    if (finalBoundaryReview)
      for (const row of [...tail, ...rows.slice(finalShopStart)])
        row.reviews.push(
          "The final return has an unresolved departure or clock gap; exclusion needs review.",
        );
    const clearFinalReturn = finalCandidate && !finalBoundaryReview;
    const nextCustomers: (Row | undefined)[] = [];
    const nextBlocked: boolean[] = [];
    const positions = new Map<Row, number>();
    const gapPrefix: number[] = [];
    let upcoming: Row | undefined;
    let upcomingBlocked = false;
    for (let position = rows.length - 1; position >= 0; position--) {
      const row = rows[position] as Row;
      nextCustomers[position] = upcoming;
      nextBlocked[position] = upcomingBlocked;
      positions.set(row, position);
      if (row.anchor) {
        upcoming = row;
        upcomingBlocked = false;
      } else if (
        row.location?.kind !== "excluded" &&
        ((row.entry.kind === "work" &&
          (!row.location ||
            row.location.kind === "unknown" ||
            (row.location.kind === "customer" && !row.location.job))) ||
          (row.entry.kind === "travel" &&
            row.entry.hours >= LABOR_ALLOCATION_POLICY.abnormalTravelHours &&
            !row.corrected))
      ) {
        upcoming = undefined;
        upcomingBlocked = true;
      }
    }
    for (let position = 0; position < rows.length; position++)
      gapPrefix[position] =
        (gapPrefix[position - 1] ?? 0) +
        (position > 0 && hasClockGap([rows[position - 1] as Row, rows[position] as Row]) ? 1 : 0);
    const dayResults: LaborEntryAllocation[] = [];
    for (let position = 0; position < rows.length; position++) {
      const row = rows[position] as Row;
      let decision: LaborEntryAllocation;
      if (row.location?.kind === "excluded")
        decision = result(row, "excluded", "excluded_location", null);
      else if (row.anchor)
        decision = result(
          row,
          "allocated",
          row.fallback ? "next_customer" : row.corrected ? "daily_comment" : "reviewed_customer",
        );
      else if (
        row.entry.kind === "travel" &&
        row.entry.hours >= LABOR_ALLOCATION_POLICY.abnormalTravelHours
      )
        decision = result(
          row,
          "pending",
          "abnormal_travel",
          row.job,
          row.reviews.length ? [] : ["Abnormal travel destination requires review."],
        );
      else if (position < initialShopEnd) decision = result(row, "excluded", "initial_shop", null);
      else if (position >= finalShopStart)
        decision = result(
          row,
          dayComplete ? "excluded" : "pending",
          "final_shop",
          null,
          dayComplete
            ? []
            : ["The worker day is provisional; a final shop return is not confirmed."],
        );
      else if (position > lastAnchor && clearFinalReturn)
        decision = result(
          row,
          dayComplete ? "excluded" : "pending",
          "final_return",
          null,
          dayComplete ? [] : ["The worker day is provisional; a final return is not confirmed."],
        );
      else if (
        row.entry.kind === "work" &&
        (!row.location ||
          row.location.kind === "unknown" ||
          (row.location.kind === "customer" && !row.location.job))
      )
        decision = result(row, "pending", "unclassified_location", null, [
          "Review the source location as shop, supplier or an exact customer job.",
        ]);
      else {
        const next = nextCustomers[position];
        const blocked = nextBlocked[position];
        if (next?.job && !blocked) {
          const nextPosition = positions.get(next) as number;
          const brokenBoundary =
            (gapPrefix[nextPosition] ?? 0) - (gapPrefix[Math.max(0, position - 1)] ?? 0) > 0;
          decision = result(
            row,
            "allocated",
            "next_customer",
            next.job,
            next.reviews.length
              ? ["The next customer interval has unresolved boundaries."]
              : brokenBoundary
                ? ["A gap in the travel/stop chain requires boundary review."]
                : [],
          );
        } else
          decision = result(row, "pending", "no_next_customer", null, [
            blocked
              ? "An unresolved location or abnormal interval prevents identifying the next customer job."
              : "A stop or travel interval has no identifiable next customer job; no previous or next-day destination was assumed.",
          ]);
      }
      dayResults.push(decision);
      entryWorkers.set(row.entry.id, day.workerKey);
    }
    const breaks = day.entries.filter((entry) => entry.kind === "unpaid_break");
    for (const entry of breaks)
      dayResults.push(
        result(
          {
            entry,
            start: null,
            end: null,
            location: undefined,
            job: null,
            anchor: false,
            corrected: false,
            reviews: [],
            noteIds: [],
          },
          "day_adjustment",
          "source_unpaid_break",
          null,
        ),
      );
    const gross = rows.reduce((sum, row) => sum + hundredths(row.entry.hours), 0);
    const sourceBreak = breaks.reduce((sum, entry) => sum + hundredths(entry.hours), 0);
    const lunch =
      gross >= LABOR_ALLOCATION_POLICY.lunchThresholdHours * 100
        ? -hundredths(LABOR_ALLOCATION_POLICY.lunchHours)
        : 0;
    if (lunch !== sourceBreak)
      dayReviews.push(
        "Source unpaid-break deductions differ from the day-only lunch policy; both were preserved for review.",
      );
    if (!dayComplete)
      dayReviews.push(
        "This worker day is provisional; lunch eligibility and terminal exclusions may change.",
      );
    if (
      notes.some(
        (note) =>
          note.date === day.date &&
          workerToken(note.workerName) === day.worker &&
          /\b(?:no lunch|didn['’]?t take (?:a )?lunch|worked through lunch)\b/i.test(note.text),
      )
    )
      dayReviews.push(
        "A note conflicts with the lunch policy. No unconfirmed exception was invented.",
      );
    dayReviews.push(...dayResults.flatMap((decision) => decision.reviewReasons));
    workerDays.push(
      Object.freeze({
        key,
        date: day.date,
        workerName: day.entries[0]?.workerName ?? day.worker,
        grossHours: gross / 100,
        sourceBreakHours: sourceBreak / 100,
        sourceNetHours: (gross + sourceBreak) / 100,
        lunchAdjustmentHours: lunch / 100,
        breakDifferenceHours: (lunch - sourceBreak) / 100,
        netHours: (gross + lunch) / 100,
        allocatedHours: quantity(
          dayResults.reduce((sum, decision) => sum + decision.allocatedHours, 0),
        ),
        excludedHours: quantity(
          dayResults.reduce((sum, decision) => sum + decision.excludedHours, 0),
        ),
        pendingHours: quantity(
          dayResults.reduce((sum, decision) => sum + decision.pendingHours, 0),
        ),
        reviewReasons: Object.freeze(unique(dayReviews)),
      }),
    );
    decisions.push(...dayResults);
  }
  const groupedJobs = new Map<
    string,
    { job: LaborAllocationJob; hours: number; entries: Set<string>; workers: Set<string> }
  >();
  for (const decision of decisions) {
    if (decision.status !== "allocated" || !decision.job) continue;
    const group = groupedJobs.get(decision.job.key) ?? {
      job: decision.job,
      hours: 0,
      entries: new Set<string>(),
      workers: new Set<string>(),
    };
    group.hours += hundredths(decision.allocatedHours);
    group.entries.add(decision.sourceEntryId);
    group.workers.add(entryWorkers.get(decision.sourceEntryId) as string);
    groupedJobs.set(decision.job.key, group);
  }
  const jobs = [...groupedJobs.values()]
    .map((group) =>
      Object.freeze({
        job: group.job,
        hours: group.hours / 100,
        entryCount: group.entries.size,
        workerCount: group.workers.size,
        costCents: null,
      }),
    )
    .sort((a, b) => a.job.name.localeCompare(b.job.name) || a.job.key.localeCompare(b.job.key));
  const total = (
    field: keyof Pick<
      LaborWorkerDayAllocation,
      | "grossHours"
      | "sourceBreakHours"
      | "sourceNetHours"
      | "lunchAdjustmentHours"
      | "netHours"
      | "allocatedHours"
      | "excludedHours"
      | "pendingHours"
    >,
  ) => workerDays.reduce((sum, day) => sum + hundredths(day[field]), 0) / 100;
  const warnings: string[] = [];
  const pendingCount = decisions.filter((decision) => decision.status === "pending").length;
  if (pendingCount)
    warnings.push(
      `${pendingCount} source intervals need allocation review. Their hours were not assigned to a customer job.`,
    );
  if (workerDays.some((day) => day.breakDifferenceHours !== 0))
    warnings.push(
      "Some source break totals differ from the day-only lunch policy. Lunch was applied once, without changing source deductions.",
    );
  warnings.push(
    "Pay rates and cost treatment remain unconfigured. Reported source costs were not redistributed.",
  );
  return Object.freeze({
    rulesVersion: LABOR_ALLOCATION_POLICY.version,
    entries: Object.freeze(decisions),
    workerDays: Object.freeze(workerDays),
    jobs: Object.freeze(jobs),
    totals: Object.freeze({
      grossHours: total("grossHours"),
      sourceBreakHours: total("sourceBreakHours"),
      sourceNetHours: total("sourceNetHours"),
      lunchAdjustmentHours: total("lunchAdjustmentHours"),
      netHours: total("netHours"),
      allocatedHours: total("allocatedHours"),
      excludedHours: total("excludedHours"),
      pendingHours: total("pendingHours"),
    }),
    warnings: Object.freeze(warnings),
  });
}
