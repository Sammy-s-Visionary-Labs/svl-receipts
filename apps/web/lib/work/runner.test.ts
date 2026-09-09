import { createGeminiReadabilityAdapter } from "@svl/integrations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { ExtractionDeferredError, runExtraction } from "./extraction";
import { runReceiptWork, runWorkBatch } from "./runner";

vi.mock("./extraction", async (original) => ({
  ...(await original<typeof import("./extraction")>()),
  runExtraction: vi.fn(),
}));
vi.mock("@svl/integrations", async (original) => ({
  ...(await original<typeof import("@svl/integrations")>()),
  createGeminiReadabilityAdapter: vi.fn(),
}));
vi.mock("@/lib/storage/receipts", async (original) => ({
  ...(await original<typeof import("@/lib/storage/receipts")>()),
  readReceiptObject: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: vi.fn(),
}));

describe("work runner batch bounds", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps provider batches at four and starts the claimed rows concurrently", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => ({
      id: `work-${index}`,
      receipt_id: `receipt-${index}`,
      kind: "readability",
    }));
    let activeStarts = 0;
    let maxActiveStarts = 0;
    const rpc = vi.fn(async (name: string) => {
      if (name === "claim_work") {
        return { data: rows, error: null };
      }
      if (name === "start_queued_work") {
        activeStarts += 1;
        maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        activeStarts -= 1;
        return { data: null, error: new Error("synthetic start failure") };
      }
      if (name === "fail_work") {
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc: ${name}`);
    });
    vi.mocked(createServiceRoleClient).mockReturnValue({ rpc } as never);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runWorkBatch({ limit: 20, kinds: ["readability"] })).resolves.toEqual({
      claimed: 4,
      completed: 0,
      failed: 4,
    });

    expect(rpc).toHaveBeenCalledWith(
      "claim_work",
      expect.objectContaining({ p_limit: 4, p_kinds: ["readability"] }),
    );
    expect(maxActiveStarts).toBe(4);
  });
});

describe("receipt-scoped continuation", () => {
  afterEach(() => vi.restoreAllMocks());

  function client(options: { accepted?: boolean; existingCheck?: boolean } = {}) {
    const read = { id: "own-read", receipt_id: "own", kind: "readability" };
    const extract = { id: "own-extract", receipt_id: "own", kind: "extract" };
    const rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
      if (name === "claim_receipt_work") {
        if (args?.p_receipt_id !== "own") throw new Error("unrelated receipt claimed");
        return {
          data:
            args.p_kind === "readability" ? [read] : options.accepted === false ? [] : [extract],
          error: null,
        };
      }
      return { data: null, error: null };
    });
    const from = vi.fn((table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({
          data: options.existingCheck === false ? null : { id: "saved-check" },
          error: null,
        }),
        order: async () => ({
          data: [
            {
              page_index: 0,
              storage_key: "own/page-0.jpg",
              content_type: "image/jpeg",
              confirmed_at: "2026-09-08",
            },
          ],
          error: null,
        }),
      };
      if (!["readability_checks", "receipt_pages"].includes(table))
        throw new Error(`unexpected table:${table}`);
      return query;
    });
    vi.mocked(createServiceRoleClient).mockReturnValue({ rpc, from } as never);
    vi.mocked(runExtraction).mockResolvedValue(undefined);
    return { rpc, read, extract };
  }

  it("claims only its receipt and immediately continues accepted readability", async () => {
    const { rpc } = client();
    await expect(runReceiptWork("own", "readability")).resolves.toEqual({
      claimed: 2,
      completed: 2,
      failed: 0,
    });
    expect(rpc).not.toHaveBeenCalledWith("claim_work", expect.anything());
    expect(
      rpc.mock.calls
        .filter(([name]) => name === "claim_receipt_work")
        .map(([, args]) => args?.p_kind),
    ).toEqual(["readability", "extract"]);
    expect(runExtraction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ receipt_id: "own" }),
      expect.any(String),
      expect.any(Number),
    );
  });

  it("leaves unreadable receipts without an extraction claim", async () => {
    client({ accepted: false });
    await expect(runReceiptWork("own", "readability")).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    expect(runExtraction).not.toHaveBeenCalled();
  });

  it("does not claim or delay due work once the shared budget is exhausted", async () => {
    const { rpc } = client();
    await expect(
      runReceiptWork("own", "readability", { deadlineAt: Date.now() + 1_000 }),
    ).resolves.toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("releases an owned stage without provider backoff when its remaining budget runs out", async () => {
    const { rpc } = client();
    vi.mocked(runExtraction).mockRejectedValueOnce(new ExtractionDeferredError());
    await expect(runReceiptWork("own", "extract")).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    expect(rpc).toHaveBeenCalledWith(
      "release_receipt_work",
      expect.objectContaining({ p_work_id: "own-extract" }),
    );
    expect(rpc.mock.calls.some(([name]) => name === "fail_work" || name === "defer_work")).toBe(
      false,
    );
  });

  it("caps readability inference by the same request budget", async () => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    client({ existingCheck: false, accepted: false });
    vi.mocked(readReceiptObject).mockResolvedValue({
      bytes: new Uint8Array([1]),
      contentType: "image/jpeg",
    } as never);
    vi.mocked(createGeminiReadabilityAdapter).mockReturnValue({
      checkReadable: vi.fn().mockResolvedValue({
        check: { schema_version: 1, readable: true },
        provider: "google_gemini",
        model: "test",
        usage: {},
      }),
    } as never);
    await runReceiptWork("own", "readability", { deadlineAt: now + 30_000 });
    expect(createGeminiReadabilityAdapter).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 15_000 }),
    );
  });

  it("starts each accepted continuation before unrelated slow initial work finishes", async () => {
    const { rpc, read, extract } = client();
    const slow = { id: "slow-extract", receipt_id: "slow", kind: "extract" };
    let finishSlow!: () => void;
    const waiting = new Promise<void>((resolve) => {
      finishSlow = resolve;
    });
    vi.mocked(runExtraction).mockImplementation(async (_db, row) => {
      if (row.id === slow.id) await waiting;
    });
    rpc.mockImplementation(async (name, args) => {
      if (name === "claim_work") return { data: [slow, read], error: null };
      if (name === "claim_receipt_work") {
        expect(args?.p_receipt_id).toBe("own");
        return { data: [extract], error: null };
      }
      return { data: null, error: null };
    });
    const batch = runWorkBatch({ kinds: ["readability", "extract"] });
    await vi.waitFor(() =>
      expect(runExtraction).toHaveBeenCalledWith(
        expect.anything(),
        extract,
        expect.any(String),
        expect.any(Number),
      ),
    );
    finishSlow();
    await expect(batch).resolves.toEqual({ claimed: 3, completed: 3, failed: 0 });
  });

  it("keeps successful readability complete when its extraction fails", async () => {
    const { rpc } = client();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(runExtraction).mockRejectedValueOnce(new Error("provider_unavailable"));
    await expect(runReceiptWork("own", "readability")).resolves.toEqual({
      claimed: 2,
      completed: 1,
      failed: 1,
    });
    expect(rpc).toHaveBeenCalledWith(
      "complete_work",
      expect.objectContaining({ p_work_id: "own-read" }),
    );
    expect(
      rpc.mock.calls.filter(([name]) => name === "fail_work").map(([, args]) => args?.p_work_id),
    ).toEqual(["own-extract"]);
  });
});
