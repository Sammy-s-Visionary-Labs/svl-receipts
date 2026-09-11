import { EMPTY_REVIEW, type ReviewDraft } from "@svl/domain";
import { housecallCatalogJobIsStale } from "@/lib/housecall/catalog-policy";
import type { ExportStep, ManagerJob } from "./review-contract";

type Row = Record<string, unknown>;
export const textValue = (v: unknown) => (typeof v === "string" ? v : "");
const amount = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? (v / 100).toFixed(2) : "";
export function extractionDraft(row: Row | null): ReviewDraft {
  if (!row) return { ...EMPTY_REVIEW, lines: [] };
  return {
    vendor: textValue(row.vendor),
    purchaseDate: textValue(row.purchase_date),
    invoiceNumber: textValue(row.invoice_number),
    ticketNumber: textValue(row.ticket_number),
    category: textValue(
      (row.normalized as Row | undefined)?.category_suggestion &&
        ((row.normalized as Row).category_suggestion as Row).categoryId,
    ),
    referenceTotal: amount(row.receipt_total_cents),
    managerNotes: "",
    lines: (Array.isArray(row.lines) ? row.lines.slice(0, 100) : []).map(
      (line: Row, index: number) => {
        const sourceIndex =
          Number.isInteger(line.source_index) &&
          Number(line.source_index) >= 0 &&
          Number(line.source_index) < 100
            ? Number(line.source_index)
            : index;
        return {
          id: `${row.id}:${sourceIndex}`,
          sourceIndex,
          description: textValue(line.description),
          qty: typeof line.qty === "number" ? String(line.qty) : "",
          uom: textValue(line.uom),
          unitCost: amount(line.unit_cost_cents),
          jobId: "",
        };
      },
    ),
  };
}
export function managerJob(row: Row): ManagerJob {
  return {
    id: textValue(row.housecall_job_id ?? row.id),
    label: textValue(row.label) || textValue(row.housecall_job_id ?? row.id),
    customer: textValue(row.customer) || null,
    number: textValue(row.job_number) || null,
    status: textValue(row.status) || null,
    scheduledAt: textValue(row.scheduled_at) || null,
    technicians: Array.isArray(row.technicians)
      ? row.technicians.filter((v): v is string => typeof v === "string")
      : [],
    active: row.active !== false,
    source: textValue(row.source) || null,
    unavailable: row.unavailable === true,
    ...(row.source === "housecall"
      ? {
          syncedAt: textValue(row.synced_at) || null,
          stale: housecallCatalogJobIsStale(row),
        }
      : {}),
    ...(typeof row.score === "number" ? { score: row.score } : {}),
    ...(Array.isArray(row.reasons) ? { reasons: row.reasons } : {}),
    ...(typeof row.source_index === "number" ? { sourceIndex: row.source_index } : {}),
    ...(typeof row.scoring_version === "string" ? { scoringVersion: row.scoring_version } : {}),
    ...(row.housecall_job_id ? { suggestionId: textValue(row.id) } : {}),
  };
}
export function buildSteps(
  intent: Row | null,
  attempts: Row[],
  links: Row[],
  commands: Row[],
): ExportStep[] {
  if (!intent) return [];
  const targets = [
    ...(Array.isArray(intent.attachment_job_ids) ? intent.attachment_job_ids : []).map(
      (jobId: string) => ({ jobId, lineId: null as string | null, step: "attachment" }),
    ),
    ...(Array.isArray(intent.job_cost_lines) ? intent.job_cost_lines : []).map((l: Row) => ({
      jobId: textValue(l.job_id),
      lineId: textValue(l.receipt_line_id),
      step: "job_cost",
    })),
  ];
  return targets.map((target) => {
    const same = (a: Row) =>
      a.housecall_job_id === target.jobId &&
      a.step === target.step &&
      (a.receipt_line_id ?? null) === target.lineId;
    const matching = attempts.filter(same);
    const success = matching.find((a) => a.status === "succeeded");
    const link = links.find(same);
    const latest = success ?? matching[0];
    return {
      ...target,
      id: textValue(latest?.id) || `${target.step}:${target.jobId}:${target.lineId ?? ""}`,
      intentId: textValue(intent.id),
      status: link || success ? "succeeded" : textValue(latest?.status) || "pending",
      externalId: textValue(link?.external_id ?? latest?.external_id) || null,
      error: textValue(latest?.error_code) || null,
      createdAt: textValue(latest?.created_at) || null,
      retryQueued: commands.some(
        (c) =>
          c.attempt_id === latest?.id && ["pending", "processing"].includes(textValue(c.status)),
      ),
    };
  });
}
/** Current steps have a separate immutable identity for every page and material line. */
export function buildFrozenSteps(
  intentId: string,
  steps: Row[],
  attempts: Row[],
  commands: Row[],
): ExportStep[] {
  return steps.map((step) => {
    const latest = attempts.find((attempt) => attempt.export_step_id === step.id);
    const payload = step.payload as Row | null;
    const image = payload?.image as Row | undefined;
    return {
      id: textValue(latest?.id) || textValue(step.id),
      exportStepId: textValue(step.id),
      intentId,
      jobId: textValue(step.housecall_job_id),
      lineId: textValue(step.receipt_line_id) || null,
      pageId: textValue(step.receipt_page_id) || null,
      ...(typeof image?.page_index === "number" ? { pageIndex: image.page_index } : {}),
      step: textValue(step.step),
      status: textValue(step.status),
      externalId: textValue(step.external_id) || null,
      error: textValue(step.last_error) || null,
      createdAt: textValue(latest?.created_at ?? step.updated_at) || null,
      retryQueued: commands.some(
        (command) =>
          command.attempt_id === latest?.id &&
          ["pending", "processing"].includes(textValue(command.status)),
      ),
    };
  });
}
/** Legacy reviews were sparse patches; approved receipt_lines remain authoritative. */
export function legacyReviewDraft(
  original: ReviewDraft,
  edits: Record<string, unknown>,
  lines: Record<string, unknown>[],
): ReviewDraft {
  const draft = { ...original };
  const mapping = {
    vendor: "vendor",
    purchase_date: "purchaseDate",
    invoice_number: "invoiceNumber",
    ticket_number: "ticketNumber",
    category: "category",
    manager_notes: "managerNotes",
  } as const;
  for (const [source, target] of Object.entries(mapping))
    if (source in edits && (typeof edits[source] === "string" || edits[source] === null))
      draft[target] = textValue(edits[source]);
  if ("receipt_total_cents" in edits) draft.referenceTotal = amount(edits.receipt_total_cents);
  const evidence = lines.length ? lines : Array.isArray(edits.lines) ? edits.lines : null;
  if (evidence)
    draft.lines = evidence.map((line, index) => ({
      id: textValue(line.id) || `legacy:${index}`,
      description: textValue(line.description),
      qty: typeof line.qty === "number" ? String(line.qty) : "",
      uom: textValue(line.uom),
      unitCost: amount(line.unit_cost_cents),
      jobId: textValue(line.job_id),
    }));
  return draft;
}
