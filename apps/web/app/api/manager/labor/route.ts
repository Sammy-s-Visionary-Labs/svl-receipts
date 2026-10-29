import { requireLaborAccess } from "@/lib/labor/access";
import { laborError, laborResponse, laborStreamResponse } from "@/lib/labor/http";
import { loadLaborDashboard } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  try {
    await requireLaborAccess(request);
    const data = await loadLaborDashboard();
    const format = new URL(request.url).searchParams.get("format");
    if (["csv", "allocations", "days"].includes(format ?? "")) {
      const rows =
        format === "days"
          ? [
              [
                "Date",
                "Worker",
                "Gross hours",
                "Source break hours",
                "Source net hours",
                "Daily lunch adjustment",
                "Net daily hours",
                "Job hours (before lunch)",
                "Excluded hours",
                "Pending hours",
                "Review reasons",
              ],
              ...data.allocation.workerDays.map((day) => [
                day.date,
                day.workerName,
                day.grossHours,
                day.sourceBreakHours,
                day.sourceNetHours,
                day.lunchAdjustmentHours,
                day.netHours,
                day.allocatedHours,
                day.excludedHours,
                day.pendingHours,
                day.reviewReasons.join("; "),
              ]),
            ]
          : format === "allocations"
            ? [
                [
                  "Date",
                  "Worker",
                  "Source entry ID",
                  "Source job",
                  "Source Hours",
                  "Status",
                  "Allocated job",
                  "Allocated hours",
                  "Excluded hours",
                  "Pending hours",
                  "Reason",
                  "Review reasons",
                  "Note IDs",
                  "Source import ID",
                  "Source row",
                ],
                ...data.allocation.entries.map((entry) => {
                  const source = data.entries.find((row) => row.id === entry.sourceEntryId);
                  return [
                    entry.date,
                    entry.workerName,
                    entry.sourceEntryId,
                    source?.jobName,
                    entry.sourceHours,
                    entry.status,
                    entry.job?.name ?? "",
                    entry.allocatedHours,
                    entry.excludedHours,
                    entry.pendingHours,
                    entry.reason,
                    entry.reviewReasons.join("; "),
                    entry.noteIds.join("; "),
                    source?.importId,
                    entry.sourceRow,
                  ];
                }),
              ]
            : [
                [
                  "Date",
                  "Worker",
                  "Source job",
                  "Address",
                  "Hours",
                  "Travel",
                  "Reported labor cost",
                  "Import ID",
                  "Source row",
                ],
                ...data.entries.map((row) => [
                  row.date,
                  row.workerName,
                  row.jobName,
                  row.jobAddress,
                  row.hours,
                  row.travel ? "Yes" : "No",
                  (row.laborCostCents / 100).toFixed(2),
                  row.importId,
                  row.sourceRow,
                ]),
              ];
      return laborStreamResponse(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="supercrew-${format === "csv" ? "hours" : format}.csv"`,
      });
    }
    return laborResponse(data, 200, { stream: true });
  } catch (error) {
    return laborError(error);
  }
}
