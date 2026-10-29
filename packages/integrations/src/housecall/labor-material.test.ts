import { describe, expect, it, vi } from "vitest";
import { createHousecallClient } from "./client";
import {
  type LaborMaterialInput,
  type LaborMaterialLegacyInput,
  type LaborMaterialTotalCostInput,
  prepareLaborMaterialWrite,
} from "./labor-material";
import { HOUSECALL_ORIGIN, prepareMaterialWrite, verifyPreparedHousecallWrite } from "./payloads";
import type { HousecallWritePermit, PreparedMaterialWrite } from "./types";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const input = (extra: Partial<LaborMaterialLegacyInput> = {}): LaborMaterialLegacyInput => ({
  jobId: "job_test_labor",
  snapshotHash: "a".repeat(64),
  period: { from: "2026-09-24", to: "2026-09-30" },
  hours: 2.5,
  workers: [
    { workerName: "TEST Worker B", hours: 1.25 },
    { workerName: "TEST Worker A", hours: 1.25 },
  ],
  costPolicy: "hours_only_zero_placeholder",
  unitCostCents: 0,
  ...extra,
});
const totalCostInput = (
  extra: Partial<LaborMaterialTotalCostInput> = {},
): LaborMaterialTotalCostInput => ({
  jobId: "job_test_labor",
  snapshotHash: "c".repeat(64),
  period: { from: "2026-09-24", to: "2026-09-30" },
  costPolicy: "approved_total_cost",
  hours: 14.5,
  paidHours: 13.5,
  regularHours: 11,
  overtimeHours: 2.5,
  totalCostCents: 52437,
  // Synthetic costs have already been rounded by the reviewed server estimator.
  // Its odd-cent test rate creates half-cent overtime; this builder must not
  // derive a new blended rate or recalculate those approved component amounts.
  workers: [
    {
      workerName: "TEST Worker B",
      hours: 6,
      paidHours: 5.5,
      regularHours: 4,
      overtimeHours: 1.5,
      costCents: 22219,
    },
    {
      workerName: "TEST Worker A",
      hours: 8.5,
      paidHours: 8,
      regularHours: 7,
      overtimeHours: 1,
      costCents: 30218,
    },
  ],
  ...extra,
});
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const job = (extra = {}) => ({
  id: "job_test_labor",
  work_status: "scheduled",
  description: "TEST labor destination",
  customer: { id: "customer_test", first_name: "TEST", last_name: "Customer" },
  ...extra,
});
const permit = (write: PreparedMaterialWrite, extra: Partial<HousecallWritePermit> = {}) => ({
  approvalId: "approval_test",
  approvedBy: "manager_test",
  approvedAt: new Date(NOW - 1000).toISOString(),
  expiresAt: new Date(NOW + 60_000).toISOString(),
  jobId: write.jobId,
  expectedCustomerId: "customer_test",
  requestHash: write.requestHash,
  ...extra,
});
function client(transport: ReturnType<typeof vi.fn>, allowedWriteJobIds: string[] = []) {
  return createHousecallClient({
    apiKey: "synthetic-key",
    fetch: transport as typeof fetch,
    allowedWriteJobIds,
    now: () => NOW,
  });
}

