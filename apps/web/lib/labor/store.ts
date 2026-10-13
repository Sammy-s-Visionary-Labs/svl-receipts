import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  allocateLaborHours,
  collectLaborMappingSources,
  estimateLaborPay,
  groupLaborEntries,
  type LaborAllocationRules,
  type LaborEntry,
  type LaborJobMapping,
  type LaborNote,
  type LaborNotesCoverage,
  type LaborPaySettings,
  type LaborReport,
  laborCatalogJobIsStale,
  linkLaborAllocation,
  matchLaborJobs,
  normalizeLaborWorkerName,
  type ReviewedLaborLocation,
  sourceJobKey,
} from "@svl/domain";
import { parseSupercrewNotesXlsx, parseSupercrewXlsx } from "@svl/integrations";
import { laborLocalPreviewEnabled, laborUsesSupabase } from "./config";
import type {
  JobActivity,
  JobReceiptActivity,
  LaborDashboardData,
  LaborImportSummary,
  LaborNotesImportSummary,
  LaborSyncState,
} from "./contract";
import { loadLaborJobCatalog } from "./job-catalog";
import {
  compareAndSwapSupabaseLaborState,
  getSupabaseLaborOriginal,
  type LaborPersistenceLeaseGuard,
  putSupabaseLaborOriginal,
  readSupabaseLaborState,
} from "./persistence";
import {
  assertWorkerLease,
  claimWorker,
  finishWorker,
  heartbeatWorker,
  type LaborWorkerLease,
  recoverExpiredLaborLease,
} from "./worker-control";

type StoredImport = LaborImportSummary & { hash: string; report: LaborReport };
type StoredNotesImport = LaborNotesImportSummary & {
  hash: string;
  report: Awaited<ReturnType<typeof parseSupercrewNotesXlsx>>;
};
export type NotesImportOptions = {
  scope: "mixed" | "daily_timesheet";
  complete: boolean;
  datesVerified: boolean;
};
export type PairedNotesFile = NotesImportOptions & { bytes: Uint8Array; filename: string };
export type LocalReceipt = JobReceiptActivity & {
  jobKey: string | null;
  jobName?: string;
  jobAddress?: string;
};
type State = {
  version: 1;
  imports: StoredImport[];
  sync: LaborSyncState;
  receipts: LocalReceipt[];
  mappings: Record<string, string>;
  notesImports: StoredNotesImport[];
  rules: LaborAllocationRules;
  rulesRevision: number;
  noteVerifications: Record<string, boolean>;
  paySettings: LaborPaySettings;
  payRevision: number;
  jobMappings: LaborJobMapping[];
  jobMappingsRevision: number;
  workerLease?: LaborWorkerLease | null;
  lastScheduledDate?: string | null;
};
const initialSync = (): LaborSyncState => ({
  enabled: false,
  hour: 6,
  timeZone: "America/New_York",
  lookbackDays: 14,
  status: "not_connected",
  lastAttemptAt: null,
  lastSuccessAt: null,
  nextRunAt: null,
  lastError: null,
  workerHeartbeatAt: null,
  command: null,
  commandId: null,
});
const initialPaySettings = (): LaborPaySettings => ({
  workerRates: [],
  overtime: { thresholdHours: 40, multiplier: 1.5, weekStartsOn: 4 },
});
const initialState = (): State => ({
  version: 1,
  imports: [],
  sync: initialSync(),
  receipts: [],
  mappings: {},
  notesImports: [],
  rules: { locations: [], jobAliases: [], workerAliases: [] },
  rulesRevision: 0,
  noteVerifications: {},
  paySettings: initialPaySettings(),
  payRevision: 0,
  jobMappings: [],
  jobMappingsRevision: 0,
});

export function laborDataDirectory() {
  // Private development data is runtime input and must not enter a deployment bundle.
  return path.resolve(
    /* turbopackIgnore: true */ process.env.LABOR_DATA_DIR?.trim() ||
      path.join(process.cwd(), ".local/labor"),
  );
}
const stateFile = () => path.join(laborDataDirectory(), "state.json");

function normalizeState(state: State): State {
  state.notesImports ??= [];
  state.rules ??= { locations: [], jobAliases: [], workerAliases: [] };
  state.rulesRevision ??= 0;
  state.noteVerifications ??= {};
  state.paySettings ??= initialPaySettings();
  state.payRevision ??= 0;
  state.jobMappings ??= [];
  state.jobMappingsRevision ??= 0;
  return state;
}

async function readState(): Promise<State> {
  if (laborUsesSupabase()) {
    const snapshot = await readSupabaseLaborState();
    return snapshot ? normalizeState(snapshot.state as State) : initialState();
  }
  try {
    return normalizeState(JSON.parse(await fs.readFile(stateFile(), "utf8")) as State);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
    throw error;
  }
}

