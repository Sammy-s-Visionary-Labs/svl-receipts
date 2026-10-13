import type {
  LaborAllocationReport,
  LaborAllocationRules,
  LaborEntry,
  LaborJobMapping,
  LaborJobMappingSuggestion,
  LaborMappingCatalogJob,
  LaborMappingSource,
  LaborNote,
  LaborNotesCoverage,
  LaborPayReport,
  LaborPaySettings,
} from "@svl/domain";

export type LaborNotesImportSummary = {
  id: string;
  filename: string;
  importedAt: string;
  source: "upload" | "supercrew";
  period: { from: string; to: string };
  notesScope: "mixed" | "daily_timesheet";
  notesCount: number;
  warnings: string[];
  originalUrl: string;
  complete: boolean;
  datesVerified: boolean;
  laborImportId: string | null;
};

export type LaborImportSummary = {
  id: string;
  filename: string;
  importedAt: string;
  generatedAt: string;
  source: "upload" | "supercrew";
  period: { from: string; to: string };
  entryCount: number;
  workerCount: number;
  jobCount: number;
  reportedHours: number;
  computedHours: number;
  warnings: string[];
  originalUrl: string;
};

export type LaborSyncState = {
  enabled: boolean;
  hour: number;
  timeZone: string;
  lookbackDays: number;
  status: "not_connected" | "idle" | "running" | "needs_login" | "failed";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  workerHeartbeatAt: string | null;
  command: "connect" | "run" | null;
  commandId: string | null;
};

export type JobReceiptActivity = {
  id: string;
  reference: string | null;
  vendor: string | null;
  submittedAt: string;
  status: string;
  amountCents: number | null;
  href: string | null;
  developmentFixture?: boolean;
};

export type JobActivity = {
  key: string;
  name: string;
  address: string;
  housecallJobId: string | null;
  hours: number;
  travelHours: number;
  reportedCostCents: number | null;
  entryCount: number;
  workerCount: number;
  receiptCount: number;
  receiptTotalCents: number | null;
  receipts: JobReceiptActivity[];
  allocationStatus: "source_only" | "mapped" | "unassigned" | "allocated";
};

export type LaborDashboardData = {
  dataRevision: string;
  development: boolean;
  allocation: LaborAllocationReport;
  jobMappings: LaborJobMapping[];
  jobMappingsRevision: number;
  mappingSources: LaborMappingSource[];
  jobCatalog: {
    jobs: LaborMappingCatalogJob[];
    complete: boolean;
    lastSuccessfulSyncAt: string | null;
    fingerprint: string | null;
  };
  jobMappingSuggestions: LaborJobMappingSuggestion[];
  rules: LaborAllocationRules;
  rulesRevision: number;
  paySettings: LaborPaySettings;
  payRevision: number;
  payroll: LaborPayReport;
  notes: (LaborNote & { importId: string })[];
  notesImports: LaborNotesImportSummary[];
  notesCoverage: LaborNotesCoverage[];
  sourceJobs: {
    key: string;
    name: string;
    address: string;
    hours: number;
    travelHours: number;
    reportedCostCents: number;
    entryCount: number;
    workerCount: number;
  }[];
  entries: (LaborEntry & { importId: string; jobKey: string })[];
  imports: LaborImportSummary[];
  jobs: JobActivity[];
  workers: {
    key: string;
    name: string;
    hours: number;
    travelHours: number;
    reportedCostCents: number;
    entryCount: number;
    jobCount: number;
  }[];
  overview: {
    hours: number;
    travelHours: number;
    workerCount: number;
    jobCount: number;
    entryCount: number;
    reportedCostCents: number;
  };
  sync: LaborSyncState;
};

export type JobsDashboardData = {
  development: boolean;
  allocation: LaborAllocationReport;
  imports: LaborImportSummary[];
  jobs: JobActivity[];
  entries: LaborDashboardData["entries"];
  unassignedReceipts: JobReceiptActivity[];
  receiptSource: "supabase" | "development_database" | "local_development" | "not_configured";
  warnings: string[];
};
