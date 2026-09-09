import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthHttpError, requireManager } from "@/lib/auth/guards";
import { DEFAULT_QUEUE_FILTERS } from "@/lib/manager/queue-contract";
import { GET } from "./route";

vi.mock("@/lib/auth/guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/guards")>()),
  requireManager: vi.fn(),
}));

const id = "11111111-1111-4111-8111-111111111111";
const owner = "22222222-2222-4222-8222-222222222222";
const row = {
  id,
  status: "needs_review",
  submittedAt: "2026-09-01T12:00:00.123456Z",
  submitterId: owner,
  vendor: "Supply shop",
  reference: "INV-1",
  referenceTotalCents: 4250,
  pageCount: 2,
  hasThumbnail: true,
  suggestedJob: { id: "job-1", label: "Kitchen", source: "stored" },
  confidence: 0.7,
  duplicate: "unmarked",
  warnings: ["Low extraction confidence"],
  housecallStatus: "not_started",
  extractionId: "extraction-1",
  latestReviewDecision: "save_draft",
};
const request = (query = "") => new Request(`http://localhost/api/manager/queue${query}`);
const rpc = vi.fn();

describe("manager review queue API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireManager).mockResolvedValue({
      actor: { userId: owner, role: "manager", disabled: false },
      supabase: { rpc },
    } as never);
    rpc.mockResolvedValue({ data: [row], error: null });
  });

  it.each([
    [401, "unauthenticated"],
    [401, "account_inactive"],
    [403, "forbidden"],
  ])("denies %i/%s before data access", async (status, code) => {
    vi.mocked(requireManager).mockRejectedValue(
      new AuthHttpError(status as number, code as string, "Access denied"),
    );
    const response = await GET(request());
    expect(response.status).toBe(status);
    expect(rpc).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("uses authenticated RPC, oldest needs review defaults, and an allowlist response", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          ...row,
          storage_key: "secret-path",
          raw_text: "private raw data",
          manager_notes: "private notes",
        },
      ],
      error: null,
    });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(rpc).toHaveBeenCalledWith(
      "manager_review_queue",
      expect.objectContaining({
        p_tab: "needs-review",
        p_sort: "oldest",
        p_limit: 26,
        p_cursor_at: null,
        p_submitter: null,
      }),
    );
    const body = await response.json();
    expect(body.filters).toEqual(DEFAULT_QUEUE_FILTERS);
    expect(body.nextCursor).toBeNull();
    expect(body.receipts[0]).toMatchObject({
      id,
      submitter: { id: owner, label: "Worker 22222222" },
      thumbnailUrl: `/api/manager/receipts/${id}/thumbnail`,
      confidence: 0.7,
    });
    expect(JSON.stringify(body)).not.toMatch(
      /secret-path|private raw data|private notes|storage_key|hasThumbnail/,
    );
  });

  it("returns bounded pages and preserves microsecond timestamp/UUID cursor ties", async () => {
    rpc.mockResolvedValue({
      data: [row, { ...row, id: "11111111-1111-4111-8111-111111111112" }],
      error: null,
    });
    const response = await GET(request("?limit=1"));
    const body = await response.json();
    expect(body.receipts).toHaveLength(1);
    expect(body.nextCursor).toEqual(expect.any(String));
    rpc.mockResolvedValue({ data: [], error: null });
    expect((await GET(request(`?limit=1&cursor=${body.nextCursor}`))).status).toBe(200);
    expect(rpc).toHaveBeenLastCalledWith(
      "manager_review_queue",
      expect.objectContaining({
        p_cursor_at: row.submittedAt,
        p_cursor_id: id,
        p_as_of: body.asOf,
        p_limit: 2,
      }),
    );
    expect((await GET(request(`?limit=1&sort=newest&cursor=${body.nextCursor}`))).status).toBe(400);
  });

  it("sends every validated filter to SQL as a bound parameter", async () => {
    const response = await GET(
      request(
        `?tab=processing&sort=newest&status=exporting&age=over-7d&submitter=${owner}&vendor=100%25&confidence=low&duplicate=unmarked&housecall=failed&search=ACME_&from=2026-08-01&to=2026-09-01&limit=50`,
      ),
    );
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith(
      "manager_review_queue",
      expect.objectContaining({
        p_tab: "processing",
        p_sort: "newest",
        p_status: "exporting",
        p_age: "over-7d",
        p_submitter: owner,
        p_vendor: "100%",
        p_confidence: "low",
        p_duplicate: "unmarked",
        p_housecall: "failed",
        p_search: "ACME_",
        p_from: "2026-08-01",
        p_to: "2026-09-01",
        p_limit: 51,
      }),
    );
  });

  it.each([
    "?tab=all",
    "?status=upload_pending",
    "?limit=0",
    "?limit=51",
    "?limit=1.5",
    "?limit=1e1",
    "?submitter=anyone",
    "?from=2026-02-30",
    "?from=2026-09-01&to=2026-08-01",
    "?housecall=sent",
    "?confidence=maybe",
    "?cursor=broken",
    "?cursor=",
    "?limit=1&limit=2",
    "?unexpected=value",
    `?search=${"a".repeat(121)}`,
  ])("rejects invalid inputs %s without querying", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("leaves unavailable extracted data and suggestions empty", async () => {
    rpc.mockResolvedValue({
      data: [
        {
          ...row,
          vendor: null,
          reference: null,
          referenceTotalCents: null,
          confidence: null,
          suggestedJob: null,
          hasThumbnail: false,
          extractionId: null,
        },
      ],
      error: null,
    });
    const body = await (await GET(request())).json();
    expect(body.receipts[0]).toMatchObject({
      vendor: null,
      reference: null,
      referenceTotalCents: null,
      confidence: null,
      suggestedJob: null,
      thumbnailUrl: null,
      extractionId: null,
    });
  });

  it("returns an empty result and masks database failures", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await (await GET(request())).json()).toMatchObject({ receipts: [], nextCursor: null });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    rpc.mockResolvedValue({ data: null, error: { message: "secret SQL diagnostic" } });
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("secret SQL");
    log.mockRestore();
  });

  it("denies a role revoked between the API guard and database query", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { code: "42501", message: "private database details" },
    });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Manager access required" },
    });
  });

  it("rejects impossible cursor calendar dates before PostgreSQL can normalize them", async () => {
    rpc.mockResolvedValue({ data: [row, row], error: null });
    const body = await (await GET(request("?limit=1"))).json();
    const cursor = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8"));
    const encoded = Buffer.from(
      JSON.stringify({ ...cursor, submittedAt: "2026-02-30T12:00:00.123456Z" }),
    ).toString("base64url");
    rpc.mockClear();
    expect((await GET(request(`?limit=1&cursor=${encoded}`))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
