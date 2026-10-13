import { readFile } from "node:fs/promises";
import type { LaborNote } from "@svl/domain";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseSupercrewNotesXlsx, type SupercrewNotesReport } from "./notes-parser";

const period = { from: "2026-09-24", to: "2026-09-30" };
const daily = [
  new Date("2026-09-29T04:00:00Z"),
  "TEST Job",
  "TEST Editor",
  "",
  "TEST Worker",
  "",
  "",
];

function fixture(rows: unknown[][] = [daily]): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Notes Report");
  sheet.addRow([
    "Date",
    "Note",
    "Notetaker",
    "Project",
    "Employee",
    "Punch-in Info",
    "Punch-in Duration",
  ]);
  for (const row of rows) sheet.addRow(row);
  sheet.getColumn(1).numFmt = "mm-dd-yy";
  return workbook;
}

async function bytes(workbook: ExcelJS.Workbook) {
  return new Uint8Array(await workbook.xlsx.writeBuffer({ useSharedStrings: true }));
}

describe("Supercrew Notes Report", () => {
  it("joins the target Employee, retains the editor/raw timestamp, and requires explicit acquisition scope", async () => {
    const report = await parseSupercrewNotesXlsx(await bytes(fixture()), {
      period,
      scope: "mixed",
    });
    expect(report).toMatchObject({
      period,
      scope: "mixed",
      datesVerified: true,
      formatVersion: "supercrew-notes-report-v1",
    });
    expect(report.notes[0]).toMatchObject({
      date: "2026-09-29",
      rawDate: "2026-09-29T04:00:00.000",
      workerName: "TEST Worker",
      notetaker: "TEST Editor",
      project: "",
      punchInfo: "",
      punchDuration: "",
      kind: "daily_candidate",
      dailyVerified: false,
      sourceRow: 2,
    });
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("omits Note Type"),
        expect.stringContaining("infers UTC"),
      ]),
    );
    const verified = await parseSupercrewNotesXlsx(await bytes(fixture()), {
      period,
      scope: "daily_timesheet",
    });
    expect(verified.notes[0]?.dailyVerified).toBe(true);
  });

  it("retains other notes as evidence without promoting arbitrary text or the editor to a daily worker", async () => {
    const entry = [
      new Date("2026-09-25T17:44:41Z"),
      "TEST: added drive time",
      "TEST Editor",
      "TEST Project",
      "TEST Worker",
      "25 Sep, 2026 · 1:44pm-4:00pm",
      "2.3",
    ];
    const arbitrary = [
      new Date("2026-09-28T16:00:00Z"),
      "TEST Job",
      "TEST Editor",
      "",
      "TEST Worker",
      "",
      "",
    ];
    const noOwner = [...daily];
    noOwner[4] = "";
    const report = await parseSupercrewNotesXlsx(
      await bytes(fixture([entry, arbitrary, noOwner])),
      { period, scope: "mixed" },
    );
    expect(report.notes.map((note) => note.kind)).toEqual(["entry", "other", "other"]);
    expect(report.notes[0]).toMatchObject({
      date: "2026-09-25",
      punchDuration: "2.3",
      punchInfo: entry[5],
    });
    expect(report.notes[2]?.workerName).toBe("");
    expect(
      report.warnings.some((warning) => warning.includes("Notetaker was not substituted")),
    ).toBe(true);
    await expect(
      parseSupercrewNotesXlsx(await bytes(fixture([entry])), { period, scope: "daily_timesheet" }),
    ).rejects.toThrow("verified daily-note scope");
  });

  it("normalizes Eastern midnight across DST and does not infer an unknown timestamp", async () => {
    const winter = [...daily];
    winter[0] = new Date("2026-11-03T05:00:00Z");
    const report = await parseSupercrewNotesXlsx(await bytes(fixture([winter])), {
      period: { from: "2026-11-03", to: "2026-11-03" },
      scope: "daily_timesheet",
    });
    expect(report.notes[0]).toMatchObject({
      date: "2026-11-03",
      kind: "daily_candidate",
      dailyVerified: true,
    });
    const unknown = [...daily];
    unknown[0] = "TEST unknown timestamp";
    const unresolved = await parseSupercrewNotesXlsx(await bytes(fixture([unknown])), {
      period,
      scope: "mixed",
    });
    expect(unresolved.notes[0]).toMatchObject({
      date: null,
      rawDate: "TEST unknown timestamp",
      kind: "other",
    });
    expect(unresolved.datesVerified).toBe(false);
    await expect(
      parseSupercrewNotesXlsx(await bytes(fixture([unknown])), {
        period,
        scope: "daily_timesheet",
      }),
    ).rejects.toThrow("workday");
  });

  it("rejects incorrect periods, missing headers, formulas, and source dates outside the selected range", async () => {
    const workbook = fixture();
    await expect(
      parseSupercrewNotesXlsx(await bytes(workbook), {
        period: { from: "2026-09-31", to: "2026-10-01" },
        scope: "mixed",
      }),
    ).rejects.toThrow("explicit valid period");
    await expect(
      parseSupercrewNotesXlsx(await bytes(workbook), {
        period: { from: "2026-08-01", to: "2026-09-30" },
        scope: "mixed",
      }),
    ).rejects.toThrow("31 days");
    await expect(
      parseSupercrewNotesXlsx(await bytes(workbook), {
        period: { from: "2026-09-24", to: "2026-09-28" },
        scope: "mixed",
      }),
    ).rejects.toThrow("outside the selected period");
    const sheet = workbook.getWorksheet("Notes Report") as ExcelJS.Worksheet;
    sheet.getCell("E1").value = "Worker";
    await expect(
      parseSupercrewNotesXlsx(await bytes(workbook), { period, scope: "mixed" }),
    ).rejects.toThrow("report columns");
    sheet.getCell("E1").value = "Employee";
    sheet.getCell("B2").value = { formula: '"TEST Job"', result: "TEST Job" };
    await expect(
      parseSupercrewNotesXlsx(await bytes(workbook), { period, scope: "mixed" }),
    ).rejects.toThrow("unsupported cell value or formula");
  });

  it("preserves duplicates and a genuinely empty filtered report without inventing notes", async () => {
    const first = await parseSupercrewNotesXlsx(await bytes(fixture([daily, daily])), {
      period,
      scope: "mixed",
    });
    const second = await parseSupercrewNotesXlsx(await bytes(fixture([daily, daily])), {
      period,
      scope: "mixed",
    });
    expect(first.notes.map((note) => note.id)).toEqual(second.notes.map((note) => note.id));
    expect(new Set(first.notes.map((note) => note.id)).size).toBe(2);
    const empty = await parseSupercrewNotesXlsx(await bytes(fixture([])), {
      period,
      scope: "daily_timesheet",
    });
    expect(empty.notes).toEqual([]);
    expect(empty.scope).toBe("daily_timesheet");
  });
});

