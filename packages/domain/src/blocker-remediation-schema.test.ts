import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ABANDONED_UPLOAD_MAX_AGE_HOURS, RETENTION_DAYS } from "./index";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260818161945_blocker_remediation.sql",
  ),
  "utf8",
);

describe("blocker remediation migration", () => {
  it("adds purge and cleanup fences and does not rewrite the prior hardening file", () => {
    expect(sql).toContain("add column purge_claimed_at timestamptz");
    expect(sql).toContain("add column purge_claimed_by text");
    expect(sql).toContain("add column cleanup_claimed_at timestamptz");
    expect(sql).toContain("function public.release_purge_claim");
    expect(sql).toContain("function public.claim_abandoned_upload");
    expect(sql).toContain(`interval '${ABANDONED_UPLOAD_MAX_AGE_HOURS} hours'`);
    expect(sql).toContain("and cleanup_claimed_at is null");
    expect(sql).not.toContain("rename column retention_starts_at");
  });

  it("starts retention only for a complete current intent, declines, or duplicates", () => {
    expect(sql).toContain("a.intent_id = intent.id");
    expect(sql).toContain("and a.receipt_line_id = line_id");
    expect(sql).toContain("rec.status in ('rejected', 'rejected_unreadable', 'duplicate')");
    expect(sql).toContain(`interval '${RETENTION_DAYS} days'`);
    expect(sql).toContain("function public.keep_retention_clock");
    expect(sql).not.toContain(
      "status in ('rejected', 'rejected_unreadable')\n    or public.both_housecall_steps_succeeded",
    );
  });

  it("keeps receipt line ids on approve and requires job_cost line ids on insert", () => {
    expect(sql).toContain("svl.allow_line_rewrite");
    expect(sql).toContain("and sort_index = ord - 1");
    expect(sql).toContain("'receipt_line_id', l.id");
    expect(sql).toContain("function public.require_job_cost_line_id");
    expect(sql).toContain("and sort_index >= jsonb_array_length(p_lines)");
  });

  it("does not auto-revive dead-lettered purges and revokes future default grants", () => {
    expect(sql).toContain("on conflict (receipt_id, kind) do nothing");
    expect(sql).not.toContain("where public.work_items.status = 'dead_letter'");
    expect(sql).toContain("alter default privileges for role postgres in schema public");
    expect(sql).toContain("revoke all on functions from public, anon, authenticated");
    expect(sql).toContain(
      "grant execute on function public.claim_abandoned_upload(uuid) to service_role",
    );
    expect(sql).toContain(
      "grant execute on function public.release_purge_claim(uuid, text) to service_role",
    );
  });
});
