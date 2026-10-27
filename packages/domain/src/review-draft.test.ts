import { describe, expect, it } from "vitest";
import {
  decimalUnits,
  EMPTY_REVIEW,
  lineCostCents,
  type ReviewDraft,
  type ReviewLine,
  reviewSummary,
  validateReview,
} from "./review-draft";

const line: ReviewLine = {
  description: "Copper",
  qty: "1.005",
  uom: "ft",
  unitCost: "1.00",
  jobId: "job-a",
};
const draft: ReviewDraft = {
  ...EMPTY_REVIEW,
  vendor: "Supply",
  purchaseDate: "2026-09-07",
  category: "Materials",
  referenceTotal: "999.00",
  lines: [line],
};
describe("review money and validation", () => {
  it("applies credit direction once while keeping entered values and quantities unchanged", () => {
    const credit = {
      ...draft,
      receiptType: "credit" as const,
      lines: [{ ...line, qty: "1.5", unitCost: "2.51" }],
    };
    expect(validateReview(credit, true)).toEqual({});
    expect(reviewSummary(credit).totalCents).toBe(-377);
    expect(lineCostCents({ ...line, qty: "1.5", unitCost: "2.51" }, "credit")).toBe(-377);
    expect(credit.lines[0]?.unitCost).toBe("2.51");
    expect(reviewSummary({ ...credit, receiptType: "debit" }).totalCents).toBe(377);
    expect(validateReview({ ...credit, receiptType: "" }, true).receiptType).toBeTruthy();
  });
  it("retains three-decimal evidence in a draft but blocks approval without rounding", () => {
    expect(validateReview(draft)).toEqual({});
    expect(validateReview(draft, true)["lines.0.qty"]).toContain("will not be rounded");
    expect(draft.lines[0]?.qty).toBe("1.005");
    expect(validateReview({ ...draft, lines: [{ ...line, qty: "0.5" }] }, true)).toEqual({});
  });
  it.each([
    ["1.005", "1.00", 101],
    ["0.125", "1.00", 13],
    ["2.5", "19.99", 4998],
    ["3", "0.00", 0],
    ["0.001", "0.01", 0],
    ["0", "19.99", 0],
  ])("rounds %s × %s deterministically", (qty, unitCost, expected) =>
    expect(lineCostCents({ ...line, qty, unitCost })).toBe(expected),
  );
  it.each(["-1", "1e3", "1,000", "NaN", "Infinity", "1.0001", " 1"])(
    "rejects invalid quantity %s",
    (qty) =>
      expect(
        validateReview({ ...draft, lines: [{ ...line, qty }] }, true)["lines.0.qty"],
      ).toBeTruthy(),
  );
  it.each(["0", "0.0", "0.00", "0.000"])(
    "saves zero quantity %s, excludes its destination, and exports zero-cost materials",
    (qty) => {
      const zero = { ...line, qty, unitCost: "0", jobId: "" };
      const free = { ...line, qty: "2", unitCost: "0.00" };
      const reviewed = { ...draft, lines: [zero, free] };
      expect(validateReview(reviewed)).toEqual({});
      expect(validateReview(reviewed, true)).toEqual({});
      expect(reviewSummary(reviewed)).toMatchObject({
        lineCount: 2,
        exportLineCount: 1,
        excludedLineCount: 1,
        jobCount: 1,
        totalCents: 0,
        jobs: [{ id: "job-a", lines: 1, totalCents: 0 }],
      });
      expect(validateReview({ ...draft, lines: [zero] }, true).lines).toContain("above zero");
    },
  );
  it.each(["-1", "1.001", "1e2", "Infinity", "21474836.48"])(
    "rejects invalid unit cost %s",
    (unitCost) =>
      expect(
        validateReview({ ...draft, lines: [{ ...line, unitCost }] }, true)["lines.0.unitCost"],
      ).toBeTruthy(),
  );
  it("allows incomplete drafts but blocks approval", () => {
    expect(validateReview(EMPTY_REVIEW)).toEqual({});
    expect(Object.keys(validateReview(EMPTY_REVIEW, true))).toEqual(
      expect.arrayContaining(["vendor", "purchaseDate", "category", "lines"]),
    );
  });
  it("rejects impossible dates and accepts leap dates", () => {
    expect(validateReview({ ...draft, purchaseDate: "2026-02-29" }).purchaseDate).toBeTruthy();
    expect(validateReview({ ...draft, purchaseDate: "2024-02-29" })).toEqual({});
  });
  it("requires every job and description", () => {
    expect(
      validateReview({ ...draft, lines: [{ ...line, jobId: "", description: "" }] }, true),
    ).toMatchObject({
      "lines.0.jobId": expect.any(String),
      "lines.0.description": expect.any(String),
    });
  });
  it("splits by immutable ID and excludes reference total", () => {
    expect(reviewSummary({ ...draft, lines: [line, { ...line, jobId: "job-b" }] })).toMatchObject({
      lineCount: 2,
      jobCount: 2,
      totalCents: 202,
    });
  });
  it("rejects extended and aggregate overflow", () => {
    expect(lineCostCents({ ...line, qty: "999999999", unitCost: "21474836.47" })).toBeNull();
    expect(
      validateReview(
        { ...draft, lines: [{ ...line, qty: "1", unitCost: "21474836.47" }, line] },
        true,
      ).lines,
    ).toBeTruthy();
  });
  it("parses exact scaled decimal units", () => expect(decimalUnits("0.125", 3)).toBe(125));
});
