import { describe, expect, it } from "vitest";
import { readIntelligenceConfig } from "./intelligence";

describe("controlled intelligence configuration", () => {
  it("has explicit conservative defaults and allows operational tuning", () => {
    expect(readIntelligenceConfig({})).toEqual({
      duplicate: { threshold: 45, amountToleranceCents: 0 },
      jobs: { maxGpsAccuracyMeters: 100, maxDistanceKm: 10, minScore: 8 },
    });
    expect(
      readIntelligenceConfig({
        RECEIPT_DUPLICATE_THRESHOLD: "75",
        RECEIPT_JOB_MAX_GPS_ACCURACY_METERS: "50",
      }),
    ).toMatchObject({ duplicate: { threshold: 75 }, jobs: { maxGpsAccuracyMeters: 50 } });
  });
  it.each(["NaN", "-1", "101", " 45 ", "1e2"])(
    "rejects invalid thresholds %s rather than silently choosing another configuration",
    (value) => {
      expect(() => readIntelligenceConfig({ RECEIPT_DUPLICATE_THRESHOLD: value })).toThrow(
        "invalid_intelligence_config",
      );
    },
  );
  it("requires whole cents for duplicate tolerance", () => {
    expect(() =>
      readIntelligenceConfig({ RECEIPT_DUPLICATE_AMOUNT_TOLERANCE_CENTS: "1.5" }),
    ).toThrow();
  });
});

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedReceiptV1 } from "@svl/domain";
import { vi } from "vitest";
import { buildReceiptIntelligence } from "./intelligence";

describe("extraction enrichment against the saved catalog", () => {
  const receipt: ParsedReceiptV1 = {
    schema_version: 1,
    provider: "gemini",
    document_kind: "receipt",
    vendor: "Select",
    purchase_date: "2026-09-08",
    invoice_number: "TEST-1",
    ticket_number: null,
    currency: "USD",
    receipt_total_cents: 2470,
    tax_cents: 0,
    subtotal_cents: 2470,
    material_total_cents: 2470,
    lines: [
      {
        source_index: 2,
        page_index: 0,
        description: "PVC pipe",
        qty: 1,
        uom: "ea",
        unit_cost_cents: 2470,
        extended_cost_cents: 2470,
        printed_extended_cost_cents: 2470,
        job_hint: "TEST-2048",
      },
    ],
    job_hints: [{ text: "PO TEST-1042", page_index: 0 }],
    original_observation: {
      schema_version: 1,
      document_kind: "receipt",
      vendor: "Select",
      purchase_date: "2026-09-08",
      invoice_number: "TEST-1",
      ticket_number: null,
      currency: "USD",
      receipt_total: "24.70",
      tax: "0.00",
      subtotal: "24.70",
      lines: [
        {
          page_index: 0,
          description: "Tax",
          qty: null,
          uom: null,
          unit_cost: null,
          extended_cost: "0.00",
          job_hint: null,
        },
        {
          page_index: 0,
          description: "Total",
          qty: null,
          uom: null,
          unit_cost: null,
          extended_cost: "24.70",
          job_hint: null,
        },
        {
          page_index: 0,
          description: "PVC pipe",
          qty: "1",
          uom: "ea",
          unit_cost: "24.70",
          extended_cost: "24.70",
          job_hint: "TEST-2048",
        },
      ],
      job_hints: [{ text: "PO TEST-1042", page_index: 0 }],
      raw_text: "Private raw data",
      evidence: [],
    },
    raw_text: "Private raw data",
    evidence: [],
    confidence: {},
    warnings: [],
  };
  function client(deleted = false) {
    const rpc = vi.fn(async () => ({
      data: [
        {
          id: "receipt",
          owner_user_id: "worker",
          page_hashes: ["hash"],
          content_deleted_at: deleted ? "now" : null,
        },
        {
          id: "duplicate",
          page_hashes: ["different-photo"],
          vendor: "Select",
          purchase_date: "2026-09-08",
          receipt_total_cents: 2470,
          invoice_number: "TEST-1",
        },
      ],
      error: null,
    }));
    const from = vi.fn((table: string) => {
      const data =
        table === "receipt_categories"
          ? [{ id: "materials", label: "Materials", active: true, keywords: ["pipe"], version: 1 }]
          : [
              {
                id: "ra5-test-job-sullivan",
                label: "Sullivan",
                job_number: "TEST-1042",
                active: true,
              },
              { id: "ra5-test-job-oak", label: "Oak", job_number: "TEST-2048", active: true },
            ];
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "order", "limit", "range"])
        chain[method] = vi.fn(() => chain);
      // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are awaitable.
      chain.then = (resolve: (v: unknown) => void) => resolve({ data, error: null });
      return chain;
    });
    return { supabase: { rpc, from } as unknown as SupabaseClient, rpc, from };
  }
  it("maps only catalog IDs and preserves sparse line source indices in the atomic payload", async () => {
    const { supabase, rpc } = client();
    const result = await buildReceiptIntelligence(supabase, "receipt", receipt);
    expect(rpc).toHaveBeenCalledWith(
      "extraction_duplicate_inputs",
      expect.objectContaining({
        p_receipt_id: "receipt",
        p_vendor: "Select",
        p_invoice_number: "TEST-1",
      }),
    );
    expect(result.categorySuggestion.categoryId).toBe("materials");
    expect(result.duplicateCandidates[0]?.receiptId).toBe("duplicate");
    expect(result.jobCandidates.filter((job) => job.sourceIndex === 2)[0]).toMatchObject({
      jobId: "ra5-test-job-oak",
      sourceIndex: 2,
    });
    expect(JSON.stringify(result)).not.toContain("Private raw data");
  });
  it("does not enrich purged receipt contents", async () => {
    await expect(
      buildReceiptIntelligence(client(true).supabase, "receipt", receipt),
    ).rejects.toThrow("receipt_content_unavailable");
  });
});