async function transaction<T>(
  mutate: (state: State) => Promise<T> | T,
  actorId: string | null = null,
  leaseGuard?: LaborPersistenceLeaseGuard,
): Promise<T> {
  if (laborUsesSupabase()) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const snapshot = await readSupabaseLaborState();
      const state = snapshot ? normalizeState(snapshot.state as State) : initialState();
      const result = await mutate(state);
      compactParsedSources(state);
      const revision = await compareAndSwapSupabaseLaborState(
        state,
        snapshot?.revision ?? 0,
        actorId,
        leaseGuard,
      );
      if (revision !== null) return result;
    }
    throw new Error("Labor storage is busy; retry shortly");
  }
  const directory = laborDataDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, ".lock");
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fs.mkdir(lock, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!acquired) throw new Error("Labor storage is busy; retry shortly");
  try {
    const state = await readState();
    const result = await mutate(state);
    const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temporary, stateFile());
    return result;
  } finally {
    await fs.rmdir(lock);
  }
}

export async function ingestLaborFile(
  bytes: Uint8Array,
  filename: string,
  source: "upload" | "supercrew",
  expectedPeriod?: { from: string; to: string },
  pairedNotes?: PairedNotesFile,
  actorId: string | null = null,
  lease?: { leaseToken: string; commandId: string },
) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const report = await parseSupercrewXlsx(bytes);
  if (!isCompleteSnapshot(report))
    throw new Error(
      "Import an unfiltered report for all jobs, all workers, all types and all statuses",
    );
  if (
    expectedPeriod &&
    (report.period.from !== expectedPeriod.from || report.period.to !== expectedPeriod.to)
  )
    throw new Error("The downloaded workbook does not match the requested report period");
  // Validate both artifacts before activating either half of a recurring import.
  const notesReport = pairedNotes
    ? await parseSupercrewNotesXlsx(pairedNotes.bytes, {
        period: report.period,
        scope: pairedNotes.scope,
      })
    : null;
  return transaction(
    async (state) => {
      if (lease) authorizeLaborImportLease(state, lease.leaseToken, lease.commandId, report.period);
      const existing = state.imports.find((item) => item.hash === hash);
      const id = existing?.id ?? digestId(hash);
      const groups = groupLaborEntries(report.entries);
      const item: StoredImport = existing ?? {
        id,
        filename: safeFilename(filename),
        importedAt: new Date().toISOString(),
        generatedAt: report.generatedAt,
        source,
        period: report.period,
        entryCount: report.entries.length,
        workerCount: groups.workers.length,
        jobCount: groups.jobs.length,
        reportedHours: report.reportedTotals.hours,
        computedHours: report.computedTotals.hours,
        warnings: report.warnings,
        originalUrl: `/api/manager/labor/imports/${id}/file`,
        hash,
        report: structuredClone(report),
      };
      if (!existing) {
        await saveOriginal(id, bytes);
        state.imports.push(item);
      }
      const notes =
        pairedNotes && notesReport
          ? await storeNotes(
              state,
              pairedNotes.bytes,
              pairedNotes.filename,
              source,
              notesReport,
              pairedNotes,
              id,
            )
          : null;
      if (lease)
        authorizeLaborImportLease(
          state,
          lease.leaseToken,
          lease.commandId,
          report.period,
        ).imported = true;
      return {
        import: publicImport(item),
        notesImport: notes ? publicNotesImport(notes.item) : null,
        duplicate: Boolean(existing) && (!notes || notes.duplicate),
        sync: state.sync,
      };
    },
    actorId,
    lease
      ? { leaseToken: lease.leaseToken, commandId: lease.commandId, period: report.period }
      : undefined,
  );
}

function safeFilename(filename: string) {
  return (
    [...path.basename(filename)]
      .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
      .join("")
      .slice(0, 180) || "supercrew.xlsx"
  );
}

