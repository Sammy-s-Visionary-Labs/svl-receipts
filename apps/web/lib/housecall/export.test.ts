import { createHash } from "node:crypto";
import {
  createHousecallClient,
  type HousecallClient,
  HousecallError,
  type PreparedHousecallWrite,
} from "@svl/integrations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ service: vi.fn(), readObject: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: mocks.service }));
vi.mock("@/lib/storage/receipts", () => ({ readReceiptObject: mocks.readObject }));

import {
  type ExportStepRow,
  prepareExportStep,
  runApprovedHousecallExports,
  runReceiptHousecallExport,
} from "./export";

const receiptId = "receipt_test";
const intentId = "intent_test";
const intentHash = "b".repeat(64);
const stepHash = "a".repeat(64);
const jobId = "job_test_2";
function materialStep(extra: Partial<ExportStepRow> = {}): ExportStepRow {
  return {
    id: "step_test",
    intent_id: intentId,
    receipt_id: receiptId,
    housecall_job_id: jobId,
    step: "job_cost",
    receipt_page_id: null,
    receipt_line_id: "line_test",
    payload_hash: stepHash,
    lease_token: "lease_test",
    status: "leased",
    payload: {
      line: {
        receipt_line_id: "line_test",
        description: "Synthetic limestone",
        qty: 0.5,
        unit_cost_cents: 4200,
      },
    },
    ...extra,
  };
}
function imageStep(bytes = Buffer.from([1, 2, 3])): ExportStepRow {
  return {
    ...materialStep(),
    step: "attachment",
    receipt_line_id: null,
    receipt_page_id: "page_test",
    payload: {
      image: {
        page_id: "page_test",
        storage_key: "receipt_test/page_test.jpg",
        content_type: "image/jpeg",
        checksum: createHash("sha256").update(bytes).digest("hex"),
        byte_size: bytes.length,
      },
    },
  };
}
function approvalGrant(extra: Record<string, unknown> = {}) {
  return {
    id: "approval_test",
    approved_by: "operator_test",
    created_at: new Date(Date.now() - 1000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    job_ids: [jobId],
    used_writes: 1,
    step_id: "step_test",
    step_payload_hash: stepHash,
    payload_hash: intentHash,
    ...extra,
  };
}
type Claim = { step: ExportStepRow; reconcileOnly: boolean };
type DbOptions = {
  readyReceipts?: Array<{ receipt_id: string }>;
  jobs?: string[];
  approvals?: Array<{ job_ids: string[]; used_writes: number; max_writes: number }>;
  claims?: Claim[];
  grant?: Record<string, unknown> | null;
  grantError?: { message: string };
  outbox?: Record<string, unknown> | null;
  intentHash?: string | null;
  events?: string[];
};
function database(options: DbOptions = {}) {
  const claims = [...(options.claims ?? [{ step: materialStep(), reconcileOnly: false }])];
  const events = options.events ?? [];
  const tableData = (table: string) =>
    table === "housecall_outbox"
      ? options.outbox === undefined
        ? { intent_id: intentId, status: "pending" }
        : options.outbox
      : table === "housecall_intents"
        ? {
            id: intentId,
            payload_hash: options.intentHash === undefined ? intentHash : options.intentHash,
            attachment_job_ids: options.jobs ?? [jobId],
            approved_images: [],
          }
        : table === "housecall_write_approvals"
          ? (options.approvals ?? [{ job_ids: [jobId], used_writes: 0, max_writes: 10 }])
          : null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    events.push(name);
    if (name === "list_ready_housecall_exports")
      return { data: options.readyReceipts ?? [], error: null };
    if (name === "claim_housecall_export_step")
      return { data: claims.shift() ?? null, error: null };
    if (name === "consume_housecall_write_approval")
      return {
        data: options.grant === undefined ? approvalGrant() : options.grant,
        error: options.grantError ?? null,
      };
    if (name === "finish_housecall_export_step") {
      events.push(`finish:${args.p_outcome}`);
      return { data: null, error: null };
    }
    throw new Error(`Unexpected mock RPC ${name}`);
  });
  const from = vi.fn((table: string) => {
    const result = { data: tableData(table), error: null };
    const query = {
      select: () => query,
      eq: () => query,
      is: () => query,
      gt: () => query,
      in: () => query,
      neq: () => query,
      order: () => query,
      limit: () => query,
      maybeSingle: async () => result,
      single: async () => result,
      // biome-ignore lint/suspicious/noThenProperty: Supabase queries are deliberately awaitable builder objects.
      then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
    };
    return query;
  });
  return { rpc, from, events };
}
function provider(events: string[] = []) {
  return {
    getJob: vi.fn(),
    listJobs: vi.fn(),
    listAllJobs: vi.fn(),
    listJobInputMaterials: vi.fn(),
    inspectJobAttachments: vi.fn(),
    checkHealth: vi.fn(),
    reconcileWrite: vi.fn<HousecallClient["reconcileWrite"]>(
      async (_write: PreparedHousecallWrite) => {
        events.push("provider:read");
        return { status: "absent" as const };
      },
    ),
    executePreparedWrite: vi.fn<HousecallClient["executePreparedWrite"]>(
      async (_write: PreparedHousecallWrite) => {
        events.push("provider:write");
        return { status: "accepted" as const, httpStatus: 200 };
      },
    ),
  };
}
function run(
  db: ReturnType<typeof database>,
  client: HousecallClient,
  extra: Record<string, unknown> = {},
) {
  return runReceiptHousecallExport(receiptId, {
    db: db as unknown as NonNullable<Parameters<typeof runReceiptHousecallExport>[1]>["db"],
    client,
    ...extra,
  });
}
function finishes(db: ReturnType<typeof database>) {
  return db.rpc.mock.calls
    .filter(([name]) => name === "finish_housecall_export_step")
    .map(([, args]) => args);
}
function enable() {
  vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
  vi.stubEnv("HOUSECALL_EXPORT_MODE", "approved_test");
  vi.stubEnv("HOUSECALL_TEST_JOB_IDS", jobId);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("HOUSECALL_READS_ENABLED", "false");
  vi.stubEnv("HOUSECALL_EXPORT_MODE", "disabled");
  vi.stubEnv("HOUSECALL_TEST_JOB_IDS", "");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live network forbidden in RA-6 tests");
    }),
  );
  mocks.service.mockImplementation(() => {
    throw new Error("Live database forbidden in RA-6 tests");
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("RA-6 export approval boundaries", () => {
  it("default disabled mode constructs no DB and touches no provider", async () => {
    expect(await runReceiptHousecallExport(receiptId)).toMatchObject({
      skipped: "live_writes_disabled",
    });
    expect(await runApprovedHousecallExports()).toMatchObject({ skipped: "live_writes_disabled" });
    expect(mocks.service).not.toHaveBeenCalled();
    expect(mocks.readObject).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("blocks every step if any destination on the receipt is outside the approved test jobs", async () => {
    enable();
    const db = database({ jobs: [jobId, "real_business_job"] });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "destination_not_approved" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(client.reconcileWrite).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
  it("requires an immutable intent payload hash before any provider read", async () => {
    enable();
    const db = database({ intentHash: null });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "destination_not_approved" });
    expect(client.reconcileWrite).not.toHaveBeenCalled();
  });
  it("manager receipt approval alone does not permit any Housecall calls", async () => {
    enable();
    const db = database({ approvals: [] });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "explicit_approval_required" });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(client.reconcileWrite).not.toHaveBeenCalled();
  });
  it("skips a cancelled outbox without provider calls", async () => {
    enable();
    const db = database({ outbox: { intent_id: intentId, status: "cancelled" } });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "no_current_intent" });
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each([
    { step_id: "other_step" },
    { step_payload_hash: "changed" },
    { payload_hash: "changed" },
    { job_ids: ["real_business_job"] },
  ])("blocks mismatched durable grants before provider writes %o", async (mismatch) => {
    enable();
    const db = database({ grant: approvalGrant(mismatch) });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ unresolved: 1 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "uncertain" })]);
  });
  it("revocation or an exhausted grant at consume time prevents HTTP dispatch", async () => {
    enable();
    const db = database({ grantError: { message: "approval_revoked" } });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "explicit_approval_required" });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "not_sent" })]);
  });
  it("exhausted approvals allow verification but cannot authorize another write", async () => {
    enable();
    const db = database({ approvals: [{ job_ids: [jobId], used_writes: 1, max_writes: 1 }] });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ skipped: "explicit_approval_required" });
    expect(client.reconcileWrite).toHaveBeenCalledTimes(1);
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "consume_housecall_write_approval",
    );
  });
});

