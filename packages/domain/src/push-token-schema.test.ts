import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION = "20260819180000_device_push_tokens.sql";

const sql = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/migrations", MIGRATION),
  "utf8",
);

describe("RA-20 device push token migration", () => {
  it("stores one token per user and keeps Data API mutations off authenticated", () => {
    expect(sql).toContain("create table public.device_push_tokens");
    expect(sql).toContain("user_id uuid primary key");
    expect(sql).toContain("alter table public.device_push_tokens enable row level security");
    expect(sql).toContain(
      "revoke all on table public.device_push_tokens from public, anon, authenticated",
    );
    expect(sql).toContain("grant all on table public.device_push_tokens to service_role");
  });

  it("is covered by applied permission checks", () => {
    const applied = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../supabase/tests/ra2_applied.sql"),
      "utf8",
    );
    expect(applied).toContain("public.device_push_tokens");
    expect(applied).toContain("upsert_device_push_token(uuid,text,text)");
  });

  it("exposes upsert only to service_role", () => {
    expect(sql).toContain("create or replace function public.upsert_device_push_token");
    expect(sql).toContain("perform public.require_active_actor(p_user_id, array['worker'])");
    expect(sql).toContain(
      "revoke all on function public.upsert_device_push_token(uuid, text, text)",
    );
    expect(sql).toContain(
      "grant execute on function public.upsert_device_push_token(uuid, text, text) to service_role",
    );
  });
});
