import { describe, expect, it } from "vitest";
import { isExtractionV1 } from "./extraction";
import {
  normalizeReceiptDate,
  normalizeReceiptMoney,
  normalizeReceiptObservation,
  normalizeReceiptQuantity,
  normalizeReceiptUnit,
} from "./receipt-normalization";
import {
  isParsedReceiptV1,
  isReceiptObservationV1,
  parseParsedReceiptV1,
  type ReceiptObservationV1,
} from "./receipt-parse";

function first<T>(values: T[]): T {
  const item = values[0];
  if (!item) throw new Error("empty fixture");
  return item;
}

function observedReceipt(overrides: Partial<ReceiptObservationV1> = {}): ReceiptObservationV1 {
  return {
    schema_version: 1,
    document_kind: "receipt",
    vendor: "Select",
    purchase_date: "2026-08-28",
    invoice_number: "SYN-001",
    ticket_number: null,
    receipt_total: "162.00",
    tax: "12.00",
    subtotal: "150.00",
    currency: "USD",
    lines: [
      {
        page_index: 0,
        description: "Pipe",
        qty: "2.5",
        uom: "each",
        unit_cost: "60.00",
        extended_cost: "150.00",
        job_hint: "Sullivan",
      },
    ],
    job_hints: [{ text: "Sullivan", page_index: 0 }],
    raw_text: "SYNTHETIC TEST FIXTURE Select Pipe 2.5 @ 60.00 Sullivan",
    evidence: [{ field: "vendor", text: "Select", page_index: 0, confidence: 0.95 }],
    ...overrides,
  };
}

describe("strict extraction boundaries", () => {
  it("preserves legacy v1 while rejecting malformed dates, values and confidence", () => {
    const valid = {
      schema_version: 1,
      provider: "gemini",
      lines: [{ description: "Pipe", qty: 1.25, unit_cost_cents: 100 }],
      confidence: { vendor: 0.9 },
    };
    expect(isExtractionV1(valid)).toBe(true);
    for (const change of [
      { provider: "invented" },
      { purchase_date: "2026-02-30" },
      { confidence: [] },
      { confidence: { vendor: NaN } },
      { tax_cents: "100" },
      { lines: [{ description: "Pipe", qty: "1", unit_cost_cents: 100 }] },
    ])
      expect(isExtractionV1({ ...valid, ...change })).toBe(false);
  });
  it("rejects coercion, extra fields, invalid confidence, page indexes and future schemas", () => {
    const valid = observedReceipt();
    expect(isReceiptObservationV1(valid, 1)).toBe(true);
    expect(isReceiptObservationV1({ ...valid, schema_version: 2 }, 1)).toBe(false);
    expect(isReceiptObservationV1({ ...valid, receipt_total: 162 }, 1)).toBe(false);
    expect(isReceiptObservationV1({ ...valid, export_job_id: "forged" }, 1)).toBe(false);
    expect(
      isReceiptObservationV1(
        { ...valid, evidence: [{ ...valid.evidence[0], confidence: 1.01 }] },
        1,
      ),
    ).toBe(false);
    expect(
      isReceiptObservationV1(
        { ...valid, evidence: [{ ...valid.evidence[0], field: "lines.1.qty" }] },
        1,
      ),
    ).toBe(false);
    expect(
      isReceiptObservationV1({ ...valid, lines: [{ ...valid.lines[0], page_index: 1 }] }, 1),
    ).toBe(false);
  });
  it("validates stored normalized result versions and nullable incomplete lines", () => {
    const result = normalizeReceiptObservation(observedReceipt());
    expect(isParsedReceiptV1(result)).toBe(true);
    expect(parseParsedReceiptV1({ ...result, schema_version: 2 })).toBeNull();
    expect(parseParsedReceiptV1({ ...result, tax_cents: "1200" })).toBeNull();
    expect(parseParsedReceiptV1({ ...result, purchase_date: "2026-02-30" })).toBeNull();
    expect(parseParsedReceiptV1({ ...result, confidence: { vendor: 1.01 } })).toBeNull();
    expect(
      parseParsedReceiptV1({ ...result, lines: [{ ...result.lines[0], qty: "2.5" }] }),
    ).toBeNull();
  });
});