describe("RA-6 safe dispatch and verification", () => {
  it("records durable dispatch before HTTP and succeeds only after exact read verification", async () => {
    enable();
    const events: string[] = [];
    const db = database({ events });
    const client = provider(events);
    client.reconcileWrite
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce({ status: "found", providerId: "material_hcp_test" });
    expect(await run(db, client)).toEqual({ completed: 1, unresolved: 0 });
    expect(events.indexOf("consume_housecall_write_approval")).toBeLessThan(
      events.indexOf("provider:write"),
    );
    expect(client.executePreparedWrite).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "job_cost", jobId }),
      expect.objectContaining({
        approvedBy: "operator_test",
        jobId,
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(finishes(db)).toEqual([
      expect.objectContaining({
        p_outcome: "succeeded",
        p_external_id: "material_hcp_test",
        p_evidence: expect.objectContaining({ verified: true }),
      }),
    ]);
  });
  it("already-present material skips write and does not consume approval budget", async () => {
    enable();
    const db = database();
    const client = provider();
    client.reconcileWrite.mockResolvedValue({
      status: "found",
      providerId: "existing_test",
    });
    expect(await run(db, client)).toEqual({ completed: 1, unresolved: 0 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "consume_housecall_write_approval",
    );
  });
  it("ambiguous earlier dispatch plus an absent read never resends", async () => {
    enable();
    const db = database({
      claims: [{ step: materialStep({ status: "uncertain" }), reconcileOnly: true }],
    });
    const client = provider();
    expect(await run(db, client)).toEqual({ completed: 0, unresolved: 1 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "not_found" })]);
  });
  it("202 attachment acceptance without later presence remains unresolved", async () => {
    enable();
    const bytes = Buffer.from([1, 2, 3]);
    const db = database({ claims: [{ step: imageStep(bytes), reconcileOnly: false }] });
    const client = provider();
    client.executePreparedWrite.mockResolvedValue({ status: "accepted", httpStatus: 202 });
    const readObject = vi.fn().mockResolvedValue({ bytes, contentType: "image/jpeg" });
    expect(await run(db, client, { readObject })).toEqual({ completed: 0, unresolved: 1 });
    expect(client.executePreparedWrite).toHaveBeenCalledTimes(1);
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "uncertain" })]);
  });
  it("timeout after a committed provider write is recovered by a later read with no duplicate", async () => {
    enable();
    let saved: Record<string, unknown>[] = [];
    let writeCount = 0;
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") {
        writeCount++;
        const body = JSON.parse(String(init.body));
        saved = [{ uuid: "material_saved_test", ...body.job_input_materials[0] }];
        throw new Error("timeout after provider commit");
      }
      if (String(url).endsWith("/job_input_materials"))
        return new Response(JSON.stringify({ job_input_materials: saved }));
      return new Response(JSON.stringify({ id: jobId, work_status: "scheduled" }));
    });
    const client = createHousecallClient({
      apiKey: "synthetic-key",
      fetch: transport as typeof fetch,
      allowedWriteJobIds: [jobId],
    });
    const first = database();
    expect(await run(first, client)).toEqual({ completed: 0, unresolved: 1 });
    expect(finishes(first)).toEqual([expect.objectContaining({ p_outcome: "uncertain" })]);
    const second = database({
      claims: [{ step: materialStep({ status: "uncertain" }), reconcileOnly: true }],
    });
    expect(await run(second, client)).toEqual({ completed: 1, unresolved: 0 });
    expect(writeCount).toBe(1);
    expect(finishes(second)).toEqual([
      expect.objectContaining({ p_outcome: "succeeded", p_external_id: "material_saved_test" }),
    ]);
  });
  it("verification failures after dispatch retain uncertainty", async () => {
    enable();
    const db = database();
    const client = provider();
    client.reconcileWrite
      .mockResolvedValueOnce({ status: "absent" })
      .mockRejectedValueOnce(new HousecallError("network"));
    expect(await run(db, client)).toMatchObject({ unresolved: 1 });
    expect(finishes(db)).toEqual([
      expect.objectContaining({ p_outcome: "uncertain", p_error_code: "network" }),
    ]);
  });
  it("stops when provider finds a duplicate reference or changed financial payload", async () => {
    enable();
    const db = database();
    const client = provider();
    client.reconcileWrite.mockResolvedValue({
      status: "conflict",
      reason: "payload_mismatch",
    });
    expect(await run(db, client)).toMatchObject({ unresolved: 1 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
  it("invalid claimed destination is rejected before any provider call", async () => {
    enable();
    const db = database({
      claims: [
        { step: materialStep({ housecall_job_id: "real_business_job" }), reconcileOnly: false },
      ],
    });
    const client = provider();
    expect(await run(db, client)).toMatchObject({ unresolved: 1 });
    expect(client.reconcileWrite).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
});

describe("RA-6 approved image integrity", () => {
  it("checksum mismatch prevents even provider reads", async () => {
    enable();
    const db = database({ claims: [{ step: imageStep(), reconcileOnly: false }] });
    const client = provider();
    const readObject = vi
      .fn()
      .mockResolvedValue({ bytes: Buffer.from([9, 9, 9]), contentType: "image/jpeg" });
    expect(await run(db, client, { readObject })).toMatchObject({ unresolved: 1 });
    expect(client.reconcileWrite).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "not_sent" })]);
  });
  it("missing or resized approved image stops export", async () => {
    for (const object of [null, { bytes: Buffer.from([1]), contentType: "image/jpeg" }])
      await expect(
        prepareExportStep(imageStep(), vi.fn().mockResolvedValue(object)),
      ).rejects.toThrow("receipt_image_changed");
  });
  it("a line target must match the immutable step identity", async () => {
    await expect(
      prepareExportStep(materialStep({ receipt_line_id: "other_line" })),
    ).rejects.toThrow("invalid_export_plan");
  });
});

