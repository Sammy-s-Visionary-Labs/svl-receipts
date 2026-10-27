import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createGeminiReceiptAdapter } from "../packages/integrations/src/vision/gemini-receipt";

const enabled = process.env.RECEIPT_CREDIT_LIVE_GEMINI === "1";
describe.runIf(enabled)("live synthetic receipt direction extraction", () => {
  it.each(["credit", "debit"] as const)(
    "recognizes %s while retaining printed signs",
    async (type) => {
      if (!process.env.GEMINI_API_KEY)
        throw new Error("GEMINI_API_KEY is required for the explicitly enabled live check");
      const text = [
        "SYNTHETIC TEST DOCUMENT - NOT A REAL PURCHASE",
        "SVL SYNTHETIC SUPPLY",
        type === "credit" ? "RETURN RECEIPT / CREDIT MEMO - REFUND" : "PURCHASE RECEIPT",
        "DATE 2026-10-27",
        "RECEIPT SYN-CREDIT-VERIFY-42",
        type === "credit"
          ? "Returned pipe  -2 EA x $25.00 = -$50.00"
          : "Purchased pipe  2 EA x $25.00 = $50.00",
        type === "credit" ? "SUBTOTAL -$50.00" : "SUBTOTAL $50.00",
        "SALES TAX $0.00",
        type === "credit" ? "REFUND TOTAL -$50.00" : "TOTAL $50.00",
        "PAYMENT METHOD: VISA CREDIT CARD",
        "USD",
      ];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1100"><rect width="100%" height="100%" fill="white"/><g font-family="monospace" font-size="30" fill="black">${text.map((value, index) => `<text x="40" y="${70 + index * 80}">${value}</text>`).join("")}</g></svg>`;
      const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      const result = await createGeminiReceiptAdapter({
        apiKey: process.env.GEMINI_API_KEY,
      }).parseReceipt([{ pageIndex: 0, mimeType: "image/png", bytes }]);
      expect(result.receipt.receipt_type).toBe(type);
      expect(result.receipt.material_total_cents).toBe(5000);
      expect(result.receipt.lines[0]).toMatchObject({ qty: 2, unit_cost_cents: 2500 });
    },
  );
});