function digestId(hash: string) {
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function saveOriginal(id: string, bytes: Uint8Array) {
  if (laborUsesSupabase()) return putSupabaseLaborOriginal(id, bytes);
  await fs.mkdir(path.join(laborDataDirectory(), "originals"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(laborDataDirectory(), "originals", `${id}.xlsx`), bytes, {
    mode: 0o600,
  });
}

function publicNotesImport(item: StoredNotesImport): LaborNotesImportSummary {
  const { hash: _hash, report: _report, ...summary } = item;
  return summary;
}

async function storeNotes(
  state: State,
  bytes: Uint8Array,
  filename: string,
  source: "upload" | "supercrew",
  report: StoredNotesImport["report"],
  options: NotesImportOptions,
  laborImportId: string | null,
) {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const datesVerified = options.datesVerified && report.datesVerified;
  const existing = state.notesImports.find(
    (item) =>
      item.hash === hash &&
      item.period.from === report.period.from &&
      item.period.to === report.period.to &&
      item.notesScope === options.scope &&
      item.complete === options.complete &&
      item.datesVerified === datesVerified &&
      item.laborImportId === laborImportId,
  );
  if (existing) return { item: existing, duplicate: true };
  const id = digestId(
    createHash("sha256")
      .update(JSON.stringify([hash, report.period, options, laborImportId]))
      .digest("hex"),
  );
  const item: StoredNotesImport = {
    id,
    hash,
    report: structuredClone(report),
    filename: safeFilename(filename),
    importedAt: new Date().toISOString(),
    source,
    period: report.period,
    notesScope: options.scope,
    notesCount: report.notes.length,
    warnings: report.warnings,
    originalUrl: `/api/manager/labor/imports/${id}/file`,
    complete: options.complete,
    datesVerified,
    laborImportId,
  };
  await saveOriginal(id, bytes);
  state.notesImports.push(item);
  return { item, duplicate: false };
}

export async function ingestLaborNotesFile(
  bytes: Uint8Array,
  filename: string,
  source: "upload" | "supercrew",
  period: { from: string; to: string },
  options: NotesImportOptions,
  actorId: string | null = null,
) {
  const report = await parseSupercrewNotesXlsx(bytes, { period, scope: options.scope });
  return transaction(async (state) => {
    const result = await storeNotes(state, bytes, filename, source, report, options, null);
    return {
      import: publicNotesImport(result.item),
      duplicate: result.duplicate,
      sync: state.sync,
    };
  }, actorId);
}

function publicImport(item: StoredImport): LaborImportSummary {
  const { hash: _hash, report: _report, ...summary } = item;
  return summary;
}

function isCompleteSnapshot(report: LaborReport) {
  const matches = (value: string, expected: string) => value.trim().toLowerCase() === expected;
  return (
    matches(report.filters.jobs, "all jobs") &&
    matches(report.filters.workers, "all workers") &&
    matches(report.filters.timeEntryType, "all types") &&
    (!report.filters.budgetStatus.trim() || matches(report.filters.budgetStatus, "all statuses"))
  );
}

// Source timestamps have no timezone. Compare their calendar components directly,
// without applying this server's timezone or ordering by the time of a re-upload.
function generationOrder(report: LaborReport) {
  const parts = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(report.generatedAt);
  if (!parts) throw new Error("Unrecognized source generation timestamp");
  const hour = (Number(parts[2]) % 12) + (parts[5] === "PM" ? 12 : 0);
  return `${parts[1]}T${String(hour).padStart(2, "0")}:${parts[3]}:${parts[4]}`;
}

function currentEntries(imports: StoredImport[]) {
  let active: (LaborEntry & { importId: string; jobKey: string })[] = [];
  for (const item of [...imports].sort(
    (a, b) =>
      generationOrder(a.report).localeCompare(generationOrder(b.report)) ||
      a.importedAt.localeCompare(b.importedAt),
  )) {
    const report = item.report;
    if (!isCompleteSnapshot(report)) continue;
    const generatedDate = /^\d{4}-\d{2}-\d{2}/.exec(report.generatedAt)?.[0];
    const scopeEnd =
      generatedDate && generatedDate < report.period.to ? generatedDate : report.period.to;
    active = active.filter((row) => row.date < report.period.from || row.date > scopeEnd);
    active.push(
      ...report.entries.map((row) => ({
        ...row,
        importId: item.id,
        jobKey: sourceJobKey(row.jobName, row.jobAddress),
      })),
    );
  }
  return active.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      a.workerName.localeCompare(b.workerName) ||
      a.clockIn.localeCompare(b.clockIn),
  );
}

function allocationForState(
  state: State,
  entries = currentEntries(state.imports),
  rules = rulesForEntries(state, entries),
  notesSnapshot = currentNotes(state),
) {
  const completeDates = [
    ...new Set(
      entries
        .filter((entry) => {
          const report = state.imports.find((item) => item.id === entry.importId)?.report;
          return report && report.generatedAt.slice(0, 10) > entry.date;
        })
        .map((entry) => entry.date),
    ),
  ].filter((date) =>
    entries
      .filter((entry) => entry.date === date)
      .every(
        (entry) =>
          (state.imports
            .find((item) => item.id === entry.importId)
            ?.report.generatedAt.slice(0, 10) ?? "") > date,
      ),
  );
  return allocateLaborHours({
    entries,
    notes: notesSnapshot.notes,
    notesCoverages: notesSnapshot.coverage,
    rules,
    completeDates,
  });
}

/** Retain active parsed rows once; every original XLSX and import summary stays immutable. */
function compactParsedSources(state: State) {
  const entries = currentEntries(state.imports);
  const active = new Set(entries.map((entry) => `${entry.importId}:${entry.id}`));
  for (const item of state.imports) {
    item.report.entries = item.report.entries.filter((entry) =>
      active.has(`${item.id}:${entry.id}`),
    );
  }
  const notes = new Set(currentNotes(state).notes.map((note) => `${note.importId}:${note.id}`));
  for (const item of state.notesImports) {
    item.report.notes = item.report.notes.filter((note) => notes.has(`${item.id}:${note.id}`));
  }
}

export async function updateLaborJobMappings(
  value: unknown,
  expectedRevision: unknown,
  actorId: string,
  catalogFingerprint?: string,
) {
  if (!Array.isArray(value) || value.length > 500)
    throw new Error("Invalid Housecall job mappings");
  const catalog = await loadLaborJobCatalog();
  return transaction(
    (state) => {
      if (expectedRevision !== state.jobMappingsRevision)
        throw new Error("Stale job mappings; reload before saving");
      const entries = currentEntries(state.imports);
      const rules = rulesForEntries(state, entries);
      const allocation = allocationForState(state, entries, rules);
      const sources = collectLaborMappingSources(allocation, rules.locations, entries);
      const suggestions = matchLaborJobs(sources, catalog.jobs, { catalogComplete: true });
      const mappings: LaborJobMapping[] = value.map((input) => {
        if (!input || typeof input !== "object" || Array.isArray(input))
          throw new Error("Invalid Housecall job mapping");
        const row = input as Record<string, unknown>;
        const existing = state.jobMappings.find(
          (item) =>
            item.sourceKey === row.sourceKey &&
            item.housecallJobId === row.housecallJobId &&
            item.fromDate === row.fromDate &&
            item.toDate === row.toDate &&
            item.method === row.method,
        );
        if (existing) return existing;
        if (!catalog.complete || !catalogFingerprint || catalog.fingerprint !== catalogFingerprint)
          throw new Error("Stale Housecall catalog; reload before confirming links");
        const source = sources.find(
          (item) => item.sourceKey === row.sourceKey && item.classification === "customer",
        );
        const job = catalog.jobs.find((item) => item.id === row.housecallJobId);
        const validDate = (value: unknown): value is string =>
          typeof value === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(Date.parse(`${value}T12:00:00Z`)) &&
          new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
        if (
          !source ||
          !job ||
          job.unavailable ||
          !job.customerId ||
          laborCatalogJobIsStale(job) ||
          !validDate(row.fromDate) ||
          !validDate(row.toDate) ||
          row.fromDate > row.toDate ||
          row.fromDate < source.fromDate ||
          row.toDate > source.toDate
        )
          throw new Error(
            "Job links require a customer, available Housecall job and explicit imported work dates",
          );
        if (!["reviewed", "exact_customer_address"].includes(String(row.method)))
          throw new Error("Invalid job confirmation method");
        if (
          row.method === "exact_customer_address" &&
          suggestions.find((item) => item.sourceKey === source.sourceKey)?.automaticJobId !== job.id
        )
          throw new Error("This Housecall link requires individual confirmation");
        return {
          sourceKey: source.sourceKey,
          housecallJobId: job.id,
          fromDate: row.fromDate,
          toDate: row.toDate,
          method: row.method as LaborJobMapping["method"],
          confirmedAt: new Date().toISOString(),
          confirmedBy: actorId,
        };
      });
      linkLaborAllocation(allocation, mappings, catalog.jobs);
      state.jobMappings = mappings;
      state.jobMappingsRevision++;
      return { mappings, jobMappingsRevision: state.jobMappingsRevision };
    },
    actorId === "local-development" ? null : actorId,
  );
}

export async function loadLaborDashboard(): Promise<LaborDashboardData> {
  const state = await readState();
  const entries = currentEntries(state.imports);
  const groups = groupLaborEntries(entries);
  const rules = rulesForEntries(state, entries);
  const notesSnapshot = currentNotes(state);
  const rawAllocation = allocationForState(state, entries, rules, notesSnapshot);
  const catalog = laborUsesSupabase()
    ? await loadLaborJobCatalog()
    : { jobs: [], complete: false, lastSuccessfulSyncAt: null, fingerprint: null, warnings: [] };
  const mappingSources = collectLaborMappingSources(rawAllocation, rules.locations, entries);
  const allocation = linkLaborAllocation(rawAllocation, state.jobMappings, catalog.jobs);
  const paySettings = paySettingsForEntries(state, entries);
  const paidDateCandidates = new Set<string>();
  for (const date of new Set(entries.map((entry) => entry.date)))
    for (let offset = -6; offset <= 6; offset++) {
      const candidate = new Date(`${date}T12:00:00Z`);
      candidate.setUTCDate(candidate.getUTCDate() + offset);
      paidDateCandidates.add(candidate.toISOString().slice(0, 10));
    }
  const payCompleteDates = [...paidDateCandidates].filter((date) =>
    state.imports.some(
      ({ report }) =>
        isCompleteSnapshot(report) &&
        date >= report.period.from &&
        date <= report.period.to &&
        date < report.generatedAt.slice(0, 10),
    ),
  );
  const payroll = estimateLaborPay({
    workerDays: allocation.workerDays,
    settings: paySettings,
    completeDates: payCompleteDates,
  });
  const jobs: JobActivity[] = allocation.jobs.map((summary) => {
    const job = summary.job;
    const receipts = state.receipts.filter((receipt) => receipt.jobKey === job.key);
    return {
      key: job.key,
      name: job.name,
      address: job.address,
      hours: summary.hours,
      travelHours: allocation.entries
        .filter((entry) => entry.job?.key === job.key && entry.sourceKind === "travel")
        .reduce((sum, entry) => sum + entry.allocatedHours, 0),
      reportedCostCents: null,
      entryCount: summary.entryCount,
      workerCount: summary.workerCount,
      housecallJobId: job.housecallJobId,
      receiptCount: receipts.length,
      receiptTotalCents:
        receipts.length && receipts.every((receipt) => receipt.amountCents !== null)
          ? receipts.reduce((sum, r) => sum + (r.amountCents ?? 0), 0)
          : null,
      receipts,
      allocationStatus: job.housecallJobId ? "mapped" : "allocated",
    };
  });
  const hours = Math.round(entries.reduce((sum, row) => sum + row.hours, 0) * 100) / 100;
  const travelHours =
    Math.round(entries.filter((row) => row.travel).reduce((sum, row) => sum + row.hours, 0) * 100) /
    100;
  return {
    development: laborLocalPreviewEnabled() || !laborUsesSupabase(),
    dataRevision: laborDataRevision(state),
    allocation,
    jobMappings: state.jobMappings,
    jobMappingsRevision: state.jobMappingsRevision,
    mappingSources: [...mappingSources],
    jobCatalog: {
      jobs: [...catalog.jobs],
      complete: catalog.complete,
      lastSuccessfulSyncAt: catalog.lastSuccessfulSyncAt,
      fingerprint: catalog.fingerprint,
    },
    jobMappingSuggestions: [
      ...matchLaborJobs(mappingSources, catalog.jobs, { catalogComplete: catalog.complete }),
    ],
    rules,
    rulesRevision: state.rulesRevision,
    paySettings,
    payRevision: state.payRevision,
    payroll,
    notes: notesSnapshot.notes.filter((note) => note.kind === "daily_candidate"),
    notesImports: state.notesImports.map(publicNotesImport).reverse(),
    notesCoverage: notesSnapshot.coverage,
    sourceJobs: groups.jobs,
    entries,
    imports: state.imports.map(publicImport).reverse(),
    jobs,
    workers: groups.workers,
    overview: {
      hours,
      travelHours,
      workerCount: groups.workers.length,
      jobCount: groups.jobs.length,
      entryCount: entries.length,
      reportedCostCents: entries.reduce((sum, row) => sum + row.laborCostCents, 0),
    },
    sync: state.sync,
  };
}

export async function loadLocalReceipts() {
  return (await readState()).receipts;
}
export async function originalLaborFile(id: string) {
  const state = await readState();
  const item =
    state.imports.find((value) => value.id === id) ??
    state.notesImports.find((value) => value.id === id);
  if (!item) return null;
  const bytes = laborUsesSupabase()
    ? await getSupabaseLaborOriginal(item.id)
    : await fs.readFile(path.join(laborDataDirectory(), "originals", `${item.id}.xlsx`));
  if (!bytes) throw new Error("The original labor workbook is unavailable");
  return {
    bytes,
    filename: item.filename,
  };
}

function nextDate(date: string) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function currentNotes(state: State): {
  notes: (LaborNote & { importId: string })[];
  coverage: LaborNotesCoverage[];
} {
  let notes: (LaborNote & { importId: string })[] = [];
  const coverage = new Map<string, LaborNotesCoverage>();
  const orderedLabor = [...state.imports].sort(
    (a, b) =>
      generationOrder(a.report).localeCompare(generationOrder(b.report)) ||
      a.importedAt.localeCompare(b.importedAt),
  );
  const winningLaborImport = (date: string) => {
    let winner: string | null = null;
    for (const item of orderedLabor) {
      const through =
        item.report.generatedAt.slice(0, 10) < item.period.to
          ? item.report.generatedAt.slice(0, 10)
          : item.period.to;
      if (date >= item.period.from && date <= through) winner = item.id;
    }
    return winner;
  };
  // Notes exports supply no generation timestamp; arrival order is retained explicitly.
  for (const item of state.notesImports) {
    const activeDate = (date: string | null) =>
      !item.laborImportId || Boolean(date && winningLaborImport(date) === item.laborImportId);
    if (item.complete && item.datesVerified) {
      notes = notes.filter(
        (note) =>
          !note.date ||
          note.date < item.period.from ||
          note.date > item.period.to ||
          !activeDate(note.date) ||
          (item.notesScope === "daily_timesheet" && note.kind !== "daily_candidate"),
      );
    }
    for (const note of item.report.notes) {
      if (!activeDate(note.date)) continue;
      const previous = notes.findIndex((value) => value.id === note.id);
      const rejected = state.noteVerifications[note.id] === false;
      const active = {
        ...note,
        importId: item.id,
        dailyRejected: rejected,
        dailyVerified:
          !rejected &&
          item.datesVerified &&
          (item.notesScope === "daily_timesheet" || state.noteVerifications[note.id] === true),
      };
      if (previous >= 0) notes[previous] = active;
      else notes.push(active);
    }
    for (let date = item.period.from; date <= item.period.to; date = nextDate(date)) {
      if (!activeDate(date)) continue;
      coverage.set(date, {
        from: date,
        to: date,
        complete: item.complete,
        dailyOnly: item.notesScope === "daily_timesheet",
        datesVerified: item.datesVerified,
      });
    }
  }
  return { notes, coverage: [...coverage.values()] };
}

function rulesForEntries(state: State, entries: LaborEntry[]): LaborAllocationRules {
  const locations = [...state.rules.locations];
  for (const entry of entries) {
    if (entry.kind === "unpaid_break") continue;
    const key = sourceJobKey(entry.jobName, entry.jobAddress);
    if (locations.some((location) => location.sourceKey === key)) continue;
    const name = entry.jobName.trim().toLowerCase();
    const kind =
      name === "svl"
        ? "shop"
        : ["home depot", "menards", "carter lumber"].includes(name)
          ? "supplier"
          : name === "christiansen"
            ? "customer"
            : "unknown";
    locations.push({
      sourceKey: key,
      kind,
      job:
        kind === "customer"
          ? {
              key,
              name: entry.jobName,
              address: entry.jobAddress,
              housecallJobId: state.mappings[key] ?? null,
            }
          : null,
    });
  }
  return { ...state.rules, locations };
}

function shortText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000)
    throw new Error(`Invalid ${label}`);
  return value;
}