describe("deterministic US receipt normalization", () => {
  it("normalizes decimal money without floating point rounding or permissive coercion", () => {
    expect(normalizeReceiptMoney("$1,234.56")).toEqual({ value: 123456 });
    expect(normalizeReceiptMoney("USD 0.29")).toEqual({ value: 29 });
    for (const value of ["1,23.45", "1.005", "1e3", "12junk", "€12.00", "1.234,56", "", null])
      expect(normalizeReceiptMoney(value).value).toBeNull();
    expect(normalizeReceiptMoney("-10.00").issue).toBe("unsupported_return");
    expect(normalizeReceiptMoney("21474836.48").issue).toBe("amount_out_of_range");
  });
  it("uses positive thousandth quantities and preserves unknown units", () => {
    expect(normalizeReceiptQuantity("6.090").value).toBe(6.09);
    for (const value of ["0", "1.0001", "2 tons", "1e2", "1/2"])
      expect(normalizeReceiptQuantity(value).value).toBeNull();
    expect(normalizeReceiptUnit("Tons").value).toBe("ton");
    expect(normalizeReceiptUnit("cu yd").value).toBe("yd3");
    expect(normalizeReceiptUnit("Cans").value).toBe("can");
    expect(normalizeReceiptUnit("mystery")).toEqual({ value: "mystery", issue: "unknown_unit" });
    expect(normalizeReceiptUnit("__proto__")).toEqual({
      value: "__proto__",
      issue: "unknown_unit",
    });
  });
  it("rejects ambiguous and impossible dates without assuming a century", () => {
    expect(normalizeReceiptDate("03/04/2026").issue).toBe("ambiguous_date");
    expect(normalizeReceiptDate("03/04/26").issue).toBe("ambiguous_date");
    expect(normalizeReceiptDate("03/04/2026", "MDY").value).toBe("2026-03-04");
    expect(normalizeReceiptDate("03/04/2026", "DMY").value).toBe("2026-04-03");
    expect(normalizeReceiptDate("08/28/2026").value).toBe("2026-08-28");
    expect(normalizeReceiptDate("2026-02-30").value).toBeNull();
    expect(normalizeReceiptDate("February 29, 2024").value).toBe("2024-02-29");
    expect(normalizeReceiptDate("Sept. 8, 2026").value).toBe("2026-09-08");
    expect(normalizeReceiptDate("Marching 1 2026").issue).toBe("invalid_date");
    expect(normalizeReceiptDate("00/01/2026").issue).toBe("invalid_date");
  });
  it.each([
    ["Select", "2.500", "Tons", "$40.00", "100.00", 10000, "ton"],
    ["Sandman", "6.090", "TON", "24.70", "150.42", 15042, "ton"],
    ["Klumm", "1.75", "tn", "60.00", "105.00", 10500, "ton"],
    ["Menards", "4", "EA", "$9.99", "39.96", 3996, "ea"],
    ["Lowe's", "12", "feet", "USD 1.25", "15.00", 1500, "ft"],
    ["Home Depot", "2", "each", "46.00", "92.00", 9200, "ea"],
    ["Perrysburg Pipe", "1,000", "LF", "0.29", "290.00", 29000, "ft"],
  ] as const)(
    "runs the synthetic %s format regression independently of genuine vendor accuracy",
    (vendor, qty, uom, unit_cost, extended_cost, expectedCents, expectedUom) => {
      const base = observedReceipt();
      const receipt = normalizeReceiptObservation(
        observedReceipt({
          vendor,
          subtotal: extended_cost,
          receipt_total: extended_cost,
          tax: "0",
          lines: [{ ...first(base.lines), qty, uom, unit_cost, extended_cost }],
        }),
      );
      expect(receipt.vendor).toBe(vendor);
      expect(receipt.material_total_cents).toBe(expectedCents);
      expect(receipt.receipt_total_cents).toBe(expectedCents);
      expect(receipt.lines[0]?.extended_cost_cents).toBe(expectedCents);
      expect(receipt.lines[0]?.uom).toBe(expectedUom);
      expect(receipt.job_hints[0]?.text).toBe("Sullivan");
    },
  );
  it("flags arithmetic mismatches and retains printed values without including tax in material cost", () => {
    const observation = observedReceipt({
      subtotal: "151.42",
      receipt_total: "161.42",
      tax: "10.00",
      lines: [
        {
          ...first(observedReceipt().lines),
          qty: "6.090",
          unit_cost: "24.70",
          extended_cost: "151.42",
        },
      ],
    });
    const result = normalizeReceiptObservation(observation);
    expect(result.material_total_cents).toBe(15042);
    expect(result.lines[0]?.printed_extended_cost_cents).toBe(15142);
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining([
        "line_total_mismatch",
        "subtotal_mismatch",
        "receipt_total_mismatch",
      ]),
    );
    expect(result.original_observation.lines[0]?.extended_cost).toBe("151.42");
    first(observation.lines).extended_cost = "changed";
    expect(result.original_observation.lines[0]?.extended_cost).toBe("151.42");
  });
  it("never promotes a tax or total line to material costs", () => {
    const base = observedReceipt();
    const result = normalizeReceiptObservation({
      ...base,
      lines: [
        ...base.lines,
        {
          ...first(base.lines),
          description: "Sales tax",
          qty: "1",
          unit_cost: "12.00",
          extended_cost: "12.00",
        },
      ],
    });
    expect(result.lines).toHaveLength(1);
    expect(result.material_total_cents).toBe(15000);
    expect(result.warnings.some((warning) => warning.code === "reference_line_excluded")).toBe(
      true,
    );
  });
  it("keeps incomplete lines editable, does not invent quantity/price, and blocks unsupported currency", () => {
    const base = observedReceipt();
    const result = normalizeReceiptObservation({
      ...base,
      purchase_date: "03/04/26",
      lines: [{ ...first(base.lines), qty: null, unit_cost: null }],
    });
    expect(result.lines[0]).toMatchObject({
      qty: null,
      unit_cost_cents: null,
      extended_cost_cents: null,
    });
    expect(result.material_total_cents).toBeNull();
    expect(result.purchase_date).toBeNull();
    expect(normalizeReceiptObservation({ ...base, currency: "EUR" })).toMatchObject({
      currency: null,
      material_total_cents: null,
      receipt_total_cents: null,
    });
  });
  it("preserves continuation-page attribution and distinct identical lines", () => {
    const base = observedReceipt();
    const result = normalizeReceiptObservation({
      ...base,
      subtotal: "300",
      tax: "24",
      receipt_total: "324",
      lines: [...base.lines, { ...first(base.lines), page_index: 1 }],
    });
    expect(result.lines.map((line) => [line.source_index, line.page_index])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(result.material_total_cents).toBe(30000);
    expect(result.warnings.some((warning) => warning.code.endsWith("mismatch"))).toBe(false);
  });
  it("flags picking lists, missing evidence and low confidence without unreadable status", () => {
    const base = observedReceipt();
    const result = normalizeReceiptObservation({
      ...base,
      document_kind: "picking_list",
      evidence: [{ ...first(base.evidence), confidence: 0.3 }],
    });
    expect(result.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(["document_requires_review", "low_confidence", "missing_evidence"]),
    );
    expect(result.confidence.vendor).toBe(0.3);
  });
  it("maps observed amount confidence to normalized fields without changing the original evidence", () => {
    const base = observedReceipt();
    const result = normalizeReceiptObservation({
      ...base,
      evidence: [
        ...base.evidence,
        { field: "receipt_total", text: "162.00", page_index: 0, confidence: 0.97 },
        { field: "lines.0.unit_cost", text: "60.00", page_index: 0, confidence: 0.82 },
      ],
    });
    expect(result.confidence.receipt_total_cents).toBe(0.97);
    expect(result.confidence["lines.0.unit_cost_cents"]).toBe(0.82);
    expect(result.evidence.some((item) => item.field === "receipt_total")).toBe(true);
    expect(
      result.warnings.some(
        (warning) => warning.code === "missing_evidence" && warning.field === "receipt_total_cents",
      ),
    ).toBe(false);
  });
});
