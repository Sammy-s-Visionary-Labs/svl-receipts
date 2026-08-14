import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOUSECALL_PAYLOAD_VERSION,
  HOUSECALL_STEP_KINDS,
  HOUSECALL_STEP_STATUSES,
} from "./housecall";

const MIGRATION = "20260814140000_housecall_export_schema.sql";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations", MIGRATION),
  "utf8",
);

function namedCheck(name: string): string {
  const marker = `constraint ${name}`;
  const start = sql.indexOf(marker);
  expect(start, `missing ${name}`).toBeGreaterThan(-1);
  const open = sql.indexOf("check (", start);
  expect(open, `missing check body for ${name}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open + "check ".length; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return sql.slice(open, i + 1);
      }
    }
  }
  throw new Error(`unbalanced check () for ${name}`);
}

describe("RA-83 Housecall export migration", () => {
  it("creates job candidates, intents, links, and export attempts with FKs", () => {
    expect(sql).toContain("create table public.job_candidates");
    expect(sql).toContain("create table public.housecall_intents");
    expect(sql).toContain("create table public.housecall_links");
    expect(sql).toContain("create table public.export_attempts");
    const receiptFks = sql.match(/receipt_id uuid not null references public\.receipts \(id\)/g);
    expect(receiptFks?.length).toBe(4);
    expect(sql).toContain("receipt_line_id uuid references public.receipt_lines (id)");
    expect(sql).toContain("intent_id uuid references public.housecall_intents (id)");
  });

  it("stores payload_version, step, job, line, and external ids on links and attempts", () => {
    expect(sql.match(/payload_version integer not null default 1/g)?.length).toBe(3);
    expect(sql).toContain(`default ${HOUSECALL_PAYLOAD_VERSION}`);
    expect(sql).toContain("housecall_job_id text not null");
    expect(sql).toContain("external_id text not null");
    expect(sql).toContain("external_id text,\n  error_code text");
    for (const kind of HOUSECALL_STEP_KINDS) {
      expect(namedCheck("housecall_links_step_check")).toContain(`'${kind}'`);
      expect(namedCheck("export_attempts_step_check")).toContain(`'${kind}'`);
    }
  });

  it("stores every Housecall step status on export attempts", () => {
    const statusCheck = namedCheck("export_attempts_status_check");
    for (const status of HOUSECALL_STEP_STATUSES) {
      expect(statusCheck).toContain(`'${status}'`);
    }
  });

  it("indexes status, aging, receipt id, job id, and idempotency key", () => {
    expect(sql).toContain("create index export_attempts_status_created_at_idx");
    expect(sql).toContain("on public.export_attempts (status, created_at)");
    expect(sql).toContain("create index export_attempts_receipt_id_created_at_idx");
    expect(sql).toContain("create index export_attempts_housecall_job_id_idx");
    expect(sql).toContain("create unique index export_attempts_idempotency_key_uidx");
    expect(sql).toContain("on public.export_attempts (idempotency_key)");
    expect(sql).toContain("idempotency_key text not null");
  });

  it("makes candidates, intents, links, and attempts append-only", () => {
    expect(sql).toContain("create trigger job_candidates_append_only");
    expect(sql).toContain("create trigger housecall_intents_append_only");
    expect(sql).toContain("create trigger housecall_links_append_only");
    expect(sql).toContain("create trigger export_attempts_append_only");
    expect(sql).toContain("before update or delete on public.export_attempts");
  });
});
