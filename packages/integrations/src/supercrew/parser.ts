import { createHash } from "node:crypto";
import {
  type LaborEntry,
  type LaborReport,
  type LaborReportedTotals,
  type LaborTotals,
  laborTotals,
} from "@svl/domain";
import ExcelJS from "exceljs";
import { assertSafeSupercrewXlsx, SUPERCREW_XLSX_LIMITS } from "./xlsx-safety";

const ENTRY_HEADERS = [
  "Date",
  "Name",
  "Role",
  "Job Title",
  "Crew",
  "Job Name",
  "Job Address",
  "Clock-in",
  "Clock-out",
  "Clock-in Method",
  "Clock-out Method",
  "Time Entry Type",
  "Hours",
  "Labor Cost",
  "Billable Cost",
  "Job Code",
  "Employee ID",
] as const;
const OPTIONAL_HEADERS = new Set(["Role", "Job Title", "Crew", "Job Address"]);
const METHODS = new Set([
  "AutoClock",
  "GPS",
  "NoGPS",
  "Manual",
  "Overnight split",
  "Travel Time",
  "Unpaid Break",
]);

function location(cell: ExcelJS.Cell | undefined): string {
  return cell ? `${cell.worksheet.name}!${cell.address}` : "Missing column";
}

function cellValue(cell: ExcelJS.Cell | undefined): string | number | null {
  if (!cell) return null;
  const value = cell.value;
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  // Never use a formula's cached result as an authorized source fact.
  throw new Error(`${cell.worksheet.name}!${cell.address}: unsupported cell value or formula.`);
}

function text(cell: ExcelJS.Cell | undefined, required = false): string {
  const value = cellValue(cell);
  if (value !== null && typeof value !== "string")
    throw new Error(`${location(cell)}: expected text.`);
  const result = value ?? "";
  if (result.length > 2000 || (required && !result.trim()))
    throw new Error(`${location(cell)}: missing or oversized text.`);
  return result;
}

function decimal(cell: ExcelJS.Cell | undefined, maximum = 10000000, signed = false): number {
  const value = cellValue(cell);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (!signed && value < 0) ||
    Math.abs(value) > maximum ||
    Math.abs(value * 100 - Math.round(value * 100)) > 0.000001
  )
    throw new Error(
      `${location(cell)}: expected a ${signed ? "signed" : "nonnegative"} number with at most two decimal places.`,
    );
  return value;
}

function money(cell: ExcelJS.Cell | undefined, signed = false): number {
  return Math.round(decimal(cell, 10000000, signed) * 100);
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const candidate = new Date(Date.UTC(year as number, (month as number) - 1, day));
  return candidate.toISOString().slice(0, 10) === value;
}