describe("Read-only recovery after live write approval expires", () => {
  it("can verify an uncertain committed write with exports disabled and no active grant", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_TEST_JOB_IDS", jobId);
    const db = database({
      approvals: [],
      claims: [{ step: materialStep({ status: "uncertain" }), reconcileOnly: true }],
    });
    const client = provider();
    client.reconcileWrite.mockResolvedValue({ status: "found", providerId: "already_saved" });
    expect(await run(db, client, { reconcileOnly: true })).toEqual({ completed: 1, unresolved: 0 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "consume_housecall_write_approval",
    );
    expect(finishes(db)).toEqual([
      expect.objectContaining({ p_outcome: "succeeded", p_external_id: "already_saved" }),
    ]);
  });
  it("an absent uncertain write stays unresolved after expiry without consuming or posting", async () => {
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_TEST_JOB_IDS", jobId);
    const db = database({
      approvals: [],
      claims: [{ step: materialStep({ status: "uncertain" }), reconcileOnly: true }],
    });
    const client = provider();
    expect(await run(db, client, { reconcileOnly: true })).toEqual({ completed: 0, unresolved: 1 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "consume_housecall_write_approval",
    );
  });
  it("a fresh unattempted step cannot be sent through the read-only recovery path", async () => {
    enable();
    const db = database();
    const client = provider();
    expect(await run(db, client, { reconcileOnly: true })).toEqual({ completed: 0, unresolved: 0 });
    expect(client.reconcileWrite).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc.mock.calls.map(([name]) => name)).not.toContain(
      "consume_housecall_write_approval",
    );
    expect(finishes(db)).toEqual([expect.objectContaining({ p_outcome: "not_sent" })]);
  });
  it("read-only recovery still requires server read enablement and the exact test job allowlist", async () => {
    const db = database();
    const client = provider();
    expect(await run(db, client, { reconcileOnly: true })).toMatchObject({
      skipped: "live_writes_disabled",
    });
    expect(db.from).not.toHaveBeenCalled();
    vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
    vi.stubEnv("HOUSECALL_TEST_JOB_IDS", "different_test_job");
    expect(await run(db, client, { reconcileOnly: true })).toMatchObject({
      skipped: "destination_not_approved",
    });
    expect(client.reconcileWrite).not.toHaveBeenCalled();
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
  });
});

