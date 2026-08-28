import { describe, expect, it } from "vitest";
import {
  isReadabilityCheckV1,
  READABILITY_SCHEMA_VERSION,
  type ReadabilityCheckV1,
} from "./readability";

describe("readability check v1", () => {
  it("accepts a readable result", () => {
    const value: ReadabilityCheckV1 = { schema_version: 1, readable: true };
    expect(isReadabilityCheckV1(value)).toBe(true);
    expect(READABILITY_SCHEMA_VERSION).toBe(1);
  });

  it("accepts an unreadable result with page indexes and reasons", () => {
    expect(
      isReadabilityCheckV1({
        schema_version: 1,
        readable: false,
        failed_page_indexes: [1],
        reasons: ["blurry", "too_dark"],
      }),
    ).toBe(true);
  });

  it("rejects vendor-shaped payloads and unknown versions", () => {
    expect(isReadabilityCheckV1({ readable: true })).toBe(false);
    expect(isReadabilityCheckV1({ schema_version: 2, readable: true })).toBe(false);
    expect(
      isReadabilityCheckV1({
        schema_version: 1,
        readable: false,
        failed_page_indexes: [0],
        reasons: ["gemini_BLOCKED"],
      }),
    ).toBe(false);
  });
});
