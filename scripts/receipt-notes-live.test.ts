import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createGeminiReceiptAdapter } from "../packages/integrations/src/vision/gemini-receipt";

describe.runIf(process.env.RECEIPT_NOTES_LIVE_GEMINI === "1")(
  "live synthetic material and note distinction",
  () => {
    it("keeps a customer pickup/job row out of materials while retaining the real cap and pickup fee", async () => {
      if (!process.env.GEMINI_API_KEY)
        throw new Error("GEMINI_API_KEY is required for this opt-in live check");
      const rows = [
        ["1.00", "Customer Pick Up - Job Orchard", "", ""],
        ["1.00", "CAP64 6 IN FOUR SIDED CAP", "85.00", "85.00"],
        ["1.00", "Customer pickup service fee", "5.00", "5.00"],
      ];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1300">
      <rect width="100%" height="100%" fill="white"/>
      <g font-family="monospace" font-size="29" fill="black">
      <text x="45" y="65">SYNTHETIC TEST INVOICE - NOT A REAL TRANSACTION</text>
      <text x="45" y="125">SYNTHETIC CONCRETE SUPPLY</text>
      <text x="45" y="185">INVOICE SYN-NOTE-42   DATE 2026-10-27   USD</text>
      <text x="45" y="245">Bill to: Synthetic Landscaping</text>
      <text x="45" y="305">Ship to: Customer Pick Up</text>
      <text x="45" y="400">ITEM QTY</text><text x="265" y="400">ITEM DESCRIPTION</text>
      <text x="1260" y="400">UNIT PRICE</text><text x="1510" y="400">AMOUNT</text>
      ${rows.map((row, index) => row.map((text, column) => `<text x="${[45, 265, 1260, 1510][column]}" y="${480 + index * 95}">${text}</text>`).join("")).join("")}
      <text x="1150" y="850">SUBTOTAL 90.00</text><text x="1150" y="930">TAX 0.00</text>
      <text x="1150" y="1010">TOTAL 90.00</text><text x="45" y="1120">PAID WITH VISA CREDIT CARD</text>
      </g></svg>`;
      const bytes = await sharp(Buffer.from(svg)).png().toBuffer();
      const result = await createGeminiReceiptAdapter({
        apiKey: process.env.GEMINI_API_KEY,
      }).parseReceipt([{ pageIndex: 0, mimeType: "image/png", bytes }]);
      expect(result.receipt.receipt_type).toBe("debit");
      expect(result.receipt.lines).toHaveLength(2);
      expect(
        result.receipt.lines.some((line) => /four sided cap/i.test(line.description ?? "")),
      ).toBe(true);
      expect(
        result.receipt.lines.some((line) => /pickup service fee/i.test(line.description ?? "")),
      ).toBe(true);
      expect(
        result.receipt.lines.some((line) =>
          /customer.*pick.*up.*job/i.test(line.description ?? ""),
        ),
      ).toBe(false);
      expect(result.receipt.material_total_cents).toBe(9000);
      expect(
        result.receipt.lines.find((line) => /four sided cap/i.test(line.description ?? "")),
      ).toMatchObject({ qty: 1, unit_cost_cents: 8500, extended_cost_cents: 8500 });
      expect(
        result.receipt.lines.find((line) => /pickup service fee/i.test(line.description ?? "")),
      ).toMatchObject({ qty: 1, unit_cost_cents: 500, extended_cost_cents: 500 });
      expect(result.receipt.job_hints.some((hint) => /orchard/i.test(hint.text))).toBe(true);
    });
  },
);
