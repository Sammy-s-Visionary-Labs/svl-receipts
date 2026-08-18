import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260818183938_persistable_work_and_hold_recovery.sql",
  ),
  "utf8",
);

const applied = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/tests/ra2_applied.sql"),
  "utf8",
);

describe("persistable work and hold-recovery migration", () => {
  it("allowlists persisted work reasons and audits defer_work", () => {
    expect(migration).toContain("function public.persistable_work_reason");
    expect(migration).toContain("reason := public.persistable_work_reason(p_reason)");
    expect(migration).toContain("'work_retried'");
    expect(migration).toContain("raise exception 'retention_hold'");
    expect(migration).toContain("raise exception 'purge_not_eligible'");
  });

  it("revives only hold-caused dead letters and skips no-op hold audits", () => {
    expect(migration).toContain("attempt_count = 0");
    expect(migration).toContain("terminal_reason in ('retention_hold', 'conflict')");
    expect(migration).toContain("if rec.retention_hold then");
    expect(migration).toContain("if not rec.retention_hold then");
  });
});

describe("RA-2 applied permission and execution tests", () => {
  it("creates an auth user and executes approve, retention, purge, and fail_work paths", () => {
    expect(applied).toContain("insert into auth.users");
    expect(applied).toContain("approve_receipt_with_outbox");
    expect(applied).toContain("partial Housecall export must not start retention");
    expect(applied).toContain("delete_after_at must be retention_started_at + 365 days");
    expect(applied).toContain("purge_receipt_content");
    expect(applied).toContain("Authorization: Bearer TOPSECRET");
    expect(applied).toContain("public.work_items");
    expect(applied).toContain("public.housecall_outbox");
    expect(applied).toContain("rollback");
  });
});