function validateRules(value: unknown, state: State): LaborAllocationRules {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid allocation rules");
  const input = value as Record<string, unknown>;
  if (
    !Array.isArray(input.locations) ||
    input.locations.length > 500 ||
    !Array.isArray(input.jobAliases) ||
    input.jobAliases.length > 500 ||
    (input.workerAliases !== undefined &&
      (!Array.isArray(input.workerAliases) || input.workerAliases.length > 500))
  )
    throw new Error("Invalid allocation rule lists");
  const locations: ReviewedLaborLocation[] = input.locations.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid location");
    const location = value as Record<string, unknown>;
    const sourceKey = shortText(location.sourceKey, "source location key");
    let source: unknown;
    try {
      source = JSON.parse(sourceKey);
    } catch {
      throw new Error("Invalid source location key");
    }
    if (
      !Array.isArray(source) ||
      source.length !== 2 ||
      !source.every((part) => typeof part === "string") ||
      !source[0].trim()
    )
      throw new Error("Invalid source location key");
    if (!["shop", "supplier", "customer", "excluded", "unknown"].includes(String(location.kind)))
      throw new Error("Invalid location classification");
    const kind = location.kind as ReviewedLaborLocation["kind"];
    if (kind !== "customer") return { sourceKey, kind, job: null };
    if (!location.job || typeof location.job !== "object" || Array.isArray(location.job))
      throw new Error("Customer job is required");
    const job = location.job as Record<string, unknown>;
    // Housecall links use the established reviewed mapping ledger, never caller-provided identifiers.
    if (
      job.key !== sourceKey ||
      job.name !== source[0] ||
      job.address !== source[1] ||
      (job.housecallJobId ?? null) !== (state.mappings[sourceKey] ?? null)
    )
      throw new Error("Customer identity must match its source location");
    return {
      sourceKey,
      kind,
      job: {
        key: sourceKey,
        name: source[0],
        address: source[1],
        housecallJobId: state.mappings[sourceKey] ?? null,
      },
    };
  });
  if (new Set(locations.map((location) => location.sourceKey)).size !== locations.length)
    throw new Error("Repeated location classification");
  const jobAliases = input.jobAliases.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid job alias");
    const alias = value as Record<string, unknown>;
    const sourceKey = shortText(alias.sourceKey, "alias destination");
    if (
      !locations.some(
        (location) => location.sourceKey === sourceKey && location.kind === "customer",
      )
    )
      throw new Error("Job aliases require a reviewed customer destination");
    const scoped = alias.workerName !== undefined || alias.date !== undefined;
    const scope = scoped
      ? {
          workerName: shortText(alias.workerName, "alias worker"),
          date: shortText(alias.date, "alias work date"),
        }
      : null;
    const prepared = { alias: shortText(alias.alias, "job alias"), sourceKey, ...(scope ?? {}) };
    const unchanged = state.rules.jobAliases.some(
      (saved) =>
        saved.alias === prepared.alias &&
        saved.sourceKey === prepared.sourceKey &&
        saved.workerName === prepared.workerName &&
        saved.date === prepared.date,
    );
    if (
      scope &&
      !unchanged &&
      !state.imports.some((item) =>
        item.report.entries.some(
          (entry) =>
            normalizeLaborWorkerName(entry.workerName) ===
              normalizeLaborWorkerName(scope.workerName) && entry.date === scope.date,
        ),
      )
    )
      throw new Error("Scoped job aliases require a recorded worker and work date");
    return prepared;
  });
  const workerAliases = ((input.workerAliases as unknown[] | undefined) ?? []).map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid worker alias");
    const alias = value as Record<string, unknown>;
    const workerName = shortText(alias.workerName, "worker name");
    const prepared = { alias: shortText(alias.alias, "worker alias"), workerName };
    const unchanged = (state.rules.workerAliases ?? []).some(
      (saved) => saved.alias === prepared.alias && saved.workerName === prepared.workerName,
    );
    if (
      !unchanged &&
      !currentEntries(state.imports).some(
        (entry) =>
          normalizeLaborWorkerName(entry.workerName) === normalizeLaborWorkerName(workerName),
      )
    )
      throw new Error("Worker alias destination is unknown");
    return prepared;
  });
  return { locations, jobAliases, workerAliases };
}

