import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260818173115_trigger_queue_applied_fixes.sql",
  ),
  "utf8",
);

const applied = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/tests/ra2_applied.sql"),
  "utf8",
);

describe("trigger and queue applied-fixes migration", () => {
  it("nests same-receipt field access by table and covers lines and outbox", () => {
    expect(migration).toContain("if tg_table_name = 'job_candidates' then");
    expect(migration).toContain("elsif tg_table_name = 'receipt_lines' then");
    expect(migration).toContain("elsif tg_table_name = 'housecall_outbox' then");
    expect(migration).toContain("create trigger receipt_lines_same_receipt");
    expect(migration).toContain("create trigger housecall_outbox_same_receipt");
    expect(migration).not.toContain(
      "if tg_table_name = 'job_candidates' and new.receipt_line_id is not null then",
    );
  });

  it("skips held purge claims, defers without dead-lettering, and revives on hold clear", () => {
    expect(migration).toContain("for update of w skip locked");
    expect(migration).toContain("r.retention_hold = true");
    expect(migration).toContain("function public.defer_work");
    expect(migration).toContain("attempt_count = greatest(rec.attempt_count - 1, 0)");
    expect(migration).toContain("and status in ('queued', 'dead_letter')");
  });

  it("redacts audit JSON with the domain secret keys", () => {
    expect(migration).toContain("function public.redact_audit_json");
    expect(migration).toContain("public.redact_audit_json(p_payload)");
    expect(migration).toContain("'access_token'");
  });
});

describe("RA-2 applied permission and execution tests", () => {
  it("asserts anon/authenticated cannot mutate lifecycle tables or privileged RPCs", () => {
    expect(applied).toContain("has_table_privilege('anon', tbl, 'INSERT')");
    expect(applied).toContain("has_function_privilege('anon'");
    expect(applied).toContain("submit_confirmed_receipt");
    expect(applied).toContain("approve_receipt_with_outbox");
    expect(applied).toContain("claim_work");
  });

  it("still covers same-receipt rejection, hold deferral, and rollback", () => {
    expect(applied).toContain("cross-receipt reference");
    expect(applied).toContain("defer_work");
    expect(applied).toContain("rollback");
  });
});
