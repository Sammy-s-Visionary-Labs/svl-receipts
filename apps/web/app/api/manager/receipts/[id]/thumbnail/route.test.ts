import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { createReceiptReadUrl } from "@/lib/storage/receipts";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));
vi.mock("@/lib/storage/receipts", () => ({ createReceiptReadUrl: vi.fn() }));

const id = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c2";
const request = new Request(`http://localhost/api/manager/receipts/${id}/thumbnail`);
const context = { params: Promise.resolve({ id }) };

function authorize(
  receipt: unknown = { id },
  page: unknown = { storage_key: "private/page0.jpg", byte_size: 1000 },
) {
  const query = (data: unknown) => {
    const chain = {
      select: vi.fn(),
      eq: vi.fn(),
      not: vi.fn(),
      is: vi.fn(),
      neq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    for (const method of [chain.select, chain.eq, chain.not, chain.is, chain.neq])
      method.mockReturnValue(chain);
    return chain;
  };
  const receipts = query(receipt);
  const pages = query(page);
  const from = vi.fn((table: string) => (table === "receipts" ? receipts : pages));
  vi.mocked(requireManager).mockResolvedValue({
    actor: { userId: "manager", role: "manager", disabled: false },
    supabase: { from },
  } as never);
  return { from, receipts, pages };
}

describe("protected manager thumbnails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createReceiptReadUrl).mockResolvedValue("https://storage.example/private-token");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns only a small JPEG after receipt and confirmed first-page checks", async () => {
    const { receipts, pages } = authorize();
    const original = await sharp({
      create: { width: 1000, height: 1500, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(original)));
    const response = await GET(request, context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(receipts.is).toHaveBeenCalledWith("content_deleted_at", null);
    expect(receipts.not).toHaveBeenCalledWith("submitted_at", "is", null);
    expect(pages.eq).toHaveBeenCalledWith("page_index", 0);
    expect(pages.not).toHaveBeenCalledWith("confirmed_at", "is", null);
    const metadata = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    expect(metadata.width).toBeLessThanOrEqual(128);
    expect(metadata.height).toBeLessThanOrEqual(160);
  });

  it.each([401, 403])(
    "preserves authorization denial (%s) and never signs an image",
    async (status) => {
      vi.mocked(requireManager).mockRejectedValue(
        new AuthHttpError(status, "forbidden", "Access denied"),
      );
      const response = await GET(request, context);
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(createReceiptReadUrl).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("hides missing/unconfirmed/purged receipts before page or Storage access", async () => {
    const { from } = authorize(null);
    expect((await GET(request, context)).status).toBe(404);
    expect(from).toHaveBeenCalledTimes(1);
    expect(createReceiptReadUrl).not.toHaveBeenCalled();
  });

  it("does not sign malformed IDs or missing/oversized first pages", async () => {
    const { from } = authorize();
    expect((await GET(request, { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(
      404,
    );
    expect(from).not.toHaveBeenCalled();
    authorize({ id }, null);
    expect((await GET(request, context)).status).toBe(404);
    authorize({ id }, { storage_key: "secret", byte_size: 20 * 1024 * 1024 });
    expect((await GET(request, context)).status).toBe(404);
    expect(createReceiptReadUrl).not.toHaveBeenCalled();
  });

  it("bounds streamed image bytes even when content-length is missing", async () => {
    authorize();
    vi.mocked(fetch).mockResolvedValue(new Response(new Uint8Array(10 * 1024 * 1024 + 1)));
    const response = await GET(request, context);
    expect(response.status).toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("private-token");
  });

  it("handles corrupt or expired images without exposing Storage details", async () => {
    authorize();
    vi.mocked(fetch).mockResolvedValue(new Response("upstream secret", { status: 403 }));
    expect((await GET(request, context)).status).toBe(404);
    vi.mocked(fetch).mockResolvedValue(new Response("not an image"));
    expect((await GET(request, context)).status).toBe(404);
  });
});