function metadata(sheet: ExcelJS.Worksheet) {
  const labels = new Map<string, string>();
  for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
    const label = text(sheet.getCell(row, 1));
    if (
      [
        "Report Generated:",
        "Date Range:",
        "Jobs:",
        "Workers:",
        "Time Entry Type:",
        "Budget Status:",
      ].includes(label)
    ) {
      if (labels.has(label)) throw new Error(`${sheet.name}: repeated report metadata.`);
      labels.set(label, text(sheet.getCell(row, 2), true));
    }
    if (label === "Date" || label === "Job Name" || label === "Name") break;
  }
  const required = (key: string) => {
    const value = labels.get(key);
    if (!value) throw new Error(`${sheet.name}: missing ${key}`);
    return value;
  };
  const range = required("Date Range:").match(/^(\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/);
  if (
    !range ||
    !isDate(range[1] as string) ||
    !isDate(range[2] as string) ||
    (range[1] as string) > (range[2] as string)
  )
    throw new Error(`${sheet.name}: invalid date range.`);
  const generatedAt = required("Report Generated:");
  const generated = generatedAt.match(/^(\d{4}-\d{2}-\d{2}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/);
  if (
    !generated ||
    !isDate(generated[1] as string) ||
    Number(generated[2]) < 1 ||
    Number(generated[2]) > 12 ||
    Number(generated[3]) > 59 ||
    Number(generated[4]) > 59
  )
    throw new Error(`${sheet.name}: unsupported report generation timestamp.`);
  return {
    generatedAt,
    period: { from: range[1] as string, to: range[2] as string },
    filters: {
      jobs: required("Jobs:"),
      workers: required("Workers:"),
      timeEntryType: required("Time Entry Type:"),
      budgetStatus: labels.get("Budget Status:") ?? "",
    },
  };
}

function entryHeaders(sheet: ExcelJS.Worksheet): {
  row: number;
  columns: Map<string, number>;
  variant: boolean;
} {
  for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
    if (text(sheet.getCell(row, 1)) !== "Date") continue;
    const columns = new Map<string, number>();
    let variant = false;
    for (let column = 1; column <= sheet.columnCount; column++) {
      const sourceLabel = text(sheet.getCell(row, column));
      const aliases: Record<string, string> = {
        Job: "Job Name",
        "Clock-In": "Clock-in",
        "Clock-Out": "Clock-out",
        "Clock-In Method": "Clock-in Method",
        "Clock-Out Method": "Clock-out Method",
      };
      const label = aliases[sourceLabel] ?? sourceLabel;
      if (sourceLabel === "Job") variant = true;
      if (!label) continue;
      if (columns.has(label)) throw new Error("All Entries: repeated column header.");
      columns.set(label, column);
    }
    if (ENTRY_HEADERS.some((header) => !OPTIONAL_HEADERS.has(header) && !columns.has(header)))
      throw new Error("All Entries: unsupported or missing report columns.");
    return {
      row,
      columns,
      variant: variant || ENTRY_HEADERS.some((header) => !columns.has(header)),
    };
  }
  throw new Error("All Entries: detailed record header was not found.");
}

function summaryTotals(sheet: ExcelJS.Worksheet): LaborTotals {
  let header = 0;
  for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
    if (text(sheet.getCell(row, 1)) === "Job Name") {
      header = row;
      break;
    }
  }
  // Explicit scope prevents reading the similarly named lifetime columns.
  if (
    !header ||
    text(sheet.getCell(header - 1, 7)) !== "In Selected Period" ||
    text(sheet.getCell(header - 1, 11)) !== "Lifetime" ||
    ["Travel Time", "Total Hours", "Total Cost", "Billable Cost"].some(
      (label, index) => text(sheet.getCell(header, index + 7)) !== label,
    )
  )
    throw new Error("Overall Summary: selected-period totals have an unsupported layout.");
  let totalRow = 0;
  for (let row = header + 1; row <= sheet.rowCount; row++) {
    if (text(sheet.getCell(row, 1)) === "Total") {
      if (totalRow) throw new Error("Overall Summary: repeated total row.");
      totalRow = row;
    }
  }
  if (!totalRow) throw new Error("Overall Summary: report total is missing.");
  return {
    travelHours: decimal(sheet.getCell(totalRow, 7)),
    hours: decimal(sheet.getCell(totalRow, 8)),
    laborCostCents: money(sheet.getCell(totalRow, 9)),
    billableCostCents: money(sheet.getCell(totalRow, 10)),
  };
}

