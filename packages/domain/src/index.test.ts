import { describe, expect, it } from "vitest";
import {
  DOMAIN_PACKAGE,
  EXTRACTION_SCHEMA_VERSION,
  extendedCostCents,
  HOUSECALL_PAYLOAD_VERSION,
  isExtractionV1,
  isTerminalReceiptStatus,
  parseExtractionV1,
  parseHousecallIntentV1,
  resolveReceiptStatus,
} from "./index";

describe("@svl/domain", () => {
  it("exports the package identity constant", () => {
    expect(DOMAIN_PACKAGE).toBe("@svl/domain");
  });

  it("pins extraction and housecall contract versions at 1", () => {
    expect(EXTRACTION_SCHEMA_VERSION).toBe(1);
    expect(HOUSECALL_PAYLOAD_VERSION).toBe(1);
  });
});

describe("receipt status", () => {
  it("maps legacy aliases to canonical statuses", () => {
    expect(resolveReceiptStatus("uploaded")).toBe("submitted");
    expect(resolveReceiptStatus("parsed")).toBe("processing");
    expect(resolveReceiptStatus("pending_review")).toBe("needs_review");
    expect(resolveReceiptStatus("needs_review")).toBe("needs_review");
  });

  it("rejects unknown status strings instead of guessing", () => {
    expect(resolveReceiptStatus("totally_made_up")).toBeNull();
  });

  it("identifies terminal statuses", () => {
    expect(isTerminalReceiptStatus("exported")).toBe(true);
    expect(isTerminalReceiptStatus("needs_review")).toBe(false);
  });
});

describe("money", () => {
  it("computes extended cost in integer cents", () => {
    expect(extendedCostCents(2, 1995)).toBe(3990);
    expect(extendedCostCents(1.5, 100)).toBe(150);
  });

  it("rejects non-integer unit costs", () => {
    expect(() => extendedCostCents(1, 10.5)).toThrow(/integer/);
  });
});

describe("extraction v1 parsing", () => {
  const valid = {
    schema_version: 1 as const,
    provider: "gemini" as const,
    vendor: "Select",
    lines: [{ description: "pipe", qty: 2, unit_cost_cents: 500 }],
    confidence: { vendor: 0.9 },
  };

  it("accepts a valid v1 payload", () => {
    expect(isExtractionV1(valid)).toBe(true);
    expect(parseExtractionV1(valid)).toEqual(valid);
  });

  it("rejects future or missing schema versions (backward-compatible rule)", () => {
    expect(parseExtractionV1({ ...valid, schema_version: 2 })).toBeNull();
    expect(parseExtractionV1({ provider: "gemini", lines: [], confidence: {} })).toBeNull();
  });
});

describe("housecall intent v1 parsing", () => {
  const valid = {
    payload_version: 1 as const,
    receipt_id: "rcp_1",
    attachment_job_ids: ["job_a"],
    job_cost_lines: [
      {
        job_id: "job_a",
        description: "Select #123 8.5.26",
        qty: 1,
        unit_cost_cents: 2500,
      },
    ],
  };

  it("accepts a valid v1 intent", () => {
    expect(parseHousecallIntentV1(valid)).toEqual(valid);
  });

  it("rejects unknown payload versions", () => {
    expect(parseHousecallIntentV1({ ...valid, payload_version: 99 })).toBeNull();
  });
});