describe("approved labor Job Inputs > Materials preparation", () => {
  it("prepares one exact hours row with an explicit zero-cost placeholder and traceable snapshot", async () => {
    const write = await prepareLaborMaterialWrite(input());
    expect(write).toMatchObject({
      kind: "job_cost",
      jobId: "job_test_labor",
      method: "PUT",
      path: "/jobs/job_test_labor/job_input_materials/bulk_update",
      reference: `SVL-LAB-${"a".repeat(24)}`,
    });
    expect(write.body.job_input_materials).toHaveLength(1);
    expect(write.body.job_input_materials[0]).toEqual({
      name: "Labor hours (2026-09-24 to 2026-09-30)",
      description:
        "Hours-only record: unit cost is an approved $0 placeholder, not payroll or calculated labor cost. " +
        "Period: 2026-09-24 through 2026-09-30. " +
        "Workers: TEST Worker A: 1.25h; TEST Worker B: 1.25h. " +
        `Approval snapshot: ${"a".repeat(64)}. Reference: SVL-LAB-${"a".repeat(24)}.`,
      part_number: `SVL-LAB-${"a".repeat(24)}`,
      quantity: 2.5,
      unit_cost: 0,
    });
    expect(await verifyPreparedHousecallWrite(write)).toBe(true);
    // No uuid is sent: the documented operation adds one new job-input entry.
    expect(write.body.job_input_materials[0]).not.toHaveProperty("uuid");
    expect(write.body.job_input_materials[0]).not.toHaveProperty("category");
  });

  it("keeps a stable request for the same frozen snapshot regardless of rollup order", async () => {
    const original = input();
    const first = await prepareLaborMaterialWrite(original);
    const reversed = await prepareLaborMaterialWrite({
      ...original,
      workers: [...original.workers].reverse(),
    });
    expect(reversed).toEqual(first);
    const changed = await prepareLaborMaterialWrite(input({ snapshotHash: "b".repeat(64) }));
    expect(changed.reference).not.toBe(first.reference);
    expect(changed.requestHash).not.toBe(first.requestHash);
  });

  it.each([0, -1, 1.005, Number.NaN, Number.POSITIVE_INFINITY])(
    "blocks unsupported total hours %s without rounding",
    async (hours) => {
      await expect(prepareLaborMaterialWrite(input({ hours }))).rejects.toThrow("labor hours");
    },
  );

  it("requires positive exact worker quantities and conserves the approved rollup", async () => {
    await expect(
      prepareLaborMaterialWrite(input({ workers: [{ workerName: "TEST Worker", hours: 2.49 }] })),
    ).rejects.toThrow("do not match");
    await expect(
      prepareLaborMaterialWrite(input({ workers: [{ workerName: "TEST Worker", hours: 2.505 }] })),
    ).rejects.toThrow("Invalid approved worker hours");
    await expect(prepareLaborMaterialWrite(input({ workers: [] }))).rejects.toThrow("rollup");
    await expect(
      prepareLaborMaterialWrite(
        input({
          workers: [
            { workerName: "TEST Worker", hours: 1.25 },
            { workerName: " test worker ", hours: 1.25 },
          ],
        }),
      ),
    ).rejects.toThrow("Duplicate worker");
  });

  it.each([
    { costPolicy: undefined },
    { unitCostCents: undefined },
    { unitCostCents: -1 },
    { unitCostCents: 0.5 },
    { unitCostCents: 1 },
    { costPolicy: "approved_unit_cost", unitCostCents: 0 },
  ])("requires an explicit matching cost policy %o", async (change) => {
    await expect(
      prepareLaborMaterialWrite({ ...input(), ...change } as LaborMaterialInput),
    ).rejects.toThrow("explicit matching cost policy");
  });

  it("uses only an explicitly supplied nonzero unit cost, with no payroll inference", async () => {
    const write = await prepareLaborMaterialWrite(
      input({
        costPolicy: "approved_unit_cost",
        unitCostCents: 1234,
      }),
    );
    expect(write.body.job_input_materials[0]?.unit_cost).toBe(1234);
    expect(write.body.job_input_materials[0]?.description).toContain("explicitly approved");
    expect(write.body.job_input_materials[0]?.description).not.toContain("$0 placeholder");
    await expect(
      prepareLaborMaterialWrite(
        input({
          costPolicy: "approved_unit_cost",
          unitCostCents: 2_147_483_647,
        }),
      ),
    ).rejects.toThrow("cost exceeds limit");
  });

  it("blocks invalid dates, snapshot references and overlong descriptions instead of truncating", async () => {
    await expect(
      prepareLaborMaterialWrite(input({ period: { from: "2026-09-31", to: "2026-10-01" } })),
    ).rejects.toThrow("period");
    await expect(
      prepareLaborMaterialWrite(input({ period: { from: "2026-10-01", to: "2026-09-30" } })),
    ).rejects.toThrow("period");
    await expect(prepareLaborMaterialWrite(input({ snapshotHash: "unverified" }))).rejects.toThrow(
      "snapshot hash",
    );
    await expect(
      prepareLaborMaterialWrite(
        input({
          hours: 50,
          workers: Array.from({ length: 50 }, (_, i) => ({
            workerName: `TEST Worker ${i}`,
            hours: 1,
          })),
        }),
      ),
    ).rejects.toThrow("description limit");
  });
});

