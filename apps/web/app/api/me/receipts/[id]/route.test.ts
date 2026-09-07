import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireActor } from "@/lib/auth/guards";
import { createReceiptReadTargets } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", () => ({
  requireActor: vi.fn(),
  authErrorResponse: vi.fn(() => Response.json({ error: "unexpected" }, { status: 500 })),
}));
vi.mock("@/lib/storage/receipts", () => ({ createReceiptReadTargets: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));

const id = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1";

describe("GET /api/me/receipts/[id]", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns only the owner's ordered page set and worker-facing detail", async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        id,
        status: "rejected_unreadable",
        submitted_at: "2026-09-03T12:00:00.000Z",
        clarification_reason: "Confirm the quantity",
      },
      error: null,
    }));
    const not = vi.fn(() => ({ maybeSingle }));
    const ownerEq = vi.fn(() => ({ not }));
    const idEq = vi.fn(() => ({ eq: ownerEq }));
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: idEq })) })) },
    } as never);

    const pages = [
      { page_index: 0, storage_key: "worker/receipt/page-0.jpg" },
      { page_index: 1, storage_key: "worker/receipt/page-1.jpg" },
    ];
    const pageOrder = vi.fn(async () => ({ data: pages, error: null }));
    const pageNot = vi.fn(() => ({ order: pageOrder }));
    const pageEq = vi.fn(() => ({ not: pageNot }));
    const checkMaybeSingle = vi.fn(async () => ({
      data: {
        receipt_id: id,
        readable: false,
        failed_page_indexes: [1],
        reasons: ["cropped"],
        created_at: "2026-09-03T12:01:00.000Z",
      },
      error: null,
    }));
    const checkLimit = vi.fn(() => ({ maybeSingle: checkMaybeSingle }));
    const checkOrder = vi.fn(() => ({ limit: checkLimit }));
    const checkEq = vi.fn(() => ({ order: checkOrder }));
    vi.mocked(createServiceRoleClient).mockReturnValue({
      from: vi.fn((table: string) => ({
        select: vi.fn(() => (table === "receipt_pages" ? { eq: pageEq } : { eq: checkEq })),
      })),
    } as never);
    vi.mocked(createReceiptReadTargets).mockResolvedValue(
      new Map(
        pages.map((page) => [
          page.storage_key,
          {
            storageKey: page.storage_key,
            url: `https://storage.example/${page.page_index}`,
            expiresAt: "2026-09-03T12:02:00.000Z",
          },
        ]),
      ),
    );

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(idEq).toHaveBeenCalledWith("id", id);
    expect(ownerEq).toHaveBeenCalledWith("owner_user_id", "worker-1");
    expect(pageOrder).toHaveBeenCalledWith("page_index", { ascending: true });
    expect(body).toEqual({
      id,
      workerStatus: "needs_retake",
      clarification: "Confirm the quantity",
      submittedAt: "2026-09-03T12:00:00.000Z",
      pages: [
        {
          pageIndex: 0,
          image: {
            url: "https://storage.example/0",
            expiresAt: "2026-09-03T12:02:00.000Z",
          },
        },
        {
          pageIndex: 1,
          image: {
            url: "https://storage.example/1",
            expiresAt: "2026-09-03T12:02:00.000Z",
          },
        },
      ],
      readability: {
        readable: false,
        failedPageIndexes: [1],
        reasons: [
          {
            code: "cropped",
            guidance: "Retake with every receipt edge and corner visible.",
          },
        ],
        checkedAt: "2026-09-03T12:01:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/ownerUserId|retention|storage_key|cost|job/i);
  });

  it("does not disclose whether another worker's receipt exists", async () => {
    const maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const not = vi.fn(() => ({ maybeSingle }));
    const ownerEq = vi.fn(() => ({ not }));
    const idEq = vi.fn(() => ({ eq: ownerEq }));
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: idEq })) })) },
    } as never);

    const response = await GET(new Request("http://localhost"), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(404);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: { code: "not_found", message: "Receipt is not available" },
    });
  });
});