interface PrivateNotesManifest {
  version: 1;
  report: Omit<SupercrewNotesReport, "notes">;
  noteCount: number;
  kindCounts: Record<LaborNote["kind"], number>;
  notes: { index: number; expected: Partial<LaborNote>; distinctOwnerAndAuthor?: boolean }[];
}

// Both files stay private. See docs/supercrew-private-fixtures.md; never run with public CI logs.
const referenceWorkbookPath = process.env.SUPERCREW_NOTES_REFERENCE_XLSX;
const referenceManifestPath = process.env.SUPERCREW_NOTES_REFERENCE_MANIFEST;
describe.skipIf(!referenceWorkbookPath || !referenceManifestPath)(
  "private Notes Report reference",
  () => {
    it("matches independently reviewed private scope, counts and source records", async () => {
      const manifest: PrivateNotesManifest = JSON.parse(
        await readFile(referenceManifestPath as string, "utf8"),
      );
      expect(manifest.version).toBe(1);
      const report = await parseSupercrewNotesXlsx(
        await readFile(referenceWorkbookPath as string),
        { period: manifest.report.period, scope: manifest.report.scope },
      );
      const { notes, ...metadata } = report;
      expect(metadata).toEqual(manifest.report);
      expect(notes).toHaveLength(manifest.noteCount);
      expect({
        daily_candidate: notes.filter((note) => note.kind === "daily_candidate").length,
        entry: notes.filter((note) => note.kind === "entry").length,
        other: notes.filter((note) => note.kind === "other").length,
      }).toEqual(manifest.kindCounts);
      for (const check of manifest.notes) {
        expect(
          Number.isInteger(check.index) && check.index >= 0 && check.index < notes.length,
        ).toBe(true);
        expect(Object.keys(check.expected).length).toBeGreaterThan(0);
        const note = notes[check.index];
        if (!note) throw new Error("Reference note index is outside the parsed report.");
        expect(note).toMatchObject(check.expected);
        if (check.distinctOwnerAndAuthor) {
          expect(note.workerName).toBeTruthy();
          expect(note.notetaker).toBeTruthy();
          expect(note.notetaker).not.toBe(note.workerName);
        }
      }
    });
  },
);
