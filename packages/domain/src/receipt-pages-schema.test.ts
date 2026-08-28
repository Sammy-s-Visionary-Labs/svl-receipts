import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_RECEIPT_BYTES, MAX_RECEIPT_PAGES } from "./upload";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260821152812_ra23_multi_page_upload_confirmation.sql",
  ),
  "utf8",
);

describe("RA-23 multi-page upload schema", () => {
  it("persists an ordered 1-to-many page set with bounded metadata", () => {
    expect(sql).toContain("create table public.receipt_pages");
    expect(sql).toContain(
      "receipt_id uuid not null references public.receipts (id) on delete cascade",
    );
    expect(sql).toContain("unique (receipt_id, page_index)");
    expect(sql).toContain(`page_index < ${MAX_RECEIPT_PAGES}`);
    expect(sql).toContain(
      `byte_size is null or (byte_size > 0 and byte_size <= ${MAX_RECEIPT_BYTES})`,
    );
    expect(sql).toContain(`(page->>'byteSize')::integer > ${MAX_RECEIPT_BYTES}`);
    expect(sql).not.toMatch(/\bbytea\b/i);
  });

  it("backfills confirmation metadata only as one fully valid set", () => {
    const backfill = sql.slice(
      sql.indexOf("insert into public.receipt_pages"),
      sql.indexOf("create or replace function public.create_upload_pending_receipt_set"),
    );
    const confirmationProjection = backfill.slice(
      backfill.indexOf("select"),
      backfill.indexOf("from public.receipts"),
    );
    const validLegacyConfirmation = [
      "r.checksum ~ '^[a-f0-9]{64}$'",
      "r.content_type in ('image/jpeg', 'image/png', 'image/webp')",
      "r.byte_size > 0",
      `r.byte_size <= ${MAX_RECEIPT_BYTES}`,
    ];

    for (const condition of validLegacyConfirmation) {
      expect(confirmationProjection.split(condition)).toHaveLength(4);
    }
  });

  it("keeps client roles read-only and RPC mutations service-role only", () => {
    expect(sql).toContain("alter table public.receipt_pages enable row level security");
    expect(sql).toContain(
      "revoke all on table public.receipt_pages from public, anon, authenticated",
    );
    expect(sql).toContain(
      "grant select on table public.receipt_pages to authenticated, service_role",
    );
    expect(sql).toContain("create_upload_pending_receipt_set");
    expect(sql).toContain("submit_confirmed_receipt_set");
    expect(sql).toContain("to service_role");
  });

  it("submits only an exact, confirmed page manifest", () => {
    expect(sql).toContain("expected_count is distinct from supplied_count");
    expect(sql).toContain("checksum = page->>'checksum'");
    expect(sql).toContain("confirmed_at = now()");
    expect(sql).toContain("status = 'submitted'");
    expect(sql).toContain("p_manifest_checksum");
  });

  it("clears every location field in the fenced content purge", () => {
    const purge = sql.slice(sql.indexOf("create or replace function public.purge_receipt_content"));
    expect(purge).toContain("gps_lat = null");
    expect(purge).toContain("gps_lng = null");
    expect(purge).toContain("gps_accuracy_meters = null");
    expect(purge).toContain("gps_captured_at = null");
  });
});
