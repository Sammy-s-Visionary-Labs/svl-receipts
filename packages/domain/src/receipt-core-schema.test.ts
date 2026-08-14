import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXTRACTION_PROVIDERS, EXTRACTION_SCHEMA_VERSION } from "./extraction";
import { LEGACY_RECEIPT_STATUS_MAP } from "./legacy-status";
import { RECEIPT_STATUSES } from "./receipt-status";
import { REVIEW_DECISIONS } from "./review";

const MIGRATION = "20260814120000_receipt_core_schema.sql";

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

describe("RA-82 receipt core migration", () => {
  it("creates extractions, reviews, and receipt_lines with FKs back to receipts", () => {
    expect(sql).toContain("create table public.extractions");
    expect(sql).toContain("create table public.reviews");
    expect(sql).toContain("create table public.receipt_lines");
    const receiptFks = sql.match(/receipt_id uuid not null references public\.receipts \(id\)/g);
    expect(receiptFks?.length).toBe(3);
    expect(sql).toContain("canonical_receipt_id uuid references public.receipts (id)");
  });

  it("stores every canonical receipt status and no legacy aliases", () => {
    const statusCheck = namedCheck("receipts_status_check");
    for (const status of RECEIPT_STATUSES) {
      expect(statusCheck).toContain(`'${status}'`);
    }
    for (const legacy of Object.keys(LEGACY_RECEIPT_STATUS_MAP)) {
      expect(statusCheck).not.toContain(`'${legacy}'`);
    }
  });

  it("stores review decisions and extraction providers from the domain contracts", () => {
    const decisionCheck = namedCheck("reviews_decision_check");
    for (const decision of REVIEW_DECISIONS) {
      expect(decisionCheck).toContain(`'${decision}'`);
    }
    const providerCheck = namedCheck("extractions_provider_check");
    for (const provider of EXTRACTION_PROVIDERS) {
      expect(providerCheck).toContain(`'${provider}'`);
    }
  });

  it("keeps money in integer cents and qty as numeric", () => {
    expect(sql).toMatch(/receipt_total_cents integer/);
    expect(sql).toMatch(/tax_cents integer/);
    expect(sql).toMatch(/unit_cost_cents integer not null/);
    expect(sql).toMatch(/qty numeric not null/);
    expect(sql).not.toMatch(/numeric\s*\(\s*\d+\s*,\s*2\s*\)/);
  });

  it("records schema_version, timestamps, and optional GPS without requiring coordinates", () => {
    expect(sql).toMatch(/schema_version integer not null default 1/);
    expect(sql).toContain(`default ${EXTRACTION_SCHEMA_VERSION}`);
    expect(sql).toContain("updated_at timestamptz not null default now()");
    expect(sql).toContain("submitted_at timestamptz");
    expect(sql.match(/created_at timestamptz not null default now()/g)?.length).toBe(3);
    expect(sql).toMatch(/gps_lat double precision/);
    expect(sql).toMatch(/gps_lng double precision/);
    expect(namedCheck("receipts_gps_check")).toContain("gps_lat is null and gps_lng is null");
  });

  it("stores image keys and metadata only", () => {
    expect(sql).toContain("storage_key text");
    expect(sql).toContain("content_type text");
    expect(sql).toContain("checksum text");
    expect(sql).toContain("byte_size integer");
    expect(sql).not.toMatch(/\bbytea\b/i);
  });

  it("makes extractions and reviews append-only", () => {
    expect(sql).toContain("create trigger extractions_append_only");
    expect(sql).toContain("create trigger reviews_append_only");
    expect(sql).toContain("before update or delete on public.extractions");
    expect(sql).toContain("before update or delete on public.reviews");
  });
});
