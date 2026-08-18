import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS } from "./audit";
import { HOUSECALL_OUTBOX_STATUSES } from "./outbox";
import { WORK_KINDS, WORK_MAX_ATTEMPTS, WORK_STATUSES } from "./work";

const sql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260814190000_audit_work_outbox.sql",
  ),
  "utf8",
);

const auditReplaySql = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/20260818191408_ra2_audit_and_replay_fixes.sql",
  ),
  "utf8",
);

function namedCheck(name: string, source = sql): string {
  const marker = `constraint ${name}`;
  const start = source.lastIndexOf(marker);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const open = source.indexOf("check (", start);
  expect(open, `missing check body for ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open + "check ".length; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unbalanced check () for ${name}`);
}

describe("RA-18 audit, work, and outbox migration", () => {
  it("creates append-only audit events with actor, action, before/after, and correlation id", () => {
    expect(sql).toContain("create table public.audit_events");
    expect(sql).toContain("actor_id uuid");
    expect(sql).toContain("correlation_id uuid not null");
    expect(sql).toContain("before_ref jsonb");
    expect(sql).toContain("after_ref jsonb");
    expect(sql).toContain("create trigger audit_events_append_only");
    const actionCheck = namedCheck("audit_events_action_check", `${sql}\n${auditReplaySql}`);
    for (const action of AUDIT_ACTIONS) {
      expect(actionCheck).toContain(`'${action}'`);
    }
  });

  it("leases work with skip locked, attempt count, next attempt, and dead-letter", () => {
    expect(sql).toContain("create table public.work_items");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("attempt_count integer not null default 0");
    expect(sql).toContain("next_attempt_at timestamptz not null");
    expect(sql).toContain("lease_expires_at timestamptz");
    expect(sql).toContain("terminal_reason text");
    expect(sql).toContain(`rec.attempt_count >= ${WORK_MAX_ATTEMPTS}`);
    expect(sql).toContain("function public.claim_work");
    expect(sql).toContain("function public.renew_work_lease");
    expect(sql).toContain("function public.complete_work");
    expect(sql).toContain("function public.fail_work");
    const statusCheck = namedCheck("work_items_status_check");
    for (const status of WORK_STATUSES) {
      expect(statusCheck).toContain(`'${status}'`);
    }
    expect(namedCheck("work_items_kind_check")).toContain("'extract'");
    expect(namedCheck("work_items_kind_check")).toContain("'export'");
  });

  it("commits Housecall outbox only for approved receipts", () => {
    expect(sql).toContain("create table public.housecall_outbox");
    expect(sql).toContain("function public.approve_receipt_with_outbox");
    expect(sql).toContain("unapproved receipt cannot enter the export queue");
    expect(sql).toContain("approved receipt requires housecall outbox");
    expect(sql).toContain("deferrable initially deferred");
    expect(sql).toContain(
      "insert into public.work_items (receipt_id, kind, status, next_attempt_at)",
    );
    expect(sql).toContain("'export'");
    const outboxCheck = namedCheck("housecall_outbox_status_check");
    for (const status of HOUSECALL_OUTBOX_STATUSES) {
      expect(outboxCheck).toContain(`'${status}'`);
    }
    expect(sql).toContain("on conflict (receipt_id, kind) do nothing");
  });

  it("schedules extract work exactly once when a receipt is submitted", () => {
    expect(sql).toContain("constraint work_items_receipt_id_kind_key unique (receipt_id, kind)");
    expect(sql).toContain("function public.submit_confirmed_receipt");
    expect(sql).toContain("values (new.id, 'extract', 'queued', now())");
    expect(WORK_KINDS).toContain("extract");
  });
});