describe("labor materials use the existing bounded permits and exact reconciliation", () => {
  it("makes no requests without exact write authorization or after payload mutation", async () => {
    const write = await prepareLaborMaterialWrite(input());
    const transport = vi.fn();
    await expect(
      client(transport).executePreparedWrite(write, permit(write)),
    ).rejects.toMatchObject({
      code: "write_blocked",
    });
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write),
    ).rejects.toMatchObject({
      code: "write_blocked",
    });
    const grant = permit(write);
    const line = write.body.job_input_materials[0];
    if (!line) throw new Error("TEST fixture lacks the material row");
    line.quantity += 0.01;
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write, grant),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("sends one frozen row only after rechecking the approved job/customer, then verifies full readback", async () => {
    const write = await prepareLaborMaterialWrite(input());
    const row = write.body.job_input_materials[0];
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(job()))
      .mockResolvedValueOnce(json({ job_input_materials: [{ uuid: "input_test", ...row }] }))
      .mockResolvedValueOnce(json({ job_input_materials: [{ uuid: "input_test", ...row }] }));
    const adapter = client(transport, [write.jobId]);
    expect(await adapter.executePreparedWrite(write, permit(write))).toEqual({
      status: "accepted",
      httpStatus: 200,
    });
    expect(transport.mock.calls[1]).toEqual([
      `${HOUSECALL_ORIGIN}${write.path}`,
      expect.objectContaining({ method: "PUT", body: JSON.stringify(write.body) }),
    ]);
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "input_test",
    });
    expect(transport.mock.calls[2]?.[1]).toMatchObject({ method: "GET" });
  });

  it("does not send to a job reassigned to a different customer", async () => {
    const write = await prepareLaborMaterialWrite(input());
    const transport = vi.fn().mockResolvedValue(json(job({ customer: { id: "other_customer" } })));
    await expect(
      client(transport, [write.jobId]).executePreparedWrite(write, permit(write)),
    ).rejects.toMatchObject({ code: "unsafe_destination" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
  });

  it("keeps receipt and labor appends independent and leaves unrelated material rows untouched", async () => {
    const labor = await prepareLaborMaterialWrite(totalCostInput());
    const receipt = await prepareMaterialWrite({
      jobId: labor.jobId,
      intentId: "TEST_RECEIPT_INTENT",
      receiptId: "TEST_RECEIPT",
      receiptLineId: "TEST_LINE",
      description: "TEST receipt supplies",
      quantity: 2,
      unitCostCents: 1234,
      formatVersion: 3,
    });
    const unrelated = {
      uuid: "TEST_EXISTING",
      name: "Existing materials",
      description: "Original unrelated row",
      part_number: "ORIGINAL",
      quantity: 3,
      unit_cost: 4567,
    };
    const rows = [structuredClone(unrelated)];
    // This fixture models the published append-without-uuid contract. It proves
    // our request isolation, not the remote provider's concurrency guarantees.
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        const payload = JSON.parse(String(init.body));
        expect(payload.job_input_materials).toHaveLength(1);
        expect(payload.job_input_materials[0]).not.toHaveProperty("uuid");
        expect(payload.job_input_materials[0].part_number).not.toBe(unrelated.part_number);
        rows.push({ uuid: `TEST_CREATED_${rows.length}`, ...payload.job_input_materials[0] });
        return json({ job_input_materials: rows });
      }
      if (url.endsWith("/job_input_materials")) return json({ job_input_materials: rows });
      return json(job());
    });
    const adapter = client(transport, [labor.jobId]);
    await Promise.all([
      adapter.executePreparedWrite(labor, permit(labor, { approvalId: "TEST_LABOR_APPROVAL" })),
      adapter.executePreparedWrite(
        receipt,
        permit(receipt, { approvalId: "TEST_RECEIPT_APPROVAL" }),
      ),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(unrelated);
    expect(await adapter.reconcileWrite(labor)).toMatchObject({ status: "found" });
    expect(await adapter.reconcileWrite(receipt)).toMatchObject({ status: "found" });
    expect(transport.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(2);
  });

  it("detects missing or conflicting provider values and duplicate references without resending", async () => {
    const write = await prepareLaborMaterialWrite(input());
    const row = write.body.job_input_materials[0];
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json({ job_input_materials: [] }))
      .mockResolvedValueOnce(
        json({ job_input_materials: [{ uuid: "input_test", ...row, quantity: 2.49 }] }),
      )
      .mockResolvedValueOnce(
        json({ job_input_materials: [{ uuid: "input_test", ...row, unit_cost: 1 }] }),
      )
      .mockResolvedValueOnce(json({ job_input_materials: [{ ...row }] }))
      .mockResolvedValueOnce(
        json({
          job_input_materials: [
            { uuid: "input_test", ...row },
            { uuid: "input_duplicate", ...row },
          ],
        }),
      );
    const adapter = client(transport);
    expect(await adapter.reconcileWrite(write)).toEqual({ status: "absent" });
    for (let i = 0; i < 3; i++) {
      expect(await adapter.reconcileWrite(write)).toEqual({
        status: "conflict",
        reason: "payload_mismatch",
      });
    }
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "conflict",
      reason: "duplicate_reference",
    });
    expect(transport.mock.calls.every((call) => call[1].method === "GET")).toBe(true);
  });

  it("reconciles a simulated committed write with a lost response and never repeats the PUT", async () => {
    const write = await prepareLaborMaterialWrite(input());
    let committed = false;
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === "PUT") {
        committed = true;
        return new Promise<Response>(() => {});
      }
      if (url.endsWith("/job_input_materials"))
        return json({
          job_input_materials: committed
            ? [{ uuid: "input_test", ...write.body.job_input_materials[0] }]
            : [],
        });
      return json(job());
    });
    const adapter = createHousecallClient({
      apiKey: "synthetic-key",
      fetch: transport as typeof fetch,
      allowedWriteJobIds: [write.jobId],
      timeoutMs: 5,
      now: () => NOW,
    });
    await expect(adapter.executePreparedWrite(write, permit(write))).rejects.toMatchObject({
      code: "timeout",
      writeOutcomeUnknown: true,
    });
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "input_test",
    });
    await expect(adapter.executePreparedWrite(write, permit(write))).rejects.toMatchObject({
      code: "write_blocked",
    });
    expect(transport.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(1);
  });
});

