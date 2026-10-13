import { beforeEach, describe, expect, it, vi } from "vitest";
import { laborJobCatalogFingerprint, loadLaborJobCatalog } from "./job-catalog";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: createClient }));
const row = (id: string, unavailable = false) => ({
  id,
  label: `TEST ${id}`,
  customer: "TEST Customer",
  customer_id: "TEST-CUSTOMER",
  job_number: "TEST-1",
  service_address: "123 TEST Road",
  status: "completed",
  scheduled_at: "2025-01-01T12:00:00Z",
  active: false,
  unavailable,
  synced_at: "2026-10-13T10:00:00Z",
  provider_updated_at: null,
  source: "housecall",
});
const sync = {
  last_success_at: "2026-10-13T10:00:00Z",
  last_full_sync_at: "2026-10-10T10:00:00Z",
  customer_scope: null,
};
function configure(
  rows: unknown[],
  options: { scope?: unknown; failOffset?: number; changed?: boolean; missingFull?: boolean } = {},
) {
  let syncReads = 0;
  const ranges: [number, number][] = [];
  const db = {
    from(table: string) {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        order: vi.fn(() => query),
        maybeSingle: async () => ({
          data: {
            ...sync,
            customer_scope: options.scope ?? null,
            last_full_sync_at: options.missingFull ? null : sync.last_full_sync_at,
            last_success_at:
              options.changed && syncReads++ ? "2026-10-13T11:00:00Z" : sync.last_success_at,
          },
          error: null,
        }),
        range: async (from: number, to: number) => {
          if (table !== "manager_job_catalog") throw Error("Wrong catalog table");
          ranges.push([from, to]);
          return {
            data: options.failOffset === from ? null : rows.slice(from, to + 1),
            error: options.failOffset === from ? { message: "TEST failure" } : null,
          };
        },
      };
      return query;
    },
  };
  createClient.mockReturnValue(db);
  return ranges;
}
beforeEach(() => vi.clearAllMocks());
describe("complete server labor Housecall catalog", () => {
  it("reads every page including historical/unavailable jobs before claiming completeness", async () => {
    const rows = Array.from({ length: 997 }, (_, i) =>
      row(`TEST-${String(i).padStart(4, "0")}`, i === 996),
    );
    const ranges = configure(rows);
    const result = await loadLaborJobCatalog();
    expect(ranges).toEqual([
      [0, 499],
      [500, 999],
    ]);
    expect(result).toMatchObject({ complete: true, lastSuccessfulSyncAt: sync.last_success_at });
    expect(result.jobs).toHaveLength(997);
    expect(result.jobs.at(-1)).toMatchObject({
      unavailable: true,
      active: false,
      status: "completed",
    });
    expect(result.fingerprint).toBe(laborJobCatalogFingerprint(result.jobs));
    expect(laborJobCatalogFingerprint([...result.jobs].reverse())).toBe(result.fingerprint);
  });
  it("fails closed on a partial page failure while preserving display-only rows", async () => {
    configure(
      Array.from({ length: 600 }, (_, i) => row(`TEST-${i}`)),
      { failOffset: 500 },
    );
    const result = await loadLaborJobCatalog();
    expect(result).toMatchObject({ complete: false, fingerprint: null });
    expect(result.jobs).toHaveLength(500);
  });
  it.each([[["TEST-CUSTOMER"]], ["unexpected-scope"]])(
    "rejects restricted or malformed catalog scope %s",
    async (scope) => {
      configure([row("TEST-1")], { scope });
      expect(await loadLaborJobCatalog()).toMatchObject({
        complete: false,
        fingerprint: null,
        jobs: [],
      });
    },
  );
  it("rejects missing full sync and changes during pagination", async () => {
    configure([row("TEST-1")], { missingFull: true });
    expect((await loadLaborJobCatalog()).complete).toBe(false);
    configure([row("TEST-1")], { changed: true });
    expect((await loadLaborJobCatalog()).complete).toBe(false);
  });
  it("rejects duplicate IDs, malformed identities and empty catalog", async () => {
    for (const rows of [
      [row("TEST-1"), row("TEST-1")],
      [{ ...row("TEST-1"), source: "other" }],
      [],
    ]) {
      configure(rows);
      expect(await loadLaborJobCatalog()).toMatchObject({ complete: false, fingerprint: null });
    }
  });
});
