import { type ReviewDraft, validateReview } from "@svl/domain";
import { HttpError } from "@/lib/http";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validId(id: string) {
  if (!UUID.test(id)) throw new HttpError(400, "invalid_request", "Invalid receipt ID");
}
export function parseDraft(value: unknown): ReviewDraft {
  const fail = (): never => {
    throw new HttpError(400, "invalid_request", "Invalid review fields");
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const d = value as Record<string, unknown>;
  const string = (v: unknown, max: number) =>
    typeof v === "string" && v.length <= max ? v.trim() : fail();
  if (!Array.isArray(d.lines) || d.lines.length > 100) return fail();
  const draft: ReviewDraft = {
    vendor: string(d.vendor, 200),
    purchaseDate: string(d.purchaseDate, 10),
    invoiceNumber: string(d.invoiceNumber, 120),
    ticketNumber: string(d.ticketNumber, 120),
    category: string(d.category, 100),
    referenceTotal: string(d.referenceTotal, 16),
    managerNotes: string(d.managerNotes, 2000),
    lines: d.lines.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
      const l = value as Record<string, unknown>;
      const suggestionId = l.suggestionId === undefined ? undefined : string(l.suggestionId, 36);
      if (suggestionId && !UUID.test(suggestionId)) return fail();
      return {
        ...(typeof l.id === "string" && l.id.length <= 80 ? { id: l.id } : {}),
        ...(Number.isInteger(l.sourceIndex) &&
        Number(l.sourceIndex) >= 0 &&
        Number(l.sourceIndex) < 100
          ? { sourceIndex: Number(l.sourceIndex) }
          : {}),
        description: string(l.description, 500),
        qty: string(l.qty, 16),
        uom: string(l.uom, 40),
        unitCost: string(l.unitCost, 16),
        jobId: string(l.jobId, 200),
        ...(suggestionId ? { suggestionId } : {}),
      };
    }),
  };
  if (Object.keys(validateReview(draft)).length)
    throw new HttpError(400, "invalid_request", "Check the dates, quantities, and costs.");
  return draft;
}
export async function readReviewBody(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "invalid_request", "A request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 128000) {
        await reader.cancel();
        throw new HttpError(413, "invalid_request", "Review is too large");
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid");
    return body;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid_request", "Invalid JSON");
  }
}
