import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({ createServiceRoleClient: vi.fn() }));
vi.mock("@/lib/storage/receipts", () => ({ readReceiptObject: vi.fn() }));

import { closeExportForManualHandling } from "./resolution";

const input = {
  actorId: "admin",
  receiptId: "receipt",
  intentId: "intent",
  payloadHash: "a".repeat(64),
  reason: "Provider rounded quantity; manual handling.",
};
function setup() {
  const step = {
    id: "step",
    intent_id: "intent",
    receipt_id: "receipt",
    housecall_job_id: "job_test",
    step: "job_cost",
    receipt_line_id: "line",
    status: "reconcile_required",
    dispatch_count: 1,
    external_id: null as string | null,
    payload_hash: "b".repeat(64),
    updated_at: new Date().toISOString(),
    payload: {
      line: {
        receipt_line_id: "line",
        description: "Synthetic material",
        qty: 1.005,
        unit_cost_cents: 100,
      },
    },
  };
  const intent = {
    id: "intent",
    payload_hash: input.payloadHash,
    attachment_job_ids: ["job_test"],
  };
  const rpc = vi.fn().mockResolvedValue({ data: { closed: true, exported: false }, error: null });
  const db = {
    rpc,
    from: vi.fn((table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        single: async () => ({ data: intent, error: null }),
        limit: async () => ({ data: [step], error: null }),
      };
      expect(["housecall_intents", "housecall_export_steps"]).toContain(table);
      return q;
    }),
  };
  const material = {
    id: "material",
    partNumber: "SVL:intent:line",
    quantity: 1.01,
    unitCostCents: 100,
  };
  const client = {
    getJob: vi.fn().mockResolvedValue({ id: "job_test", attachments: [] }),
    listJobInputMaterials: vi.fn().mockResolvedValue([material]),
  };
  const run = () =>
    closeExportForManualHandling(input, { db: db as never, client: client as never });
  return { step, intent, rpc, client, material, run };
}
beforeEach(() => {
  vi.stubEnv("HOUSECALL_READS_ENABLED", "true");
  vi.stubEnv("HOUSECALL_TEST_JOB_IDS", "job_test");
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Live calls forbidden");
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("audited manual export handoff", () => {
  it("records the observed mismatch without changing the frozen quantity or claiming success", async () => {
    const t = setup();
    expect(await t.run()).toEqual({ closed: true, exported: false });
    expect(t.rpc).toHaveBeenCalledWith(
      "close_housecall_export_for_manual_handling",
      expect.objectContaining({
        p_payload_hash: input.payloadHash,
        p_evidence: [
          expect.objectContaining({
            step_id: "step",
            payload_hash: t.step.payload_hash,
            updated_at: t.step.updated_at,
            outcome: "present",
            external_id: "material",
            observed: expect.objectContaining({ quantity: 1.01 }),
          }),
        ],
      }),
    );
    expect(t.step.payload.line.qty).toBe(1.005);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["absent", "duplicate", "changed_success"])(
    "rejects %s provider evidence before any resolution commit",
    async (kind) => {
      const t = setup();
      if (kind === "absent") t.client.listJobInputMaterials.mockResolvedValue([]);
      if (kind === "duplicate")
        t.client.listJobInputMaterials.mockResolvedValue([t.material, t.material]);
      if (kind === "changed_success") {
        t.step.status = "succeeded";
        t.step.external_id = "old_id";
      }
      await expect(t.run()).rejects.toMatchObject({ code: "reconciliation_required" });
      expect(t.rpc).not.toHaveBeenCalled();
    },
  );
  it("allows absence only for a step that was never dispatched", async () => {
    const t = setup();
    t.step.status = "ready";
    t.step.dispatch_count = 0;
    t.client.listJobInputMaterials.mockResolvedValue([]);
    expect(await t.run()).toMatchObject({ closed: true });
  });
  it.each(["active", "outside_scope", "reads_disabled"])(
    "blocks %s before reading Housecall",
    async (kind) => {
      const t = setup();
      if (kind === "active") t.step.status = "in_progress";
      if (kind === "outside_scope") t.intent.attachment_job_ids.push("job_real");
      if (kind === "reads_disabled") vi.stubEnv("HOUSECALL_READS_ENABLED", "false");
      await expect(t.run()).rejects.toBeDefined();
      expect(t.client.getJob).not.toHaveBeenCalled();
      expect(t.rpc).not.toHaveBeenCalled();
    },
  );
});
