type JobLabel = {
  id?: string;
  label?: string | null;
  customer?: string | null;
  number?: string | null;
};

/** One label for suggestions, selections, history and export confirmation. IDs stay in values. */
export function jobLabel(job?: JobLabel | null): string {
  if (!job) return "Job details unavailable";
  const readable = (value?: string | null) =>
    value && value !== job.id && !/^job_[a-z0-9]+$/i.test(value) ? value.trim() : "";
  const customer = readable(job.customer);
  const label = readable(job.label);
  const name =
    label && customer && !label.toLocaleLowerCase().includes(customer.toLocaleLowerCase())
      ? `${customer} · ${label}`
      : label || customer || "Job details unavailable";
  const number = job.number?.replace(/^#/, "").trim();
  return number && !name.includes(`#${number}`) ? `${name} #${number}` : name;
}

type JobMetadata = {
  status?: string | null;
  scheduledAt?: string | null;
  technicians?: readonly string[];
  syncedAt?: string | null;
};
const jobDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/New_York",
});
const statusLabels: Record<string, string> = {
  "complete unrated": "Completed (unrated)",
  "complete rated": "Completed (rated)",
  complete: "Completed",
  completed: "Completed",
  scheduled: "Scheduled",
  "needs scheduling": "Needs scheduling",
  "in progress": "In progress",
  canceled: "Canceled",
  cancelled: "Canceled",
};
function readableJobDate(value?: string | null): string | null {
  if (!value?.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? jobDate.format(date) : null;
}
function isInternalTechnicianId(value: string): boolean {
  return (
    /^(?:pro|employee|emp|usr|user)_[a-z0-9_-]+$/i.test(value) ||
    /^[a-f0-9]{32}$/i.test(value) ||
    /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)
  );
}

/** Display labels only. Provider IDs remain available to matching and export logic. */
export function jobMetadata(job: JobMetadata): string {
  const rawStatus = job.status?.trim().replaceAll("_", " ").replace(/\s+/g, " ").toLowerCase();
  const status =
    rawStatus && /^[a-z][a-z -]{0,60}$/.test(rawStatus)
      ? (statusLabels[rawStatus] ?? rawStatus[0]?.toUpperCase() + rawStatus.slice(1))
      : "Status unavailable";
  const schedule = readableJobDate(job.scheduledAt);
  const explicitlyUnscheduled = rawStatus === "needs scheduling" || rawStatus === "unscheduled";
  const technicians = [
    ...new Set((job.technicians ?? []).map((name) => name.trim()).filter(Boolean)),
  ];
  const names = technicians.filter((name) => !isInternalTechnicianId(name));
  const parts = [
    status,
    schedule
      ? `Scheduled ${schedule}`
      : !job.scheduledAt?.trim() && explicitlyUnscheduled
        ? "Unscheduled"
        : "Schedule unavailable",
    names.length ? `Technicians: ${names.join(", ")}` : "Technician names unavailable",
  ];
  if (names.length && names.length !== technicians.length)
    parts.push("Some technician names unavailable");
  const syncedAt = readableJobDate(job.syncedAt);
  if (syncedAt) parts.push(`Last checked ${syncedAt}`);
  return parts.join(" · ");
}

export function extractionFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    purchase_date: "Purchase date",
    receipt_total_cents: "Receipt total",
    subtotal_cents: "Subtotal",
    tax_cents: "Tax",
    currency: "Currency",
    vendor: "Vendor",
    job_hint: "Job name",
    printed_extended_cost_cents: "Line total",
    unit_cost_cents: "Unit cost",
    qty: "Quantity",
    description: "Description",
    uom: "Unit",
    invoice_number: "Invoice number",
    ticket_number: "Ticket number",
  };
  const line = /^lines\.(\d+)\.(.+)$/.exec(field);
  return line
    ? `Material ${Number(line[1]) + 1}: ${labels[line[2]] ?? "extracted detail"}`
    : (labels[field] ?? "Receipt detail");
}

export function groupExtractionWarnings(
  warnings: Array<{ field: string; code: string; message: string }>,
) {
  const groups = new Map<string, { code: string; message: string; fields: string[] }>();
  for (const warning of warnings) {
    const key = `${warning.code}:${warning.message}`;
    const group = groups.get(key) ?? { code: warning.code, message: warning.message, fields: [] };
    const label = extractionFieldLabel(warning.field);
    if (!group.fields.includes(label)) group.fields.push(label);
    groups.set(key, group);
  }
  return [...groups.values()];
}
