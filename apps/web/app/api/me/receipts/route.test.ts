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

const newId = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c2";
const oldId = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1";

describe("GET /api/me/receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createReceiptReadTargets).mockResolvedValue(new Map());
  });

  it("returns an owner-scoped, newest-first page with thumbnails and normalized statuses", async () => {
    const receipts = [
      {
        id: newId,
        status: "rejected_unreadable",
        submitted_at: "2026-09-01T12:00:00.000Z",
      },
      {
        id: oldId,
        status: "processing",
        submitted_at: "2026-08-31T12:00:00.000Z",
      },
    ];
    const receiptQuery = receiptQueryMock(receipts);
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: vi.fn(() => ({ select: vi.fn(() => receiptQuery.root) })) },
    } as never);

    const checks = [
      {
        receipt_id: newId,
        readable: false,
        failed_page_indexes: [1],
        reasons: ["blurry"],
        created_at: "2026-09-01T12:01:00.000Z",
      },
      {
        receipt_id: newId,
        readable: true,
        failed_page_indexes: [],
        reasons: [],
        created_at: "2026-09-01T12:00:30.000Z",
      },
    ];
    const pages = [
      { receipt_id: newId, page_index: 0, storage_key: "worker/new/page-0.jpg" },
      { receipt_id: newId, page_index: 1, storage_key: "worker/new/page-1.jpg" },
      { receipt_id: oldId, page_index: 0, storage_key: "worker/old/page-0.jpg" },
    ];
    vi.mocked(createServiceRoleClient).mockReturnValue(serviceClientMock(checks, pages) as never);
    vi.mocked(createReceiptReadTargets).mockResolvedValue(
      new Map([
        [
          "worker/new/page-0.jpg",
          {
            storageKey: "worker/new/page-0.jpg",
            url: "https://storage.example/new-token",
            expiresAt: "2026-09-01T12:02:00.000Z",
          },
        ],
      ]),
    );

    const response = await GET(new Request("http://localhost/api/me/receipts"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(receiptQuery.eq).toHaveBeenCalledWith("owner_user_id", "worker-1");
    expect(receiptQuery.not).toHaveBeenCalledWith("submitted_at", "is", null);
    expect(receiptQuery.firstOrder).toHaveBeenCalledWith("submitted_at", { ascending: false });
    expect(receiptQuery.secondOrder).toHaveBeenCalledWith("id", { ascending: false });
    expect(receiptQuery.limit).toHaveBeenCalledWith(26);
    expect(createReceiptReadTargets).toHaveBeenCalledWith([
      "worker/new/page-0.jpg",
      "worker/old/page-0.jpg",
    ]);
    expect(await response.json()).toEqual({
      receipts: [
        {
          id: newId,
          status: "rejected_unreadable",
          workerStatus: "needs_retake",
          submittedAt: "2026-09-01T12:00:00.000Z",
          pageCount: 2,
          thumbnail: {
            url: "https://storage.example/new-token",
            expiresAt: "2026-09-01T12:02:00.000Z",
          },
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
          id: oldId,
          status: "processing",
          workerStatus: "sent",
          submittedAt: "2026-08-31T12:00:00.000Z",
          pageCount: 1,
          thumbnail: null,
          readability: null,
        },
      ],
      nextCursor: null,
    });
  });

  it("returns an opaque next cursor and applies it on the following page", async () => {
    const receipts = Array.from({ length: 26 }, (_, index) => ({
      id: `8bb96a3a-7a5c-4ec8-b4cf-${(100000000000 + index).toString()}`,
      status: "processing",
      submitted_at: new Date(Date.UTC(2026, 8, 2, 0, 0, 26 - index)).toISOString(),
    }));
    const firstQuery = receiptQueryMock(receipts);
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: vi.fn(() => ({ select: vi.fn(() => firstQuery.root) })) },
    } as never);
    vi.mocked(createServiceRoleClient).mockReturnValue(serviceClientMock([], []) as never);

    const firstResponse = await GET(new Request("http://localhost/api/me/receipts"));
    const firstBody = (await firstResponse.json()) as { nextCursor: string; receipts: unknown[] };
    expect(firstBody.receipts).toHaveLength(25);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const nextQuery = receiptQueryMock([]);
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from: vi.fn(() => ({ select: vi.fn(() => nextQuery.root) })) },
    } as never);
    const nextResponse = await GET(
      new Request(`http://localhost/api/me/receipts?cursor=${firstBody.nextCursor}`),
    );
    expect(nextResponse.status).toBe(200);
    expect(nextQuery.or).toHaveBeenCalledWith(expect.stringContaining("submitted_at.lt."));
    expect(nextQuery.or).toHaveBeenCalledWith(expect.stringContaining("id.lt."));
  });

  it("rejects a malformed cursor without querying receipt history", async () => {
    const from = vi.fn();
    vi.mocked(requireActor).mockResolvedValue({
      actor: { userId: "worker-1", role: "worker", disabled: false },
      supabase: { from },
    } as never);

    const response = await GET(
      new Request("http://localhost/api/me/receipts?cursor=not-a-valid-cursor"),
    );

    expect(response.status).toBe(400);
    expect(from).not.toHaveBeenCalled();
    expect(await response.json()).toEqual({
      error: { code: "invalid_request", message: "Receipt history cursor is invalid" },
    });
  });
});

function receiptQueryMock(receipts: unknown[]) {
  const limit = vi.fn(async () => ({ data: receipts, error: null }));
  const secondOrder = vi.fn(() => ({ limit }));
  const firstOrder = vi.fn(() => ({ order: secondOrder }));
  const root: Record<string, unknown> = {};
  const or = vi.fn(() => root);
  const not = vi.fn(() => root);
  const eq = vi.fn(() => ({ not }));
  Object.assign(root, { eq, or, order: firstOrder });
  return { root, eq, not, or, firstOrder, secondOrder, limit };
}

function serviceClientMock(checks: unknown[], pages: unknown[]) {
  const checksOrder = vi.fn(async () => ({ data: checks, error: null }));
  const checksIn = vi.fn(() => ({ order: checksOrder }));
  const pagesOrder = vi.fn(async () => ({ data: pages, error: null }));
  const pagesNot = vi.fn(() => ({ order: pagesOrder }));
  const pagesIn = vi.fn(() => ({ not: pagesNot }));
  return {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => (table === "readability_checks" ? { in: checksIn } : { in: pagesIn })),
    })),
  };
}
