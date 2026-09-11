import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireReceiptAccess } from "@/lib/auth/guards";
import { createReceiptReadUrl } from "@/lib/storage/receipts";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireReceiptAccess: vi.fn(),
}));
vi.mock("@/lib/storage/receipts", () => ({ createReceiptReadUrl: vi.fn() }));
const id = "79100000-0000-4000-8000-000000000099";
let records: Record<string, unknown>;
const eq = vi.fn();
const from = vi.fn();
const run = (query = "") =>
  GET(new Request(`http://localhost/api/receipts/${id}/image${query}`), {
    params: Promise.resolve({ id }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  records = {
    receipts: {
      storage_key: "owner/first.jpg",
      status: "needs_review",
      content_deleted_at: null,
      purge_claimed_at: null,
    },
    receipt_pages: { storage_key: "owner/second.jpg", confirmed_at: "2026-09-10" },
  };
  from.mockImplementation((table: string) => {
    const chain = {
      select: vi.fn(),
      eq,
      maybeSingle: vi.fn(async () => ({ data: records[table], error: null })),
    };
    chain.select.mockReturnValue(chain);
    eq.mockReturnValue(chain);
    return chain;
  });
  vi.mocked(requireReceiptAccess).mockResolvedValue({
    actor: { userId: "worker" },
    supabase: { from },
  } as never);
  vi.mocked(createReceiptReadUrl).mockResolvedValue("https://example.invalid/private-page");
});
describe("private receipt page access", () => {
  it("preserves first-page access for existing receipts", async () => {
    expect((await run()).status).toBe(200);
    expect(createReceiptReadUrl).toHaveBeenCalledWith("owner/first.jpg");
  });
  it("signs page two only after checking receipt access and its exact receipt/page identity", async () => {
    expect((await run("?page=1")).status).toBe(200);
    expect(eq).toHaveBeenCalledWith("receipt_id", id);
    expect(eq).toHaveBeenCalledWith("page_index", 1);
    expect(createReceiptReadUrl).toHaveBeenCalledWith("owner/second.jpg");
  });
  it.each(["?page=-1", "?page=5", "?page=1.5", "?page=1&page=2"])(
    "rejects invalid page selection %s",
    async (query) => {
      expect((await run(query)).status).toBe(400);
      expect(createReceiptReadUrl).not.toHaveBeenCalled();
    },
  );
  it.each([null, { storage_key: "owner/second.jpg", confirmed_at: null }])(
    "never signs a missing/unconfirmed page",
    async (record) => {
      records.receipt_pages = record;
      expect((await run("?page=1")).status).toBe(404);
      expect(createReceiptReadUrl).not.toHaveBeenCalled();
    },
  );
  it("denies another worker before reading a page", async () => {
    vi.mocked(requireReceiptAccess).mockRejectedValue(
      new AuthHttpError(403, "forbidden", "Denied"),
    );
    expect((await run("?page=1")).status).toBe(403);
    expect(from).not.toHaveBeenCalled();
    expect(createReceiptReadUrl).not.toHaveBeenCalled();
  });
});