export async function updateLaborRules(
  value: unknown,
  expectedRevision: unknown,
  actorId: string | null = null,
) {
  return transaction((state) => {
    if (expectedRevision !== state.rulesRevision)
      throw new Error("Stale allocation rules; reload before saving");
    state.rules = validateRules(value, state);
    state.rulesRevision += 1;
    return {
      rules: rulesForEntries(state, currentEntries(state.imports)),
      rulesRevision: state.rulesRevision,
    };
  }, actorId);
}

function paySettingsForEntries(state: State, entries: LaborEntry[]): LaborPaySettings {
  const workerRates = [...state.paySettings.workerRates];
  const owners = new Set(workerRates.map((worker) => normalizeLaborWorkerName(worker.workerName)));
  for (const workerName of new Set(entries.map((entry) => entry.workerName))) {
    const owner = normalizeLaborWorkerName(workerName);
    if (!owners.has(owner)) {
      workerRates.push({ workerName, hourlyRateCents: null, active: true });
      owners.add(owner);
    }
  }
  return { ...state.paySettings, workerRates };
}

function validatePaySettings(value: unknown, state: State): LaborPaySettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid pay settings");
  const settings = value as Record<string, unknown>;
  if (!Array.isArray(settings.workerRates) || settings.workerRates.length > 500)
    throw new Error("Invalid worker rates");
  const recordedWorkers = new Set(
    [
      ...state.imports.flatMap(({ report }) => report.entries.map((entry) => entry.workerName)),
      ...state.paySettings.workerRates.map((worker) => worker.workerName),
    ].map(normalizeLaborWorkerName),
  );
  const workerRates = settings.workerRates.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid worker rate");
    const worker = value as Record<string, unknown>;
    const workerName = shortText(worker.workerName, "pay worker");
    if (!recordedWorkers.has(normalizeLaborWorkerName(workerName)))
      throw new Error("Pay worker is not recorded");
    if (
      worker.hourlyRateCents !== null &&
      (typeof worker.hourlyRateCents !== "number" ||
        !Number.isSafeInteger(worker.hourlyRateCents) ||
        worker.hourlyRateCents < 0 ||
        worker.hourlyRateCents > 1000000)
    )
      throw new Error("Hourly rates require nonnegative integer cents or an unspecified rate");
    if (typeof worker.active !== "boolean") throw new Error("Invalid pay worker status");
    return {
      workerName,
      hourlyRateCents: worker.hourlyRateCents as number | null,
      active: worker.active,
    };
  });
  if (
    new Set(workerRates.map((worker) => normalizeLaborWorkerName(worker.workerName))).size !==
    workerRates.length
  )
    throw new Error("Repeated pay worker");
  if (
    !settings.overtime ||
    typeof settings.overtime !== "object" ||
    Array.isArray(settings.overtime)
  )
    throw new Error("Invalid overtime settings");
  const overtime = settings.overtime as Record<string, unknown>;
  const { thresholdHours, multiplier, weekStartsOn } = overtime;
  if (
    typeof thresholdHours !== "number" ||
    !Number.isFinite(thresholdHours) ||
    thresholdHours <= 0 ||
    thresholdHours > 168 ||
    Math.abs(thresholdHours * 100 - Math.round(thresholdHours * 100)) > 0.000001 ||
    typeof multiplier !== "number" ||
    !Number.isFinite(multiplier) ||
    multiplier < 1 ||
    multiplier > 10 ||
    Math.abs(multiplier * 100 - Math.round(multiplier * 100)) > 0.000001 ||
    typeof weekStartsOn !== "number" ||
    !Number.isInteger(weekStartsOn) ||
    weekStartsOn < 0 ||
    weekStartsOn > 6
  )
    throw new Error("Invalid weekly overtime threshold, multiplier or workweek");
  return { workerRates, overtime: { thresholdHours, multiplier, weekStartsOn } };
}

