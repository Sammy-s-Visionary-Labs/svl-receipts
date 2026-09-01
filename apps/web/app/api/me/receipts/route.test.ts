import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireActor } from "@/lib/auth/guards";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", () => ({
  requireActor: vi.fn(),
  authErrorResponse: vi.fn(() => Response.json({ error: "unexpected" }, { status: 500 })),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceRoleClient: vi.fn(),
}));

describe("GET /api/me/receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns at most 25 confirmed receipts newest-first with latest normalized evidence", async () => {
    const receipts = [
      {
        id: "receipt-new",
        status: "rejected_unreadable",
        submitted_at: "2026-09-01T12:00:00.000Z",
      },
      {
        id: "receipt-old",
        status: "processing",
        submitted_at: "2026-08-31T12:00:00.000Z",
      },
    ];
    const limit = vi.fn(async () => ({ data: receipts, error: null }));
    const receiptOrder = vi.fn(() => ({ limit }));
    const not = vi.fn(() => ({ order: receiptOrder }));
    const eq = vi.fn(() => ({ not }));
    const receiptSelect = vi.fn(() => ({ eq }));
    const receiptFrom = vi.fn(() => ({ select: receiptSelect }));
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: receiptFrom },
    } as never);

    const checks = [
      {
        receipt_id: "receipt-new",
        readable: false,
        failed_page_indexes: [1],
        reasons: ["blurry"],
        created_at: "2026-09-01T12:01:00.000Z",
      },
      {
        receipt_id: "receipt-new",
        readable: true,
        failed_page_indexes: [],
        reasons: [],
        created_at: "2026-09-01T12:00:30.000Z",
      },
    ];
    const checksOrder = vi.fn(async () => ({ data: checks, error: null }));
    const inReceipts = vi.fn(() => ({ order: checksOrder }));
    const checksSelect = vi.fn(() => ({ in: inReceipts }));
    const checksFrom = vi.fn(() => ({ select: checksSelect }));
    vi.mocked(createServiceRoleClient).mockReturnValue({ from: checksFrom } as never);

    const response = await GET(new Request("http://localhost/api/me/receipts"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(eq).toHaveBeenCalledWith("owner_user_id", "worker-1");
    expect(not).toHaveBeenCalledWith("submitted_at", "is", null);
    expect(receiptOrder).toHaveBeenCalledWith("submitted_at", { ascending: false });
    expect(limit).toHaveBeenCalledWith(25);
    expect(inReceipts).toHaveBeenCalledWith("receipt_id", ["receipt-new", "receipt-old"]);
    expect(await response.json()).toEqual({
      receipts: [
        {
          id: "receipt-new",
          status: "rejected_unreadable",
          submittedAt: "2026-09-01T12:00:00.000Z",
          readability: {
            readable: false,
            failedPageIndexes: [1],
            reasons: [
              {
                code: "blurry",
                guidance: "Hold the phone steady, tap to focus, and retake the blurry page.",
              },
            ],
            checkedAt: "2026-09-01T12:01:00.000Z",
          },
        },
        {
          id: "receipt-old",
          status: "processing",
          submittedAt: "2026-08-31T12:00:00.000Z",
          readability: null,
        },
      ],
    });
  });
});
