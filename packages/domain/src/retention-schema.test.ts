import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BACKUP_EXPIRATION_NOTE, RETENTION_DAYS, RETENTION_START_EVENT } from "./retention";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const sql = readFileSync(
  join(root, "supabase/migrations/20260814200000_retention_lifecycle.sql"),
  "utf8",
);
const envDocs = readFileSync(join(root, "docs/environments.md"), "utf8");

describe("RA-19 retention migration", () => {
  it("stores deletion eligibility from the submitted start event and policy version", () => {
    expect(sql).toContain("retention_policy_version integer not null default 1");
    expect(sql).toContain("retention_starts_at timestamptz");
    expect(sql).toContain("delete_after_at timestamptz");
    expect(sql).toContain(`interval '${RETENTION_DAYS} days'`);
    expect(sql).toContain("retention_starts_at = submitted_at");
    expect(sql).not.toContain("retention_starts_at = created_at");
  });

  it("requires an owner and reason for holds, and purges content without Housecall rows", () => {
    expect(sql).toContain("constraint receipts_retention_hold_check");
    expect(sql).toContain("retention_hold_owner_id is not null");
    expect(sql).toContain("function public.set_retention_hold");
    expect(sql).toContain("function public.purge_receipt_content");
    expect(sql).toContain("function public.enqueue_due_purges");
    expect(sql).toContain("delete from public.extractions");
    expect(sql).toContain("delete from public.reviews");
    expect(sql).not.toContain("delete from public.housecall_links");
    expect(sql).not.toContain("delete from public.housecall_intents");
    expect(sql).not.toContain("delete from public.export_attempts");
    expect(sql).not.toContain("delete from public.audit_events");
    expect(sql).toContain("'purge'");
    expect(sql).toContain("svl.allow_purge");
  });

  it("documents backup expiration as a release risk", () => {
    expect(envDocs).toContain("PITR");
    expect(envDocs).toMatch(/backup/i);
    expect(BACKUP_EXPIRATION_NOTE).toMatch(/backup/i);
    expect(RETENTION_START_EVENT).toBe("housecall_export_succeeded_or_declined");
  });
});