export async function updateLaborPaySettings(
  value: unknown,
  expectedRevision: unknown,
  actorId: string | null = null,
) {
  return transaction((state) => {
    if (expectedRevision !== state.payRevision)
      throw new Error("Stale pay settings; reload before saving");
    state.paySettings = validatePaySettings(value, state);
    state.payRevision += 1;
    return { settings: state.paySettings, payRevision: state.payRevision };
  }, actorId);
}

export async function verifyLaborNote(
  noteId: unknown,
  dailyVerified: unknown,
  actorId: string | null = null,
) {
  return transaction((state) => {
    if (typeof noteId !== "string" || typeof dailyVerified !== "boolean")
      throw new Error("Invalid daily comment confirmation");
    const note = currentNotes(state).notes.find(
      (note) => note.id === noteId && note.kind === "daily_candidate",
    );
    if (!note) throw new Error("Daily comment candidate was not found");
    if (
      dailyVerified &&
      !state.notesImports.find((item) => item.id === note.importId)?.datesVerified
    )
      throw new Error("Verify the Notes Report work dates before confirming a daily job comment");
    state.noteVerifications[noteId] = dailyVerified;
    return { noteId, dailyVerified };
  }, actorId);
}

export async function queueLaborSync(
  action: "run" | "connect" | "pause" | "resume",
  options: { hour?: number; lookbackDays?: number } = {},
  actorId: string | null = null,
) {
  return transaction((state) => {
    recoverExpiredLaborLease(state, new Date());
    if (options.hour !== undefined) state.sync.hour = options.hour;
    if (options.lookbackDays !== undefined) state.sync.lookbackDays = options.lookbackDays;
    if (action === "pause") state.sync.enabled = false;
    if (action === "resume") state.sync.enabled = true;
    if (action === "run" || action === "connect") {
      if (state.sync.command || state.sync.status === "running")
        throw new Error("A Supercrew request is already pending");
      state.sync.command = action;
      state.sync.commandId = randomUUID();
      state.sync.lastError = null;
    }
    return state.sync;
  }, actorId);
}

