import sharp from "sharp";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  parseReceipt: vi.fn(),
  readObject: vi.fn(),
  intelligence: vi.fn(),
}));
vi.mock("@svl/integrations", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  createGeminiReceiptAdapter: () => ({ parseReceipt: mocks.parseReceipt }),
}));
vi.mock("@/lib/storage/receipts", () => ({ readReceiptObject: mocks.readObject }));
vi.mock("@/lib/manager/intelligence", () => ({ buildReceiptIntelligence: mocks.intelligence }));

import { normalizeExtractionPage, runExtraction } from "./extraction";

function database(
  pages: Record<string, unknown>[],
  existing: Record<string, unknown> | null = null,
) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
  return {
    rpc,
    from: vi.fn((table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: existing, error: null }),
        order: async () => ({ data: table === "receipt_pages" ? pages : [], error: null }),
      };
      return query;
    }),
  };
}
const row = { id: "work-1", receipt_id: "receipt-1", kind: "extract", generation: 2 };
const run = (db: ReturnType<typeof database>) =>
  runExtraction(db as unknown as Parameters<typeof runExtraction>[0], row, "worker-1");
beforeEach(() => {
  vi.clearAllMocks();
  mocks.intelligence.mockResolvedValue({ jobCandidates: [], duplicateCandidates: [] });
});
describe("extraction worker", () => {
  it("applies EXIF orientation and removes metadata before inference", async () => {
    const original = await sharp({
      create: { width: 12, height: 6, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const output = await normalizeExtractionPage(original);
    const meta = await sharp(output).metadata();
    expect([meta.width, meta.height, meta.orientation]).toEqual([6, 12, undefined]);
  });
  it("skips inference for an already persisted work generation", async () => {
    const db = database([], { id: "existing-extraction" });
    await run(db);
    expect(mocks.parseReceipt).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects incomplete or noncontiguous page sets before inference", async () => {
    for (const pages of [
      [],
      [{ page_index: 1, confirmed_at: "now" }],
      [{ page_index: 0, confirmed_at: null }],
    ]) {
      await expect(run(database(pages))).rejects.toMatchObject({
        kind: "permanent",
        code: "invalid_page_set",
      });
    }
    expect(mocks.parseReceipt).not.toHaveBeenCalled();
  });
  it("keeps page order and persists provider provenance with the same work generation", async () => {
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    mocks.readObject.mockResolvedValue({ bytes: image });
    mocks.parseReceipt.mockResolvedValue({
      receipt: { schema_version: 1 },
      model: "test-flash",
      promptVersion: "v1",
      usage: {},
    });
    const db = database(
      [0, 1].map((index) => ({
        page_index: index,
        confirmed_at: "now",
        storage_key: `p${index}`,
        content_type: "image/jpeg",
      })),
    );
    await run(db);
    expect(mocks.readObject.mock.calls.map(([key]) => key)).toEqual(["p0", "p1"]);
    expect(
      mocks.parseReceipt.mock.calls[0][0].map((page: { pageIndex: number }) => page.pageIndex),
    ).toEqual([0, 1]);
    expect(db.rpc).toHaveBeenCalledWith(
      "record_extraction_result",
      expect.objectContaining({ p_generation: 2, p_model: "test-flash", p_prompt_version: "v1" }),
    );
  });
  it("leaves no extraction completion after a provider timeout", async () => {
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    mocks.readObject.mockResolvedValue({ bytes: image });
    mocks.parseReceipt.mockRejectedValue(new Error("provider_timeout"));
    const db = database([
      { page_index: 0, confirmed_at: "now", storage_key: "p0", content_type: "image/jpeg" },
    ]);
    await expect(run(db)).rejects.toThrow("provider_timeout");
    expect(db.rpc.mock.calls.some(([name]) => name === "record_extraction_result")).toBe(false);
  });
});
