import { createHash } from "node:crypto";
import type { LaborNote } from "@svl/domain";
import ExcelJS from "exceljs";
import { assertSafeSupercrewXlsx, SUPERCREW_XLSX_LIMITS } from "./xlsx-safety";

export type SupercrewNotesScope = "mixed" | "daily_timesheet";

export interface SupercrewNotesReport {
  notes: LaborNote[];
  period: { from: string; to: string };
  scope: SupercrewNotesScope;
  /** Timestamp normalization matches the inspected source UI; the export has no timezone. */
  datesVerified: boolean;
  warnings: string[];
  formatVersion: string;
}

const HEADERS = [
  "Date",
  "Note",
  "Notetaker",
  "Project",
  "Employee",
  "Punch-in Info",
  "Punch-in Duration",
] as const;

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validatePeriod(period: { from: string; to: string }) {
  if (
    !period ||
    !validDate(period.from) ||
    !validDate(period.to) ||
    period.from > period.to ||
    (Date.parse(period.to) - Date.parse(period.from)) / 86400000 >= 31
  )
    throw new Error("Notes Report requires an explicit valid period of at most 31 days.");
}

function scalar(cell: ExcelJS.Cell): string | number | Date | null {
  const value = cell.value;
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    value instanceof Date
  )
    return value ?? null;
  throw new Error(`Notes Report!${cell.address}: unsupported cell value or formula.`);
}

function text(cell: ExcelJS.Cell, maximum = 2000): string {
  const value = scalar(cell);
  if (value !== null && typeof value !== "string")
    throw new Error(`Notes Report!${cell.address}: expected text.`);
  if ((value ?? "").length > maximum)
    throw new Error(`Notes Report!${cell.address}: oversized text.`);
  return value ?? "";
}

function sourceTimestamp(cell: ExcelJS.Cell) {
  const value = scalar(cell);
  if (!(value instanceof Date)) {
    if (typeof value === "string" && value.length > 2000)
      throw new Error(`Notes Report!${cell.address}: oversized timestamp text.`);
    return { rawDate: value == null ? "" : String(value), date: null, midnight: false };
  }
  if (!Number.isFinite(value.getTime()))
    throw new Error(`Notes Report!${cell.address}: invalid timestamp.`);
  // Excel dates are naive serials. ExcelJS represents them as UTC Dates. Preserve
  // that raw representation without adding a timezone claim to the source value.
  const rawDate = value.toISOString().replace(/Z$/, "");
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(value)
      .map((part) => [part.type, part.value]),
  );
  return {
    rawDate,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    // Allow only the one-millisecond floating-point residue of Excel serials.
    midnight:
      parts.hour === "00" &&
      parts.minute === "00" &&
      parts.second === "00" &&
      value.getUTCMilliseconds() <= 1,
  };
}

/** Read notes as evidence. Customer matching and allocation belong to the domain. */
export async function parseSupercrewNotesXlsx(
  bytes: Uint8Array,
  options: { period: { from: string; to: string }; scope: SupercrewNotesScope },
): Promise<SupercrewNotesReport> {
  validatePeriod(options?.period);
  if (!["mixed", "daily_timesheet"].includes(options.scope))
    throw new Error("Notes Report acquisition scope must be mixed or daily_timesheet.");
  assertSafeSupercrewXlsx(bytes);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  } catch {
    throw new Error("Could not read this Notes Report XLSX workbook.");
  }
  const sheet = workbook.getWorksheet("Notes Report");
  if (!sheet || workbook.worksheets.length !== 1)
    throw new Error("Expected the single-sheet Supercrew Notes Report export.");
  if (sheet.rowCount > SUPERCREW_XLSX_LIMITS.rowsPerSheet || sheet.columnCount > HEADERS.length)
    throw new Error("Notes Report exceeds the supported worksheet limits.");
  if (HEADERS.some((header, index) => text(sheet.getCell(1, index + 1)) !== header))
    throw new Error("Notes Report has unsupported or missing report columns.");

  const warnings = [
    "Notes Report has no date-range metadata; the supplied acquisition period was preserved.",
    "Date normalization infers UTC-to-America/New_York from the verified source UI. Raw timestamps are retained; the export has no timezone or separate created-at/work-date columns.",
  ];
  if (options.scope === "mixed")
    warnings.push(
      "The export omits Note Type. Daily-shaped mixed-report notes are candidates requiring verified daily-note evidence before automatic allocation.",
    );
  const notes: LaborNote[] = [];
  const occurrences = new Map<string, number>();
  let datesVerified = true;
  for (let row = 2; row <= sheet.rowCount; row++) {
    const cells = HEADERS.map((_, index) => sheet.getCell(row, index + 1));
    const values = cells.map(scalar);
    if (values.every((value) => value == null || value === "")) continue;
    const timestamp = sourceTimestamp(sheet.getCell(row, 1));
    if (
      timestamp.date &&
      (timestamp.date < options.period.from || timestamp.date > options.period.to)
    )
      throw new Error(`Notes Report!A${row}: note date is outside the selected period.`);
    const source = {
      date: timestamp.date,
      rawDate: timestamp.rawDate,
      text: text(sheet.getCell(row, 2), 10000),
      notetaker: text(sheet.getCell(row, 3)),
      project: text(sheet.getCell(row, 4)),
      workerName: text(sheet.getCell(row, 5)),
      punchInfo: text(sheet.getCell(row, 6)),
      punchDuration: (() => {
        const value = scalar(sheet.getCell(row, 7));
        if (value === null) return "";
        if (
          typeof value === "string" ||
          (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 24)
        ) {
          const result = String(value);
          if (result.length <= 2000) return result;
        }
        throw new Error(`Notes Report!G${row}: unsupported punch-in duration.`);
      })(),
    };
    const dailyCandidate =
      timestamp.midnight &&
      Boolean(source.workerName.trim()) &&
      !source.project.trim() &&
      !source.punchInfo.trim() &&
      !source.punchDuration.trim();
    if (options.scope === "daily_timesheet" && !dailyCandidate)
      throw new Error(
        `Notes Report row ${row}: does not match the verified daily-note scope; check the source filter and workday before importing.`,
      );
    const kind: LaborNote["kind"] = dailyCandidate
      ? "daily_candidate"
      : source.project.trim() || source.punchInfo.trim() || source.punchDuration.trim()
        ? "entry"
        : "other";
    const normalized = {
      ...source,
      kind,
      dailyVerified: options.scope === "daily_timesheet" && dailyCandidate,
    };
    const digest = createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
    const occurrence = (occurrences.get(digest) ?? 0) + 1;
    occurrences.set(digest, occurrence);
    notes.push({ ...normalized, id: `${digest}:${occurrence}`, sourceRow: row });
    if (!timestamp.date) {
      datesVerified = false;
      warnings.push(
        `Notes Report row ${row}: timestamp could not be normalized; no workday was inferred.`,
      );
    }
    if (!source.workerName.trim())
      warnings.push(
        `Notes Report row ${row}: target Employee is blank; Notetaker was not substituted.`,
      );
  }
  if ([...occurrences.values()].some((count) => count > 1))
    warnings.push(
      "Identical-looking notes were retained with their original multiplicity for review.",
    );
  return {
    notes,
    period: { ...options.period },
    scope: options.scope,
    datesVerified,
    warnings,
    formatVersion: "supercrew-notes-report-v1",
  };
}