export async function updateLaborWorker(
  input: Partial<LaborSyncState> & { commandId?: string | null },
) {
  return transaction((state) => {
    if (input.commandId && input.commandId !== state.sync.commandId)
      throw new Error("Stale worker command");
    for (const key of [
      "status",
      "lastError",
      "lastAttemptAt",
      "lastSuccessAt",
      "nextRunAt",
    ] as const) {
      const value = input[key];
      if (value !== undefined) Object.assign(state.sync, { [key]: value });
    }
    state.sync.workerHeartbeatAt = new Date().toISOString();
    if (input.commandId && input.status !== "running") {
      state.sync.command = null;
      state.sync.commandId = null;
    }
    return state.sync;
  });
}

export async function loadLaborSyncState() {
  const state = await readState();
  recoverExpiredLaborLease(state, new Date());
  return state.sync;
}
export function authorizeLaborImportLease(
  state: State,
  token: string,
  commandId: string,
  period?: { from: string; to: string },
) {
  const lease = assertWorkerLease(state, token, new Date());
  if (lease.commandId !== commandId) throw new Error("Stale worker command");
  if (period && (lease.period.from !== period.from || lease.period.to !== period.to))
    throw new Error("The workbook period does not match the claimed Supercrew request");
  return lease;
}
export async function assertLaborWorkerLease(token: string) {
  return assertWorkerLease(await readState(), token, new Date());
}
export async function claimLaborWorker(runId: string) {
  return transaction((state) =>
    claimWorker(state, runId, new Date(), { commandId: randomUUID(), leaseToken: randomUUID() }),
  );
}
export async function heartbeatLaborWorker(token: string) {
  return transaction((state) => heartbeatWorker(state, token, new Date()));
}
export async function finishLaborWorker(
  token: string,
  status: "idle" | "needs_login" | "failed",
  lastError?: string | null,
) {
  return transaction((state) => finishWorker(state, token, status, lastError, new Date()));
}

