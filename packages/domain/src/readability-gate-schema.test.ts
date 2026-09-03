import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260828180628_ra25_gemini_readability_gate.sql",
  ),
  "utf8",
);

const invariantMigration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260901173015_ra25_readability_completion_invariants.sql",
  ),
  "utf8",
);

describe("RA-25 readability gate schema", () => {
  it("queues readability before extraction and persists only normalized evidence", () => {
    expect(migration).toContain("values (new.id, 'readability', 'queued', now())");
    expect(migration).toContain("create table public.readability_checks");
    expect(migration).toContain("failed_page_indexes smallint[]");
    expect(migration).toContain("reasons text[]");
    expect(migration).toContain("when 'provider_unavailable' then 'provider_unavailable'");
    expect(migration).not.toMatch(/raw_(response|text)|ocr_text/i);
  });

  it("rejects only an explicit unreadable result and otherwise starts extraction", () => {
    const resultFunction = migration.slice(
      migration.indexOf("create or replace function public.record_readability_result"),
      migration.indexOf("create or replace function public.fail_dead_lettered_readability"),
    );
    expect(resultFunction).toContain("if is_readable then");
    expect(resultFunction).toContain("'extract', 'queued'");
    expect(resultFunction).toContain("status = 'rejected_unreadable'");
    expect(resultFunction).toContain("not is_readable");
  });

  it("keeps provider failures out of rejected_unreadable", () => {
    const failureFunction = migration.slice(
      migration.indexOf("create or replace function public.fail_dead_lettered_readability"),
      migration.indexOf("create or replace function public.delete_readability_checks_after_purge"),
    );
    expect(failureFunction).toContain("status = 'failed'");
    expect(failureFunction).not.toContain("rejected_unreadable");
  });

  it("uses RLS, explicit grants, append-only evidence, and purge cleanup", () => {
    expect(migration).toContain("alter table public.readability_checks enable row level security");
    expect(migration).toContain(
      "revoke all on table public.readability_checks from public, anon, authenticated",
    );
    expect(migration).toContain("readability_checks_append_only");
    expect(migration).toContain("receipts_delete_readability_after_purge");
  });

  it("requires matching evidence before readability work can succeed", () => {
    const completionFunction = invariantMigration.slice(
      invariantMigration.indexOf("create or replace function public.complete_work"),
      invariantMigration.indexOf("revoke all on function public.record_readability_result"),
    );
    expect(completionFunction).toContain("rec.kind = 'readability'");
    expect(completionFunction).toContain("from public.readability_checks as evidence");
    expect(completionFunction).toContain("evidence.work_item_id = rec.id");
    expect(completionFunction).toContain("evidence.receipt_id = rec.receipt_id");
    expect(completionFunction.indexOf("from public.readability_checks as evidence")).toBeLessThan(
      completionFunction.indexOf("status = 'succeeded'"),
    );
  });

  it("validates JSON element types and ranges before casting provider output", () => {
    const resultFunction = invariantMigration.slice(
      invariantMigration.indexOf("create or replace function public.record_readability_result"),
      invariantMigration.indexOf("create or replace function public.complete_work"),
    );
    expect(resultFunction).toContain("jsonb_typeof(item.value) is distinct from 'number'");
    expect(resultFunction).toContain("item.value::text not in ('0', '1', '2', '3', '4')");
    expect(resultFunction).toContain("jsonb_typeof(item.value) is distinct from 'string'");
    expect(resultFunction).toContain("raise exception 'invalid_request'");
    expect(resultFunction.indexOf("item.value::text not in")).toBeLessThan(
      resultFunction.indexOf("array_agg((item.value::text)::smallint"),
    );
  });

  it("keeps replacement RPCs locked down", () => {
    expect(invariantMigration.match(/set search_path = ''/g)).toHaveLength(2);
    expect(invariantMigration).toContain(
      "revoke all on function public.record_readability_result(uuid, text, jsonb, text, text, jsonb)",
    );
    expect(invariantMigration).toContain("revoke all on function public.complete_work(uuid, text)");
    expect(invariantMigration).toContain(
      "grant execute on function public.complete_work(uuid, text)\n  to service_role",
    );
  });
});
