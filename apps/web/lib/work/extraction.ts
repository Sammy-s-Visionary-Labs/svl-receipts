import { type ReceiptContentType, WORK_LEASE_SECONDS } from "@svl/domain";
import {
  createGeminiReceiptAdapter,
  GEMINI_RECEIPT_MODEL,
  GeminiReceiptError,
} from "@svl/integrations";
import sharp from "sharp";
import { buildReceiptIntelligence } from "@/lib/manager/intelligence";
import { readReceiptObject } from "@/lib/storage/receipts";
import type { createServiceRoleClient } from "@/lib/supabase/service";
import type { WorkRow } from "./runner";

export const EXTRACTION_PROVIDER_TIMEOUT_MS = 90_000;

type ExtractionPage = {
  page_index: number;
  storage_key: string;
  content_type: ReceiptContentType;
  confirmed_at: string | null;
};

/** Apply EXIF orientation before sending pages, strip metadata, and bound decoder
 * memory. Invalid files fail permanently; stored originals remain immutable. */
export async function normalizeExtractionPage(bytes: Uint8Array): Promise<Uint8Array> {
  try {
    return await sharp(bytes, { limitInputPixels: 50_000_000, failOn: "error" })
      .rotate()
      .resize({ width: 3000, height: 4000, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch {
    throw new GeminiReceiptError("permanent", "invalid_page_set");
  }
}

export async function runExtraction(
  supabase: ReturnType<typeof createServiceRoleClient>,
  row: WorkRow,
  workerId: string,
): Promise<void> {
  const generation = row.generation ?? 1;
  const { data: existing, error: existingError } = await supabase
    .from("extractions")
    .select("id")
    .eq("work_item_id", row.id)
    .eq("generation", generation)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing) return;
  const { error: duplicateError } = await supabase.rpc("record_exact_duplicate_candidates", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_generation: generation,
  });
  if (duplicateError) throw duplicateError;
  const { data, error } = await supabase
    .from("receipt_pages")
    .select("page_index,storage_key,content_type,confirmed_at")
    .eq("receipt_id", row.receipt_id)
    .order("page_index", { ascending: true });
  if (error) throw error;
  const pages = (data ?? []) as ExtractionPage[];
  if (
    pages.length < 1 ||
    pages.length > 5 ||
    pages.some((page, index) => !page.confirmed_at || page.page_index !== index)
  ) {
    throw new GeminiReceiptError("permanent", "invalid_page_set");
  }
  const providerPages = [];
  for (const page of pages) {
    const object = await readReceiptObject(page.storage_key);
    if (!object) throw new GeminiReceiptError("retryable", "storage_object_missing");
    providerPages.push({
      pageIndex: page.page_index,
      mimeType: "image/jpeg" as const,
      bytes: await normalizeExtractionPage(object.bytes),
    });
  }
  const { error: leaseError } = await supabase.rpc("renew_work_lease", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_lease_seconds: WORK_LEASE_SECONDS,
  });
  if (leaseError) throw leaseError;
  const provider = (process.env.AI_PROVIDER || "gemini").trim().toLowerCase();
  if (provider !== "gemini" && provider !== "google_gemini")
    throw new GeminiReceiptError("permanent", "provider_not_configured");
  const adapter = createGeminiReceiptAdapter({
    apiKey: process.env.GEMINI_API_KEY || process.env.AI_API_KEY || "",
    model: process.env.GEMINI_EXTRACTION_MODEL || GEMINI_RECEIPT_MODEL,
    timeoutMs: EXTRACTION_PROVIDER_TIMEOUT_MS,
  });
  const result = await adapter.parseReceipt(providerPages);
  const intelligence = await buildReceiptIntelligence(supabase, row.receipt_id, result.receipt);
  const { error: resultError } = await supabase.rpc("record_extraction_result", {
    p_work_id: row.id,
    p_worker_id: workerId,
    p_generation: generation,
    p_result: result.receipt,
    p_model: result.model,
    p_prompt_version: result.promptVersion,
    p_usage: result.usage,
    p_intelligence: intelligence,
  });
  if (resultError) throw resultError;
}