describe("approved total-cost labor input", () => {
  it("uses quantity one and exact approved cents while retaining all approved hour fields", async () => {
    const approved = totalCostInput();
    const write = await prepareLaborMaterialWrite(approved);
    const row = write.body.job_input_materials[0];
    expect(row).toMatchObject({
      name: "Labor - 13.50 paid hours (2026-09-24 to 2026-09-30)",
      part_number: `SVL-LAB-${"c".repeat(24)}`,
      quantity: 1,
      unit_cost: 52437,
    });
    expect(row?.description).toContain(
      "Gross allocated: 14.50h. Paid: 13.50h; regular: 11.00h; overtime: 2.50h.",
    );
    expect(row?.description).toContain(
      "TEST Worker A: gross 8.50h, paid 8.00h (7.00h regular/1.00h overtime), $302.18",
    );
    expect(row?.description).toContain(
      "TEST Worker B: gross 6.00h, paid 5.50h (4.00h regular/1.50h overtime), $222.19",
    );
    expect(row?.description).toContain(`Approval snapshot: ${"c".repeat(64)}`);
    expect(row?.description).not.toContain("placeholder");
    expect(await verifyPreparedHousecallWrite(write)).toBe(true);
    // A rounded blended rate loses cents; the frozen estimate must remain exact.
    expect(
      Math.round(approved.paidHours * Math.round(approved.totalCostCents / approved.paidHours)),
    ).not.toBe(approved.totalCostCents);
    expect(
      await prepareLaborMaterialWrite({ ...approved, workers: [...approved.workers].reverse() }),
    ).toEqual(write);
  });

  it("allows zero regular or overtime hours without inventing a cost or an hourly rate", async () => {
    const write = await prepareLaborMaterialWrite(
      totalCostInput({
        hours: 1,
        paidHours: 1,
        regularHours: 0,
        overtimeHours: 1,
        totalCostCents: 4321,
        workers: [
          {
            workerName: "TEST Worker",
            hours: 1,
            paidHours: 1,
            regularHours: 0,
            overtimeHours: 1,
            costCents: 4321,
          },
        ],
      }),
    );
    expect(write.body.job_input_materials[0]).toMatchObject({ quantity: 1, unit_cost: 4321 });
    expect(write.body.job_input_materials[0]?.description).toContain(
      "0.00h regular/1.00h overtime",
    );
  });

  it.each([
    { paidHours: 13.501 },
    { regularHours: -0.01 },
    { overtimeHours: Number.NaN },
    { totalCostCents: 52437.5 },
    { totalCostCents: -1 },
    { totalCostCents: 2_147_483_648 },
    { paidHours: undefined },
    { totalCostCents: undefined },
  ])("blocks invalid or missing frozen paid totals %o", async (change) => {
    await expect(
      prepareLaborMaterialWrite({ ...totalCostInput(), ...change } as LaborMaterialTotalCostInput),
    ).rejects.toThrow();
  });

  it("requires both aggregate and per-worker hour/cost conservation", async () => {
    await expect(prepareLaborMaterialWrite(totalCostInput({ paidHours: 13.49 }))).rejects.toThrow(
      "do not reconcile",
    );
    await expect(
      prepareLaborMaterialWrite(totalCostInput({ totalCostCents: 52436 })),
    ).rejects.toThrow("worker costs");
    const approved = totalCostInput();
    const workers = approved.workers.map((worker) => ({ ...worker }));
    const first = workers[0];
    if (!first) throw new Error("TEST fixture lacks a worker");
    first.regularHours -= 0.01;
    first.overtimeHours += 0.01;
    // Each worker still balances, but the aggregate regular/OT split now differs.
    await expect(prepareLaborMaterialWrite({ ...approved, workers })).rejects.toThrow(
      "regularHours",
    );
    first.paidHours = 6.01;
    first.regularHours = 6.01;
    first.overtimeHours = 0;
    await expect(prepareLaborMaterialWrite({ ...approved, workers })).rejects.toThrow(
      "worker paid",
    );
    first.paidHours = 5.5;
    first.regularHours = 4;
    first.overtimeHours = 1.5;
    first.costCents += 0.5;
    await expect(prepareLaborMaterialWrite({ ...approved, workers })).rejects.toThrow(
      "worker labor cost",
    );
  });

  it("blocks an oversized full-cost rollup without dropping workers or source detail", async () => {
    await expect(
      prepareLaborMaterialWrite(
        totalCostInput({
          hours: 20,
          paidHours: 20,
          regularHours: 20,
          overtimeHours: 0,
          totalCostCents: 20000,
          workers: Array.from({ length: 20 }, (_, i) => ({
            workerName: `TEST Worker ${i}`,
            hours: 1,
            paidHours: 1,
            regularHours: 1,
            overtimeHours: 0,
            costCents: 1000,
          })),
        }),
      ),
    ).rejects.toThrow("description limit");
  });

  it("sends and reconciles the exact total-cost row using the existing client contract", async () => {
    const write = await prepareLaborMaterialWrite(totalCostInput());
    const row = write.body.job_input_materials[0];
    const transport = vi
      .fn()
      .mockResolvedValueOnce(json(job()))
      .mockResolvedValueOnce(json({ job_input_materials: [{ uuid: "input_total_cost", ...row }] }))
      .mockResolvedValueOnce(json({ job_input_materials: [{ uuid: "input_total_cost", ...row }] }))
      .mockResolvedValueOnce(
        json({ job_input_materials: [{ uuid: "input_total_cost", ...row, unit_cost: 52436 }] }),
      );
    const adapter = client(transport, [write.jobId]);
    expect(await adapter.executePreparedWrite(write, permit(write))).toEqual({
      status: "accepted",
      httpStatus: 200,
    });
    expect(transport.mock.calls[1]?.[1]).toMatchObject({
      method: "PUT",
      body: JSON.stringify(write.body),
    });
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "found",
      providerId: "input_total_cost",
    });
    expect(await adapter.reconcileWrite(write)).toEqual({
      status: "conflict",
      reason: "payload_mismatch",
    });
    expect(transport.mock.calls.filter((call) => call[1].method === "PUT")).toHaveLength(1);
  });
});
