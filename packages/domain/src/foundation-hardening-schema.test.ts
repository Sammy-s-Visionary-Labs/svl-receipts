import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RETENTION_DAYS, RETENTION_START_EVENT } from "./retention";
import { WORK_HANDLED_KINDS } from "./work";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260814210000_foundation_hardening.sql",
  ),
  "utf8",
);

describe("foundation hardening migration", () => {
  it("renames the retention clock and does not start it on submit", () => {
    expect(sql).toContain("rename column retention_starts_at to retention_started_at");
    expect(sql).toContain("function public.maybe_start_retention");
    expect(sql).toContain("function public.both_housecall_steps_succeeded");
    expect(sql).toContain(`interval '${RETENTION_DAYS} days'`);
    expect(sql).toContain("rec.status in ('rejected', 'rejected_unreadable')");
    expect(sql).not.toContain("retention_started_at = submitted_at");
    expect(sql).not.toContain("retention_starts_at = now()");
    expect(sql).toContain("p_checksum text");
    expect(sql).toContain("submitted_at = now()");
    expect(RETENTION_START_EVENT).toBe("housecall_export_succeeded_or_declined");
  });

  it("revokes Data API mutations and privileged RPCs from anon and authenticated", () => {
    expect(sql).toContain("revoke insert, update, delete, truncate on table");
    expect(sql).toContain("from public, anon, authenticated");
    expect(sql).toContain("revoke select on table");
    expect(sql).toContain(
      "revoke all on function public.create_upload_pending_receipt(uuid, uuid, text, text, text, uuid) from public, anon, authenticated",
    );
    expect(sql).toContain(
      "revoke all on function public.submit_confirmed_receipt(uuid, uuid, text, integer, uuid) from public, anon, authenticated",
    );
    expect(sql).toContain(
      "revoke all on function public.approve_receipt_with_outbox(uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated",
    );
    expect(sql).toContain(
      "revoke all on function public.set_retention_hold(uuid, uuid, boolean, text, uuid) from public, anon, authenticated",
    );
    expect(sql).toContain("grant execute on function public.create_upload_pending_receipt");
    expect(sql).toContain("to service_role");
    expect(sql).toContain("and public.caller_is_active()");
  });

  it("filters claim_work by kind, re-enqueues dead-lettered purges, and deletes abandoned uploads", () => {
    expect(sql).toContain("p_kinds text[] default array['purge']::text[]");
    expect(sql).toContain("if p_kinds is null or cardinality(p_kinds) = 0 then");
    expect(sql).toContain("function public.delete_abandoned_upload");
    expect(sql).toContain("function public.assert_purge_eligible");
    expect(sql).toContain("where public.work_items.status = 'dead_letter'");
    expect(sql).toContain("gps_lat = null");
    expect(sql).toContain("gps_lng = null");
    expect(WORK_HANDLED_KINDS).toEqual(["purge"]);
  });
});