describe("Approved export scheduler selects runnable work", () => {
  it("queries bounded ready exports rather than the oldest approvals", async () => {
    enable();
    const db = database();
    const client = provider();
    const result = await runApprovedHousecallExports({
      db: db as unknown as NonNullable<Parameters<typeof runReceiptHousecallExport>[1]>["db"],
      client,
    });
    expect(result).toMatchObject({ skipped: "explicit_approval_required" });
    expect(db.rpc).toHaveBeenCalledWith("list_ready_housecall_exports", { p_limit: 20 });
    expect(db.from).not.toHaveBeenCalled();
    expect(client.reconcileWrite).not.toHaveBeenCalled();
  });
  it("visits a ready receipt returned by the durable selector", async () => {
    enable();
    const db = database({ readyReceipts: [{ receipt_id: receiptId }] });
    const client = provider();
    client.reconcileWrite.mockResolvedValue({ status: "found", providerId: "already_saved" });
    const result = await runApprovedHousecallExports({
      db: db as unknown as NonNullable<Parameters<typeof runReceiptHousecallExport>[1]>["db"],
      client,
    });
    expect(result).toEqual({ completed: 1, unresolved: 0 });
    expect(client.executePreparedWrite).not.toHaveBeenCalled();
    expect(db.rpc).toHaveBeenCalledWith("list_ready_housecall_exports", { p_limit: 20 });
  });
});