function timesheetSummaryTotals(sheet: ExcelJS.Worksheet): LaborTotals {
  let header = 0;
  for (let row = 1; row <= Math.min(30, sheet.rowCount); row++) {
    if (text(sheet.getCell(row, 1)) === "Name") {
      header = row;
      break;
    }
  }
  if (
    !header ||
    text(sheet.getCell(header, 9)) !== "Total Hours" ||
    text(sheet.getCell(header, 12)) !== "Labor Cost" ||
    text(sheet.getCell(header, 13)) !== "Billable Cost" ||
    text(sheet.getCell(header, 14)) !== "Travel Time"
  )
    throw new Error("Timesheet Summary: unsupported total control columns.");
  let totalRow = 0;
  for (let row = header + 1; row <= sheet.rowCount; row++) {
    if (cellValue(sheet.getCell(row, 6)) !== "Total") continue;
    if (totalRow) throw new Error("Timesheet Summary: repeated total row.");
    totalRow = row;
  }
  if (!totalRow) throw new Error("Timesheet Summary: report total is missing.");
  return {
    hours: decimal(sheet.getCell(totalRow, 9)),
    laborCostCents: money(sheet.getCell(totalRow, 12)),
    billableCostCents: money(sheet.getCell(totalRow, 13)),
    travelHours: decimal(sheet.getCell(totalRow, 14)),
  };
}