/** One-time, checked import of the existing private ledger into an empty shared database. */
export async function initializeSharedLaborLedger(
  input: unknown,
  originals: Map<string, Uint8Array>,
  actorId: string,
) {
  if (!laborUsesSupabase()) throw new Error("Shared labor persistence is required");
  const seed = normalizeState(structuredClone(input) as State);
  if (seed.version !== 1 || !Array.isArray(seed.imports) || !Array.isArray(seed.notesImports))
    throw new Error("Invalid labor ledger");
  for (const item of [...seed.imports, ...seed.notesImports]) {
    const bytes = originals.get(item.id);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== item.hash)
      throw new Error("Original workbook hash does not match ledger");
  }
  currentEntries(seed.imports);
  seed.sync = {
    ...seed.sync,
    enabled: false,
    status: "not_connected",
    command: null,
    commandId: null,
    workerHeartbeatAt: null,
    nextRunAt: null,
    lastError: null,
  };
  seed.workerLease = null;
  seed.lastScheduledDate = null;
  // Local preview fixtures are not business receipts; the production receipt tables supply activity.
  seed.receipts = [];
  for (const [id, bytes] of originals) await putSupabaseLaborOriginal(id, bytes);
  return transaction((state) => {
    if (
      state.imports.length ||
      state.notesImports.length ||
      state.payRevision ||
      state.rulesRevision
    )
      throw new Error("The shared labor ledger already contains records");
    Object.assign(state, seed);
    return {
      imports: seed.imports.length,
      notesImports: seed.notesImports.length,
      entryCount: currentEntries(seed.imports).length,
    };
  }, actorId);
}

export async function beginLaborWorkerConnection() {
  return transaction((state) => {
    recoverExpiredLaborLease(state, new Date());
    if (state.workerLease || state.sync.status === "running" || state.sync.command === "run")
      throw new Error("A Supercrew request is already pending");
    state.sync.command = "connect";
    state.sync.commandId ??= randomUUID();
    return state.sync;
  });
}
export async function markLaborWorkerConnected() {
  return transaction((state) => {
    if (state.workerLease || state.sync.command !== "connect")
      throw new Error("Stale worker connection");
    state.sync.command = null;
    state.sync.commandId = null;
    state.sync.status = "idle";
    state.sync.workerHeartbeatAt = new Date().toISOString();
    state.sync.lastError = null;
    return state.sync;
  });
}

function laborDataRevision(state: State) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        imports: state.imports.map((source) => [source.id, source.hash]),
        notes: state.notesImports.map((source) => [source.id, source.hash]),
        rules: state.rulesRevision,
        pay: state.payRevision,
        mappings: state.jobMappingsRevision,
        noteVerifications: state.noteVerifications,
      }),
    )
    .digest("hex");
}
export async function loadLaborStatus() {
  const state = await readState();
  recoverExpiredLaborLease(state, new Date());
  return { sync: state.sync, dataRevision: laborDataRevision(state) };
}
