import { describe, expect, it, vi } from "vitest";
import {
  createHousecallClient,
  HousecallError,
  parseHousecallJob,
  parseHousecallRateLimitReset,
  parseHousecallRetryAfter,
} from "./client";
import {
  HOUSECALL_ORIGIN,
  isHousecallQuantitySupported,
  prepareAttachmentWrite,
  prepareMaterialWrite,
} from "./payloads";
import type { HousecallWritePermit, PreparedHousecallWrite } from "./types";

const NOW = Date.parse("2026-09-09T12:00:00Z");
describe("live provider quantity precision", () => {
  it.each([0.5, 1, 1.01, 10.12])("allows exact hundredths %s", (quantity) => {
    expect(isHousecallQuantitySupported(quantity)).toBe(true);
  });
  it.each([1.005, 10.125, 0.001])(
    "blocks %s before any provider request while retaining the original for reconciliation",
    async (quantity) => {
      const write = await material({ quantity });
      expect(write.body.job_input_materials[0]?.quantity).toBe(quantity);
      const transport = vi.fn();
      await expect(
        client(transport, [write.jobId]).executePreparedWrite(write, permit(write)),
      ).rejects.toMatchObject({ code: "invalid_payload" });
      expect(transport).not.toHaveBeenCalled();
    },
  );
});
const job = (id = "job_test_2", extra: Record<string, unknown> = {}) => ({
  id,
  work_status: "scheduled",
  invoice_number: "RA6-2",
  description: "Synthetic test job",
  customer: {
    id: "cust_test_2",
    first_name: "RA6 Test",
    last_name: "Customer 2",
    notifications_enabled: false,
  },
  address: { street: "10 Test Road", city: "Example", state: "OH", zip: "00000" },
  schedule: { scheduled_start: "2026-09-09T09:00:00Z", scheduled_end: "2026-09-09T17:00:00Z" },
  assigned_employees: [{ id: "employee_test" }],
  ...extra,
});
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
const material = (extra = {}) =>
  prepareMaterialWrite({
    jobId: "job_test_2",
    intentId: "intent_test",
    receiptId: "receipt_test",
    receiptLineId: "line_test",
    description: "#8 limestone",
    quantity: 0.5,
    unitCostCents: 4200,
    ...extra,
  });
const attachment = (extra = {}) =>
  prepareAttachmentWrite({
    jobId: "job_test_2",
    intentId: "intent_test",
    receiptId: "receipt_test",
    pageId: "page_test",
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/jpeg",
    ...extra,
  });
const permit = (
  write: PreparedHousecallWrite,
  extra: Partial<HousecallWritePermit> = {},
): HousecallWritePermit => ({
  approvalId: "approval_test",
  approvedBy: "test_operator",
  approvedAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  jobId: write.jobId,
  requestHash: write.requestHash,
  ...extra,
});
function client(transport: ReturnType<typeof vi.fn>, allowedWriteJobIds: string[] = []) {
  return createHousecallClient({
    apiKey: "synthetic-api-key",
    fetch: transport as typeof fetch,
    allowedWriteJobIds,
    now: () => NOW,
  });
}

describe("Housecall documented material payload", () => {
  it("uses internal Job Input Materials PUT with integer cents, original quantity, no tax or invoice items", async () => {
    const write = await material();
    expect(write.path).toBe("/jobs/job_test_2/job_input_materials/bulk_update");
    expect(write.method).toBe("PUT");
    expect(write.body).toEqual({
      job_input_materials: [
        {
          name: "#8 limestone",
          description: "Receipt receipt_test; SVL:intent_test:line_test",
          part_number: "SVL:intent_test:line_test",
          quantity: 0.5,
          unit_cost: 4200,
        },
      ],
    });
    expect(JSON.stringify(write.body)).not.toMatch(/tax|unit_price|uuid|line_items/);
  });
  it("uses stable fingerprints but changes approval hash when job, amount or receipt line changes", async () => {
    const original = await material();
    expect((await material()).requestHash).toBe(original.requestHash);
    for (const change of [
      { jobId: "job_test_3" },
      { quantity: 1 },
      { unitCostCents: 4201 },
      { receiptLineId: "line_other" },
    ])
      expect((await material(change)).requestHash).not.toBe(original.requestHash);
  });
  it.each([
    { quantity: 0 },
    { quantity: -1 },
    { quantity: Number.NaN },
    { quantity: 0.0001 },
    { unitCostCents: 4.2 },
    { unitCostCents: -1 },
    { unitCostCents: 2_147_483_648 },
    { quantity: 10, unitCostCents: 2_147_483_647 },
    { description: " " },
    { jobId: "../jobs/real" },
  ])("rejects invalid financial values or paths %o", async (invalid) => {
    await expect(material(invalid)).rejects.toThrow();
  });
  it("retains 3-decimal quantities without substituting extended amount as unit cost", async () => {
    expect(
      (await material({ quantity: 1.005, unitCostCents: 100 })).body.job_input_materials[0],
    ).toMatchObject({ quantity: 1.005, unit_cost: 100 });
  });
});

