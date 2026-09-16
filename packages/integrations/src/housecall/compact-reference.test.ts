import { expect, it } from "vitest";
import { prepareMaterialWrite, verifyPreparedHousecallWrite } from "./payloads";

it("keeps new material descriptions readable and references unique and deterministic", async () => {
  const input = {
    jobId: "job_test",
    intentId: "intent_a",
    receiptId: "receipt_a",
    receiptLineId: "line_a",
    description: "River rock",
    approvedReference: "Sandman #459854 2026-09-14",
    quantity: 1,
    unitCostCents: 7500,
  };
  const old = await prepareMaterialWrite(input);
  const compact = await prepareMaterialWrite({ ...input, formatVersion: 2 });
  expect(old.reference).toBe("SVL:intent_a:line_a");
  expect(old.body.job_input_materials[0]?.description).toContain("Receipt receipt_a");
  expect(compact.body.job_input_materials[0]?.description).toBe(input.approvedReference);
  expect(compact.reference).toMatch(/^SVL-[0-9a-f]{24}$/);
  expect(compact).toEqual(await prepareMaterialWrite({ ...input, formatVersion: 2 }));
  expect(compact.reference).not.toBe(
    (await prepareMaterialWrite({ ...input, receiptLineId: "line_b", formatVersion: 2 })).reference,
  );
  expect(compact.requestHash).not.toBe(old.requestHash);
  expect(await verifyPreparedHousecallWrite(compact)).toBe(true);
  const material = compact.body.job_input_materials[0];
  if (!material) throw new Error("Expected material");
  material.quantity = 2;
  expect(await verifyPreparedHousecallWrite(compact)).toBe(false);
});
