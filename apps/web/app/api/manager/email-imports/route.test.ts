import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));

type ImportRow = {
  id: string;
  status: string;
  created_at: string;
  last_error: string | null;
  email_receipt_documents: { receipt_id: string; filename: string }[];
};
let rows: ImportRow[];
let filteredRows: ImportRow[];
let importError: { message: string } | null;
const health = vi.fn();
const query = {
  select: vi.fn(() => query),
  in: vi.fn((column: string, values: readonly string[]) => {
    if (column === "status")
      filteredRows = filteredRows.filter((row) => values.includes(row.status));
    return query;
  }),
  order: vi.fn((_column: string, options: { ascending: boolean }) => {
    filteredRows.sort((a, b) =>
      options.ascending
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at),
    );
    return query;
  }),
  limit: vi.fn(async (count: number) => ({
    data: filteredRows.slice(0, count),
    error: importError,
  })),
};
const from = vi.fn((table: string) => {
  if (table === "email_importer_health")
    return { select: () => ({ eq: () => ({ maybeSingle: health }) }) };
  if (table === "email_receipt_imports") {
    filteredRows = [...rows];
    return query;
  }
  throw new Error(`Unexpected table ${table}`);
});
const request = () => new Request("https://test.invalid/api/manager/email-imports");

function row(id: string, status: string, createdAt: string): ImportRow {
  return { id, status, created_at: createdAt, last_error: null, email_receipt_documents: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  filteredRows = [];
  importError = null;
  vi.stubEnv("EMAIL_IMPORT_SECRET", "fixture-only-secret");
  vi.stubEnv("EMAIL_IMPORT_OWNER_ID", "fixture-only-owner");
  health.mockResolvedValue({ data: { last_contact_at: "2026-10-29T12:00:00Z" }, error: null });
  vi.mocked(requireManager).mockResolvedValue({
    actor: { userId: "manager-test", role: "manager", disabled: false },
    supabase: { from },
  } as never);
});
afterEach(() => vi.unstubAllEnvs());

describe("pending and failed email import status API", () => {
  it.each([
    [401, "unauthenticated"],
    [403, "forbidden"],
  ])("denies %s/%s before reading email data", async (status, code) => {
    vi.mocked(requireManager).mockRejectedValue(
      new AuthHttpError(Number(status), String(code), "Access denied"),
    );
    expect((await GET(request())).status).toBe(status);
    expect(from).not.toHaveBeenCalled();
  });

  it("returns older unresolved imports even after more than fifty newer successful imports", async () => {
    const unresolved = [
      { ...row("failed", "needs_attention", "2026-09-04T12:00:00Z"), last_error: "pdf_page_limit" },
      row("preparing", "processing", "2026-09-03T12:00:00Z"),
      row("queued", "queued", "2026-09-02T12:00:00Z"),
      row("upload", "awaiting_upload", "2026-09-01T12:00:00Z"),
    ];
    rows = [
      ...Array.from({ length: 55 }, (_, i) =>
        row(`successful-${i}`, "imported", "2026-10-29T12:00:00Z"),
      ),
      ...unresolved,
    ];
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      mailbox: "recisvl@gmail.com",
      configured: true,
      lastContactAt: "2026-10-29T12:00:00Z",
      imports: unresolved,
    });
    expect(query.in).toHaveBeenCalledWith("status", [
      "awaiting_upload",
      "queued",
      "processing",
      "needs_attention",
    ]);
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(rows).toHaveLength(59);
    expect(rows.filter((item) => item.status === "imported")).toHaveLength(55);
  });

  it("limits the unresolved list itself to its newest fifty imports", async () => {
    rows = Array.from({ length: 55 }, (_, index) =>
      row(`pending-${index}`, "queued", new Date(Date.UTC(2026, 9, index + 1)).toISOString()),
    );
    const body = await (await GET(request())).json();
    expect(body.imports).toHaveLength(50);
    expect(body.imports[0].id).toBe("pending-54");
    expect(body.imports[49].id).toBe("pending-5");
  });

  it("keeps connection health available when all emails have imported successfully", async () => {
    rows = [row("successful", "imported", "2026-10-29T12:00:00Z")];
    const body = await (await GET(request())).json();
    expect(body.imports).toEqual([]);
    expect(body.lastContactAt).toBe("2026-10-29T12:00:00Z");
    expect(body.configured).toBe(true);
  });

  it("reports unconfigured intake and no connection without hiding an empty list", async () => {
    vi.stubEnv("EMAIL_IMPORT_SECRET", "");
    health.mockResolvedValue({ data: null, error: null });
    expect(await (await GET(request())).json()).toMatchObject({
      configured: false,
      lastContactAt: null,
      imports: [],
    });
  });

  it("fails visibly instead of reporting healthy empty imports when the import query fails", async () => {
    importError = { message: "private query detail" };
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await GET(request());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("private query detail");
    } finally {
      log.mockRestore();
    }
  });
});
