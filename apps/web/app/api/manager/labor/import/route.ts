import { requireLaborAccess } from "@/lib/labor/access";
import { laborUsesSupabase } from "@/lib/labor/config";
import { laborError, laborResponse } from "@/lib/labor/http";
import { ingestLaborFile, ingestLaborNotesFile, type NotesImportOptions } from "@/lib/labor/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export async function POST(request: Request) {
  try {
    const access = await requireLaborAccess(request, true);
    const contentLength = request.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES)
      throw new Error("Excel file is too large");
    // Bound streaming input even when the caller omits Content-Length.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = request.body?.getReader();
    if (!reader) throw new Error("Excel file is required");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error("Excel file is too large");
      }
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const form = await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body,
    }).formData();
    const file = form.get("file");
    if (
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".xlsx") ||
      file.size > MAX_BYTES
    )
      throw new Error("Select an XLSX report up to 2 MB");
    const source = access.worker ? "supercrew" : "upload";
    const scope = form.get("notesScope") ?? "mixed";
    if (scope !== "mixed" && scope !== "daily_timesheet")
      throw new Error("Invalid Notes Report scope");
    // Uploaded XLSX omits Note Type, so a browser cannot assert filtered daily scope.
    if (!access.worker && scope !== "mixed")
      throw new Error("Uploaded Notes Reports require individual daily comment confirmation");
    const notesOptions: NotesImportOptions = {
      scope,
      complete: access.worker || form.get("complete") === "1",
      datesVerified: access.worker || form.get("datesVerified") === "1",
    };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (form.get("kind") === "notes") {
      if (access.worker)
        throw new Error("Recurring imports require paired Timesheet and daily Notes Reports");
      const result = await ingestLaborNotesFile(
        bytes,
        file.name,
        source,
        reportPeriod(form),
        notesOptions,
        access.actor?.userId === "local-development" ? null : (access.actor?.userId ?? null),
      );
      return laborResponse(result, result.duplicate ? 200 : 201);
    }
    const notesFile = form.get("notesFile");
    if (
      notesFile !== null &&
      (!(notesFile instanceof File) ||
        !notesFile.name.toLowerCase().endsWith(".xlsx") ||
        notesFile.size > MAX_BYTES)
    )
      throw new Error("Select a Notes Report XLSX up to 2 MB");
    if (access.worker && (!(notesFile instanceof File) || scope !== "daily_timesheet"))
      throw new Error("Recurring imports require both Timesheet and filtered daily Notes Reports");
    const result = await ingestLaborFile(
      bytes,
      file.name,
      source,
      access.worker ? reportPeriod(form) : undefined,
      notesFile instanceof File
        ? {
            ...notesOptions,
            bytes: new Uint8Array(await notesFile.arrayBuffer()),
            filename: notesFile.name,
          }
        : undefined,
      access.actor?.userId === "local-development" ? null : (access.actor?.userId ?? null),
      access.worker && laborUsesSupabase()
        ? {
            leaseToken: String(form.get("leaseToken") ?? ""),
            commandId: String(form.get("commandId") ?? ""),
          }
        : undefined,
    );
    return laborResponse(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return laborError(error);
  }
}

function reportPeriod(form: FormData) {
  const from = form.get("periodStart");
  const to = form.get("periodEnd");
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) &&
    new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
  if (!valid(from) || !valid(to) || from > to)
    throw new Error("Import requires the requested report period");
  if (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`) > 366 * 86400000)
    throw new Error("Notes Report period must be no longer than one year");
  return { from, to };
}
