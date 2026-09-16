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
