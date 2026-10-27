import { createGeminiReceiptAdapter } from "@svl/integrations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireAdmin } from "@/lib/auth/guards";
import { readReceiptObject } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { normalizeExtractionPage } from "@/lib/work/extraction";
import { GET, POST } from "./route";

vi.mock("@/lib/auth/guards", async (original) => ({
  ...(await original<typeof import("@/lib/auth/guards")>()),
  requireAdmin: vi.fn(),
}));
vi.mock("@svl/integrations", async (original) => ({
  ...(await original<typeof import("@svl/integrations")>()),
  createGeminiReceiptAdapter: vi.fn(),
}));
vi.mock("@/lib/storage/receipts", () => ({ readReceiptObject: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/work/extraction", () => ({ normalizeExtractionPage: vi.fn() }));
const rpc = vi.fn(),
  parseReceipt = vi.fn();
const cutoff = "2026-01-01T00:00:00Z";
const request = () =>
  new Request("http://localhost/api/admin/receipt-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cutoff }),
  });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireAdmin).mockResolvedValue({
    actor: { userId: "admin", role: "admin", disabled: false },
  } as never);
  const chain = { select: vi.fn(), eq: vi.fn(), order: vi.fn() };
  chain.select.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  chain.order.mockResolvedValue({
    data: [{ page_index: 0, confirmed_at: "2026-01-01", storage_key: "private-fixture" }],
    error: null,
  });
  vi.mocked(createServiceRoleClient).mockReturnValue({ rpc, from: vi.fn(() => chain) } as never);
  rpc.mockImplementation(async (name) => ({
    data:
      name === "claim_receipt_type_classifications"
        ? []
        : name === "receipt_type_classification_status"
          ? { total: 1, completed: 1, remaining: 0 }
          : null,
    error: null,
  }));
  vi.mocked(readReceiptObject).mockResolvedValue({
    bytes: new Uint8Array([1]),
    contentType: "image/jpeg",
  } as never);
  vi.mocked(normalizeExtractionPage).mockResolvedValue(new Uint8Array([1]));
  vi.mocked(createGeminiReceiptAdapter).mockReturnValue({ parseReceipt });
  parseReceipt.mockResolvedValue({
    receipt: {
      receipt_type: "credit",
      evidence: [{ field: "receipt_type", text: "CREDIT NOTE", page_index: 0, confidence: 0.98 }],
    },
    model: "synthetic-model",
    promptVersion: "ra6-receipt-v1.6",
  });
});
describe("receipt type classification batches", () => {
  it("requires an administrator before reading data or calling AI", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      new AuthHttpError(403, "forbidden", "Admin required"),
    );
    expect((await POST(request())).status).toBe(403);
    expect(createServiceRoleClient).not.toHaveBeenCalled();
    expect(parseReceipt).not.toHaveBeenCalled();
  });
  it("reads status without creating work or sending receipts to AI", async () => {
    expect(
      (await GET(new Request(`http://localhost/api/admin/receipt-types?cutoff=${cutoff}`))).status,
    ).toBe(200);
    expect(rpc).toHaveBeenCalledWith("receipt_type_classification_status", { p_cutoff: cutoff });
    expect(parseReceipt).not.toHaveBeenCalled();
  });
  it("claims bounded work and persists only the type and its evidence", async () => {
    rpc.mockImplementation(async (name) => ({
      data:
        name === "claim_receipt_type_classifications"
          ? [{ receiptId: "receipt", leaseToken: "lease" }]
          : { remaining: 0 },
      error: null,
    }));
    expect((await POST(request())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("claim_receipt_type_classifications", {
      p_actor_id: "admin",
      p_cutoff: cutoff,
      p_limit: 3,
    });
    expect(rpc).toHaveBeenCalledWith(
      "finish_receipt_type_classification",
      expect.objectContaining({
        p_type: "credit",
        p_receipt_id: "receipt",
        p_lease_token: "lease",
        p_prompt_version: "ra6-receipt-v1.6",
      }),
    );
    expect(rpc.mock.calls.map(([name]) => name)).not.toContain("manager_review_with_export");
  });
  it("keeps uncertain evidence unknown instead of guessing debit", async () => {
    rpc.mockImplementation(async (name) => ({
      data:
        name === "claim_receipt_type_classifications"
          ? [{ receiptId: "receipt", leaseToken: "lease" }]
          : {},
      error: null,
    }));
    parseReceipt.mockResolvedValue({
      receipt: { receipt_type: "debit", evidence: [] },
      model: "synthetic-model",
      promptVersion: "ra6-receipt-v1.6",
    });
    expect((await POST(request())).status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "finish_receipt_type_classification",
      expect.objectContaining({ p_type: "unknown" }),
    );
  });
});