describe("Housecall receipt image identity", () => {
  it("includes every image, intent and bytes digest in stable multipart filename", async () => {
    const write = await attachment();
    expect(write.fileName).toMatch(/^svl-receipt_test-intent_test-page_test-[a-f0-9]{64}\.jpg$/);
    expect((await attachment()).requestHash).toBe(write.requestHash);
    expect((await attachment({ pageId: "page_two" })).fileName).not.toBe(write.fileName);
    expect((await attachment({ bytes: new Uint8Array([5]) })).requestHash).not.toBe(
      write.requestHash,
    );
  });
  it("copies caller bytes before preparing so later edits cannot silently change the request", async () => {
    const bytes = new Uint8Array([1]);
    const write = await attachment({ bytes });
    bytes[0] = 2;
    expect(write.bytes[0]).toBe(1);
  });
});

describe("Housecall server read client", () => {
  it("uses fixed provider origin, server token, no redirects/cache/cookies", async () => {
    const transport = vi.fn().mockResolvedValue(json(job()));
    const result = await client(transport).getJob("job_test_2");
    expect(result).toMatchObject({
      id: "job_test_2",
      customerName: "RA6 Test Customer 2",
      active: true,
      customerNotificationsEnabled: false,
      assignedEmployeeIds: ["employee_test"],
    });
    expect(transport).toHaveBeenCalledWith(
      `${HOUSECALL_ORIGIN}/jobs/job_test_2`,
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({
          Authorization: "Token synthetic-api-key",
          Accept: "application/json",
          "X-Request-Id": expect.stringMatching(/^sync-/),
        }),
      }),
    );
  });
  it("fetches every documented page and rejects a scan cut short by the page cap", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        json({ jobs: [job()], page: 1, page_size: 1, total_pages: 2, total_items: 2 }),
      )
      .mockResolvedValueOnce(
        json({ jobs: [job("job_test_3")], page: 2, page_size: 1, total_pages: 2, total_items: 2 }),
      );
    expect(
      (
        await client(transport).listAllJobs({
          pageSize: 1,
          sortBy: "updated_at",
          workStatus: ["scheduled", "in_progress"],
        })
      ).map((x) => x.id),
    ).toEqual(["job_test_2", "job_test_3"]);
    expect(transport.mock.calls[0]?.[0]).toContain(
      "work_status%5B%5D=scheduled&work_status%5B%5D=in_progress",
    );
    const capped = vi
      .fn()
      .mockResolvedValue(
        json({ jobs: [job()], page: 1, page_size: 1, total_pages: 2, total_items: 2 }),
      );
    await expect(client(capped).listAllJobs({}, { maxPages: 1 })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
  it("rejects a mismatched job response and unexpanded attachments rather than treating them as absent", async () => {
    await expect(
      client(vi.fn().mockResolvedValue(json(job("wrong_job")))).getJob("job_test_2"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      client(vi.fn().mockResolvedValue(json(job()))).inspectJobAttachments("job_test_2"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
  it.each(["user canceled", "pro canceled", "unknown provider status"])(
    "does not classify %s as active",
    (work_status) => {
      expect(parseHousecallJob(job("job_test_2", { work_status })).active).toBe(false);
    },
  );
  it("sanitizes provider bodies and thrown transport secrets", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(json({ error: "synthetic-api-key private receipt" }, 401));
    const error = await client(transport)
      .getJob("job_test_2")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HousecallError);
    expect(String(error)).toBe("HousecallError: Housecall request failed: authentication");
    const failure = vi.fn().mockRejectedValue(new Error("synthetic-api-key"));
    await expect(client(failure).getJob("job_test_2")).rejects.toMatchObject({
      code: "network",
      writeOutcomeUnknown: false,
    });
  });
  it("parses both Retry-After forms and makes no automatic retry", async () => {
    expect(parseHousecallRetryAfter("5", NOW)).toBe(5000);
    expect(parseHousecallRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(30_000);
    expect(parseHousecallRetryAfter("garbage", NOW)).toBeNull();
    const transport = vi.fn().mockResolvedValue(json({}, 429, { "Retry-After": "7" }));
    await expect(client(transport).getJob("job_test_2")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 7000,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("times out a hanging body and aborts the request", async () => {
    const transport = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: () => new Promise(() => {}),
    });
    const adapter = createHousecallClient({
      apiKey: "test",
      fetch: transport as typeof fetch,
      timeoutMs: 5,
    });
    await expect(adapter.getJob("job_test_2")).rejects.toMatchObject({
      code: "timeout",
      writeOutcomeUnknown: false,
    });
    expect((transport.mock.calls[0]?.[1] as RequestInit | undefined)?.signal?.aborted).toBe(true);
  });
});

describe("Explicit approval for every live write", () => {
  it("makes ZERO requests without both an exact allowed job and bounded permit", async () => {
    const write = await material();
    const transport = vi.fn();
    await expect(
      client(transport).executePreparedWrite(write, permit(write)),
    ).rejects.toMatchObject({ code: "write_blocked" });
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write),
    ).rejects.toMatchObject({ code: "write_blocked" });
    await expect(
      client(transport, ["job_test_3"]).executePreparedWrite(write, permit(write)),
    ).rejects.toMatchObject({ code: "write_blocked" });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { jobId: "job_test_3" },
    { requestHash: "wrong" },
    { approvedBy: "" },
    { expiresAt: new Date(NOW - 1).toISOString() },
    { approvedAt: new Date(NOW + 1).toISOString() },
    { expiresAt: new Date(NOW + 86_400_001).toISOString() },
  ])("rejects an invalid approval %o", async (change) => {
    const write = await material();
    const transport = vi.fn();
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write, permit(write, change)),
    ).rejects.toMatchObject({ code: "write_blocked" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects tampered frozen cost payload and image bytes before any request", async () => {
    const write = await material();
    const grant = permit(write);
    const firstLine = write.body.job_input_materials[0];
    if (!firstLine) throw new Error("Test fixture missing material");
    firstLine.unit_cost += 1;
    const transport = vi.fn();
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write, grant),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    const image = await attachment();
    const imageGrant = permit(image);
    image.bytes[0] = 8;
    await expect(
      client(transport, [image.jobId]).executePreparedWrite(image, imageGrant),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    { work_status: "user canceled" },
    { deleted_at: "2026-09-09" },
    { locked_at: "2026-09-09" },
    { work_status: "unexpected" },
  ])("rechecks unsafe job state before dispatch %o", async (state) => {
    const write = await material();
    const transport = vi.fn().mockResolvedValue(json(job("job_test_2", state)));
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write, permit(write)),
    ).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1].method).toBe("GET");
  });
  it("sends one exact material request and consumes the permit across concurrent attempts", async () => {
    const write = await material();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(job()))
      .mockResolvedValueOnce(json({ job_input_materials: [] }));
    const adapter = client(transport, [write.jobId]);
    const results = await Promise.allSettled([
      adapter.executePreparedWrite(write, permit(write)),
      adapter.executePreparedWrite(write, permit(write)),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]).toEqual([
      `${HOUSECALL_ORIGIN}${write.path}`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify(write.body) }),
    ]);
  });
  it.each([201, 202])(
    "uses multipart image bytes and treats %s as accepted, never verified",
    async (status) => {
      const write = await attachment();
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(job()))
        .mockResolvedValueOnce(json({ job_url: "synthetic" }, status));
      expect(
        await client(transport, [write.jobId]).executePreparedWrite(write, permit(write)),
      ).toEqual({ status: "accepted", httpStatus: status });
      const init = transport.mock.calls[1]?.[1] as RequestInit;
      const file = (init.body as FormData).get("file") as File;
      expect(file.name).toBe(write.fileName);
      expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3, 4]);
      expect(init.headers).not.toHaveProperty("Content-Type");
    },
  );
  it.each([500, 502, 408])(
    "keeps ambiguous HTTP %s outcomes unknown with zero automatic retries",
    async (status) => {
      const write = await material();
      const transport = vi
        .fn()
        .mockResolvedValueOnce(json(job()))
        .mockResolvedValueOnce(json({ secret: "never expose" }, status));
      await expect(
        client(transport, [write.jobId]).executePreparedWrite(write, permit(write)),
      ).rejects.toMatchObject({ writeOutcomeUnknown: true });
      expect(transport).toHaveBeenCalledTimes(2);
    },
  );
  it("keeps timeout after dispatch unknown and does not resend", async () => {
    const write = await material();
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(job()))
      .mockImplementationOnce(() => new Promise(() => {}));
    const adapter = createHousecallClient({
      apiKey: "test",
      fetch: transport as typeof fetch,
      timeoutMs: 5,
      allowedWriteJobIds: [write.jobId],
      now: () => NOW,
    });
    await expect(adapter.executePreparedWrite(write, permit(write))).rejects.toMatchObject({
      code: "timeout",
      writeOutcomeUnknown: true,
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("Read reconciliation, never blind retry", () => {
  it("matches exact material reference and full frozen payload", async () => {
    const write = await material();
    const expected = write.body.job_input_materials[0];
    const transport = vi
      .fn()
      .mockResolvedValue(json({ job_input_materials: [{ uuid: "mat_test", ...expected }] }));
    expect(await client(transport).reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "mat_test",
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      `${HOUSECALL_ORIGIN}/jobs/job_test_2/job_input_materials`,
    );
  });
  it("conflicting costs or duplicate references require review", async () => {
    const write = await material();
    const expected = write.body.job_input_materials[0];
    expect(
      await client(
        vi
          .fn()
          .mockResolvedValue(
            json({ job_input_materials: [{ uuid: "mat_test", ...expected, unit_cost: 1 }] }),
          ),
      ).reconcileWrite(write),
    ).toEqual({ status: "conflict", reason: "payload_mismatch" });
    expect(
      await client(
        vi.fn().mockResolvedValue(
          json({
            job_input_materials: [
              { uuid: "mat_test", ...expected },
              { uuid: "mat_duplicate", ...expected },
            ],
          }),
        ),
      ).reconcileWrite(write),
    ).toEqual({ status: "conflict", reason: "duplicate_reference" });
  });
  it("absence is only an observation and does not trigger another write", async () => {
    const write = await material();
    const transport = vi.fn().mockResolvedValue(json({ job_input_materials: [] }));
    expect(await client(transport).reconcileWrite(write)).toEqual({ status: "absent" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1].method).toBe("GET");
  });
  it("verifies each page by exact digest filename on the exact target job", async () => {
    const write = await attachment();
    const transport = vi.fn().mockResolvedValue(
      json(
        job("job_test_2", {
          attachments: [
            {
              id: "att_test",
              file_name: write.fileName,
              file_type: "image/jpeg",
              url: "https://assets.example/test",
            },
          ],
        }),
      ),
    );
    expect(await client(transport).reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "att_test",
    });
    expect(transport.mock.calls[0]?.[0]).toBe(
      `${HOUSECALL_ORIGIN}/jobs/job_test_2?expand%5B%5D=attachments`,
    );
  });
});

describe("Housecall frozen receipt reference", () => {
  it("keeps the product name while adding the approved vendor, invoice and date to description", async () => {
    const reference = "RA6 Synthetic Stone | Invoice TEST-2002 | 2026-09-09";
    const write = await material({ approvedReference: reference });
    expect(write.body.job_input_materials).toEqual([
      {
        name: "#8 limestone",
        description: `${reference}; Receipt receipt_test; SVL:intent_test:line_test`,
        part_number: "SVL:intent_test:line_test",
        quantity: 0.5,
        unit_cost: 4200,
      },
    ]);
    expect(write.requestHash).not.toBe(
      (await material({ approvedReference: "Different approved invoice" })).requestHash,
    );
  });
  it("rejects an unbounded approved reference", async () => {
    await expect(material({ approvedReference: "x".repeat(501) })).rejects.toThrow(
      "Invalid approved receipt reference",
    );
  });
});

describe("Documented Housecall rate-limit reset header", () => {
  it("converts epoch seconds to a bounded reset delay and rejects malformed values", () => {
    expect(parseHousecallRateLimitReset(String((NOW + 30000) / 1000), NOW)).toBe(30000);
    expect(parseHousecallRateLimitReset(String((NOW - 1000) / 1000), NOW)).toBe(0);
    expect(parseHousecallRateLimitReset(String((NOW + 172800000) / 1000), NOW)).toBe(86400000);
    expect(parseHousecallRateLimitReset("invalid", NOW)).toBeNull();
    expect(parseHousecallRateLimitReset("", NOW)).toBeNull();
  });
  it("uses the documented RateLimit-Reset header when Retry-After is absent", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(json({}, 429, { "RateLimit-Reset": String((NOW + 30000) / 1000) }));
    await expect(client(transport).getJob("job_test_2")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 30000,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    { retry: "10", expected: 30000 },
    { retry: "60", expected: 60000 },
  ])("respects the later of both rate-limit headers $retry", async ({ retry, expected }) => {
    const transport = vi
      .fn()
      .mockResolvedValue(
        json({}, 429, { "Retry-After": retry, "RateLimit-Reset": String((NOW + 30000) / 1000) }),
      );
    await expect(client(transport).getJob("job_test_2")).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: expected,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("Material reconciliation with unrelated provider placeholders", () => {
  it("reads unrelated zero and missing fields without losing exact matching of our material", async () => {
    const write = await material();
    const expected = write.body.job_input_materials[0];
    const transport = vi.fn().mockImplementation(async () =>
      json({
        job_input_materials: [
          { uuid: "unrelated_zero", name: "Unused material", quantity: 0, unit_cost: 0 },
          { name: "Legacy placeholder" },
          { uuid: "unrelated_optional", part_number: "unrelated-part" },
          { uuid: "our_material", ...expected },
        ],
      }),
    );
    const adapter = client(transport);
    const rows = await adapter.listJobInputMaterials(write.jobId);
    expect(rows[0]).toMatchObject({ id: "unrelated_zero", quantity: 0, unitCostCents: 0 });
    expect(rows[1]).toMatchObject({
      id: null,
      name: "Legacy placeholder",
      quantity: null,
      unitCostCents: null,
    });
    expect(rows[2]).toMatchObject({
      id: "unrelated_optional",
      name: "",
      quantity: null,
      unitCostCents: null,
    });
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "our_material",
    });
    expect(
      transport.mock.calls.every(([, init]) => !init || (init as RequestInit).method === "GET"),
    ).toBe(true);
  });
  it.each(["uuid", "name", "description", "quantity", "unit_cost"])(
    "our marker with missing %s is a conflict, never a verified result",
    async (field) => {
      const write = await material();
      const expected = write.body.job_input_materials[0];
      const existing: Record<string, unknown> = { uuid: "our_material", ...expected };
      delete existing[field];
      const transport = vi.fn().mockResolvedValue(json({ job_input_materials: [existing] }));
      expect(await client(transport).reconcileWrite(write)).toEqual({
        status: "conflict",
        reason: "payload_mismatch",
      });
    },
  );
  it.each([
    { quantity: 0 },
    { quantity: "0.5" },
    { unit_cost: "4200" },
    { uuid: " " },
    { unit_cost: null },
  ])("our marker with changed or unknown content conflicts %o", async (change) => {
    const write = await material();
    const expected = write.body.job_input_materials[0];
    const transport = vi
      .fn()
      .mockResolvedValue(
        json({ job_input_materials: [{ uuid: "our_material", ...expected, ...change }] }),
      );
    expect(await client(transport).reconcileWrite(write)).toEqual({
      status: "conflict",
      reason: "payload_mismatch",
    });
  });
  it("a duplicate own marker remains a conflict even if one record is incomplete", async () => {
    const write = await material();
    const expected = write.body.job_input_materials[0];
    const transport = vi.fn().mockResolvedValue(
      json({
        job_input_materials: [
          { uuid: "our_material", ...expected },
          { part_number: write.reference },
        ],
      }),
    );
    expect(await client(transport).reconcileWrite(write)).toEqual({
      status: "conflict",
      reason: "duplicate_reference",
    });
  });
});

describe("exact test customer read boundaries", () => {
  const scoped = (transport: ReturnType<typeof vi.fn>) =>
    createHousecallClient({
      apiKey: "synthetic",
      fetch: transport as typeof fetch,
      allowedReadJobIds: ["job_test_2"],
      allowedReadCustomerIds: ["cust_test_2"],
    });
  it("blocks unfiltered and out-of-scope reads before HTTP", async () => {
    const transport = vi.fn();
    const c = scoped(transport);
    await expect(c.listJobs()).rejects.toBeDefined();
    await expect(c.listJobs({ customerId: "cust_real" })).rejects.toBeDefined();
    await expect(c.getJob("job_real")).rejects.toBeDefined();
    await expect(c.listJobInputMaterials("job_real")).rejects.toBeDefined();
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects a changed customer association", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(json(job("job_test_2", { customer: { id: "cust_real" } })));
    await expect(scoped(transport).getJob("job_test_2")).rejects.toMatchObject({
      code: "unsafe_destination",
    });
  });
  it("scopes health checks to an allowed customer", async () => {
    const transport = vi
      .fn()
      .mockResolvedValue(json({ jobs: [], page: 1, page_size: 1, total_pages: 0, total_items: 0 }));
    await scoped(transport).checkHealth();
    const url = new URL(String(transport.mock.calls[0]?.[0]));
    expect(url.searchParams.get("customer_id")).toBe("cust_test_2");
  });
  it("rejects a list containing another customer", async () => {
    const transport = vi.fn().mockResolvedValue(
      json({
        jobs: [job("job_test_2", { customer: { id: "cust_real" } })],
        page: 1,
        page_size: 100,
        total_pages: 1,
        total_items: 1,
      }),
    );
    await expect(scoped(transport).listJobs({ customerId: "cust_test_2" })).rejects.toMatchObject({
      code: "unsafe_destination",
    });
  });
});

describe("Housecall operational correlation", () => {
  it("carries one correlation reference with unique request suffixes", async () => {
    const transport = vi.fn().mockImplementation(async () => json(job()));
    const c = createHousecallClient({
      apiKey: "synthetic",
      fetch: transport as typeof fetch,
      correlationId: "receipt-test",
    });
    await c.getJob("job_test_2");
    await c.getJob("job_test_2");
    expect(transport.mock.calls.map(([, init]) => init.headers["X-Request-Id"])).toEqual([
      "receipt-test-1",
      "receipt-test-2",
    ]);
  });
  it("pauses further requests in the run after authorization failure", async () => {
    const transport = vi.fn().mockResolvedValue(json({}, 401));
    const c = client(transport);
    await expect(c.getJob("job_test_2")).rejects.toMatchObject({ code: "authentication" });
    await expect(c.getJob("job_test_2")).rejects.toMatchObject({ code: "authentication" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

it("empty explicit read scopes deny all HTTP", async () => {
  const transport = vi.fn();
  const c = createHousecallClient({
    apiKey: "synthetic",
    fetch: transport as typeof fetch,
    allowedReadJobIds: [],
    allowedReadCustomerIds: [],
  });
  await expect(c.checkHealth()).rejects.toBeDefined();
  await expect(c.getJob("job_test_2")).rejects.toBeDefined();
  expect(transport).not.toHaveBeenCalled();
});
