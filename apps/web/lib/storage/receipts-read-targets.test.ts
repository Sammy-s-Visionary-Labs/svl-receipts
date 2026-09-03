import { SIGNED_READ_TTL_SECONDS } from "@svl/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { createReceiptReadTargets } from "./receipts";

vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));

describe("receipt signed read targets", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("batches unique private paths and gives clients the same short expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00.000Z"));
    const createSignedUrls = vi.fn(async () => ({
      data: [
        {
          path: "owner/receipt/page-0.jpg",
          signedUrl: "https://storage.example/signed-0",
          signedURL: "/signed-0",
          error: null,
        },
        {
          path: "owner/receipt/page-1.jpg",
          signedUrl: null,
          signedURL: null,
          error: "not_found",
        },
      ],
      error: null,
    }));
    vi.mocked(createServiceRoleClient).mockReturnValue({
      storage: { from: vi.fn(() => ({ createSignedUrls })) },
    } as never);

    const result = await createReceiptReadTargets([
      "owner/receipt/page-0.jpg",
      "owner/receipt/page-1.jpg",
      "owner/receipt/page-0.jpg",
    ]);

    expect(createSignedUrls).toHaveBeenCalledWith(
      ["owner/receipt/page-0.jpg", "owner/receipt/page-1.jpg"],
      SIGNED_READ_TTL_SECONDS,
    );
    expect([...result.values()]).toEqual([
      {
        storageKey: "owner/receipt/page-0.jpg",
        url: "https://storage.example/signed-0",
        expiresAt: "2026-09-03T12:01:00.000Z",
      },
    ]);
  });

  it("does not contact Storage for an empty page set", async () => {
    expect(await createReceiptReadTargets([])).toEqual(new Map());
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });
});