/** Parse static exported records. Does not allocate shop time, calculate rates, or write Housecall. */
export async function parseSupercrewXlsx(bytes: Uint8Array): Promise<LaborReport> {
  assertSafeSupercrewXlsx(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  } catch {
    throw new Error("Could not read this XLSX workbook.");
  }
  if (
    workbook.worksheets.length > SUPERCREW_XLSX_LIMITS.sheets ||
    workbook.worksheets.some(
      (sheet) => sheet.rowCount > SUPERCREW_XLSX_LIMITS.rowsPerSheet || sheet.columnCount > 100,
    )
  )
    throw new Error("Excel workbook exceeds the supported worksheet limits.");
  const allEntries = workbook.getWorksheet("All Entries");
  const summary = workbook.getWorksheet("Overall Summary");
  const timesheetSummary = workbook.getWorksheet("Timesheet Summary");
  if (!allEntries) throw new Error("Expected a Supercrew export with an All Entries sheet.");
  const reportMetadata = metadata(allEntries);
  if (summary && JSON.stringify(metadata(summary)) !== JSON.stringify(reportMetadata))
    throw new Error("Supercrew report sheets disagree on dates, generation time, or filters.");
  if (
    timesheetSummary &&
    JSON.stringify(metadata(timesheetSummary)) !== JSON.stringify(reportMetadata)
  )
    throw new Error("Supercrew timesheet sheets disagree on dates, generation time, or filters.");
  const { row: headerRow, columns, variant } = entryHeaders(allEntries);
  const cell = (row: number, header: (typeof ENTRY_HEADERS)[number]) => {
    const column = columns.get(header);
    return column ? allEntries.getCell(row, column) : undefined;
  };
  const entries: LaborEntry[] = [];
  const occurrences = new Map<string, number>();
  let footer: Pick<LaborTotals, "hours" | "laborCostCents" | "billableCostCents"> | null = null;
  for (let row = headerRow + 1; row <= allEntries.rowCount; row++) {
    const values = ENTRY_HEADERS.map((header) => cellValue(cell(row, header)));
    if (values.every((value) => value == null || value === "")) continue;
    if (text(cell(row, "Time Entry Type")) === "Total") {
      if (
        footer ||
        ENTRY_HEADERS.filter(
          (header) => !["Time Entry Type", "Hours", "Labor Cost", "Billable Cost"].includes(header),
        ).some((header) => ![null, ""].includes(cellValue(cell(row, header)) as null | string))
      )
        throw new Error("All Entries: malformed or repeated total footer.");
      footer = {
        hours: decimal(cell(row, "Hours")),
        laborCostCents: money(cell(row, "Labor Cost")),
        billableCostCents: money(cell(row, "Billable Cost")),
      };
      continue;
    }
    if (footer) throw new Error("All Entries: found records after the report total footer.");
    const date = text(cell(row, "Date"), true);
    if (!isDate(date) || date < reportMetadata.period.from || date > reportMetadata.period.to)
      throw new Error(`All Entries!A${row}: work date is invalid or outside the selected period.`);
    const clockInMethod = text(cell(row, "Clock-in Method"), true);
    const clockOutMethod = text(cell(row, "Clock-out Method"), true);
    if (
      ![clockInMethod, clockOutMethod].every((method) => METHODS.has(method)) ||
      (clockInMethod === "Travel Time") !== (clockOutMethod === "Travel Time") ||
      (clockInMethod === "Unpaid Break") !== (clockOutMethod === "Unpaid Break")
    )
      throw new Error(
        `All Entries row ${row}: unknown or conflicting capture methods require review.`,
      );
    const unpaidBreak = clockInMethod === "Unpaid Break";
    const clockIn = text(cell(row, "Clock-in"), !unpaidBreak);
    const clockOut = text(cell(row, "Clock-out"), !unpaidBreak);
    if (
      unpaidBreak
        ? clockIn !== "" || clockOut !== ""
        : ![clockIn, clockOut].every((clock) => /^([01]\d|2[0-3]):[0-5]\d$/.test(clock))
    )
      throw new Error(
        `All Entries row ${row}: expected displayed HH:mm clock times, or blank clocks for an unpaid-break adjustment.`,
      );
    const hours = decimal(cell(row, "Hours"), 24, unpaidBreak);
    const laborCostCents = money(cell(row, "Labor Cost"), unpaidBreak);
    const billableCostCents = money(cell(row, "Billable Cost"), unpaidBreak);
    const jobName = text(cell(row, "Job Name"), true);
    if (
      unpaidBreak &&
      (hours > 0 || laborCostCents > 0 || billableCostCents > 0 || jobName !== "Unpaid Break")
    )
      throw new Error(
        `All Entries row ${row}: unsupported unpaid-break adjustment; no job allocation was inferred.`,
      );
    const source = {
      kind: unpaidBreak
        ? ("unpaid_break" as const)
        : clockInMethod === "Travel Time"
          ? ("travel" as const)
          : ("work" as const),
      date,
      workerName: text(cell(row, "Name"), true),
      role: text(cell(row, "Role")),
      crew: text(cell(row, "Crew")),
      jobName,
      jobAddress: text(cell(row, "Job Address")),
      clockIn,
      clockOut,
      clockInMethod,
      clockOutMethod,
      timeEntryType: text(cell(row, "Time Entry Type")),
      hours,
      laborCostCents,
      billableCostCents,
      jobCode: text(cell(row, "Job Code")) || null,
      employeeId: text(cell(row, "Employee ID")) || null,
      travel: clockInMethod === "Travel Time",
    };
    const digest = createHash("sha256").update(JSON.stringify(source)).digest("hex");
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    entries.push({ ...source, id: `${digest}:${occurrence}`, sourceRow: row });
  }
  if (!footer) throw new Error("All Entries: detailed report total footer is missing.");
  const secondaryTotals = summary
    ? summaryTotals(summary)
    : timesheetSummary
      ? timesheetSummaryTotals(timesheetSummary)
      : null;
  const reportedTotals: LaborReportedTotals = {
    ...footer,
    travelHours: secondaryTotals?.travelHours ?? null,
  };
  if (
    summary &&
    (footer.hours !== secondaryTotals?.hours ||
      footer.laborCostCents !== secondaryTotals?.laborCostCents ||
      footer.billableCostCents !== secondaryTotals?.billableCostCents)
  )
    throw new Error("All Entries and Overall Summary disagree on selected-period totals.");
  if (reportedTotals.travelHours !== null && reportedTotals.travelHours > reportedTotals.hours)
    throw new Error("Overall Summary travel exceeds total hours.");
  const computedTotals = laborTotals(entries);
  const warnings: string[] = [];
  for (const key of ["hours", "travelHours", "laborCostCents", "billableCostCents"] as const) {
    if (reportedTotals[key] !== null && computedTotals[key] !== reportedTotals[key])
      warnings.push(
        `Reported ${key} ${reportedTotals[key]} differs from the detail sum ${computedTotals[key]}. Source values were preserved.`,
      );
  }
  if (!secondaryTotals)
    warnings.push(
      "This export supplies only the All Entries total footer. An independent travel control is not available.",
    );
  if (timesheetSummary && secondaryTotals) {
    for (const key of ["hours", "laborCostCents", "billableCostCents"] as const) {
      if (footer[key] !== secondaryTotals[key])
        warnings.push(
          `Timesheet Summary ${key} ${secondaryTotals[key]} differs from the All Entries footer ${footer[key]}. Both source controls were preserved.`,
        );
    }
  }
  if (entries.some((entry) => !entry.jobAddress && entry.kind !== "unpaid_break"))
    warnings.push(
      "Some source jobs have no address. Their names remain unresolved source labels and must not be assumed to match a Housecall destination.",
    );
  const generatedDate = reportMetadata.generatedAt.slice(0, 10);
  if (reportMetadata.period.to >= generatedDate)
    warnings.push(
      "The selected range includes the report generation day or future days. This is a provisional snapshot.",
    );
  if (
    reportMetadata.filters.jobs !== "All jobs" ||
    reportMetadata.filters.workers !== "All workers" ||
    reportMetadata.filters.timeEntryType !== "All types" ||
    (reportMetadata.filters.budgetStatus !== "" &&
      reportMetadata.filters.budgetStatus !== "All statuses")
  )
    warnings.push(
      "This report has restricted filters and cannot establish complete all-worker/all-job coverage.",
    );
  if (entries.some((entry) => !entry.jobCode || !entry.employeeId))
    warnings.push(
      "Some source job or employee identifiers are blank. Names and addresses are source grouping keys, not confirmed Housecall mappings.",
    );
  const zeroCostEntries = entries.filter(
    (entry) => entry.hours > 0 && entry.laborCostCents === 0,
  ).length;
  if (zeroCostEntries)
    warnings.push(
      `${zeroCostEntries} entries have positive hours and zero reported labor cost. Rates and costing policy remain unconfirmed.`,
    );
  if (entries.some((entry) => entry.hours === 0))
    warnings.push("Zero-hour records were retained as source facts.");
  if ([...occurrences.values()].some((count) => count > 1))
    warnings.push(
      "Identical-looking records were retained with their original multiplicity for review.",
    );
  if (entries.some((entry) => entry.timeEntryType))
    warnings.push(
      "The report includes annotated or edited time entries. Review them alongside the source workbook notes.",
    );
  if (entries.some((entry) => entry.clockInMethod === "NoGPS" || entry.clockOutMethod === "NoGPS"))
    warnings.push(
      "Some source entries use NoGPS capture. Their displayed clocks, reported hours, job labels and edit annotations were preserved; GPS absence does not establish a different location.",
    );
  if (
    entries.some(
      (entry) =>
        entry.clockInMethod === "Overnight split" || entry.clockOutMethod === "Overnight split",
    )
  )
    warnings.push(
      "Some source entries use Overnight split capture. The source split marker, displayed clocks, reported hours and costs were preserved; no clock date, duration or extra interval was inferred.",
    );
  if (entries.some((entry) => entry.kind === "unpaid_break"))
    warnings.push(
      "Signed unpaid-break adjustments were preserved separately from source customer jobs. Their eventual job allocation remains undecided.",
    );
  const reconciliationControls = [
    { sheet: "All Entries", totals: { ...footer, travelHours: null } },
    ...(secondaryTotals
      ? [{ sheet: summary ? "Overall Summary" : "Timesheet Summary", totals: secondaryTotals }]
      : []),
  ];
  return {
    ...reportMetadata,
    entries,
    reportedTotals,
    computedTotals,
    reconciliationControls,
    warnings,
    formatVersion:
      variant || !summary ? "supercrew-timesheet-all-entries-v1" : "supercrew-merged-job-report-v1",
  };
}
