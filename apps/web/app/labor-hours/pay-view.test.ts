import { describe, expect, it } from "vitest";
import { parseHourlyRateCents } from "./pay-view";

describe("hourly rate input", () => {
  it("keeps an unspecified rate distinct from a confirmed zero rate", () => {
    expect(parseHourlyRateCents("")).toBeNull();
    expect(parseHourlyRateCents("  ")).toBeNull();
    expect(parseHourlyRateCents("0.00")).toBe(0);
  });

  it("preserves cents in confirmed rates", () => {
    expect(parseHourlyRateCents("28.85")).toBe(2885);
    expect(parseHourlyRateCents(" 24 ")).toBe(2400);
    expect(parseHourlyRateCents("26.5")).toBe(2650);
    expect(parseHourlyRateCents(".85")).toBe(85);
  });

  it("rejects excess precision, negative values and non-dollar notation", () => {
    for (const value of ["28.855", "-1", "1e2", "NaN", "1,000", "9007199254740992"])
      expect(() => parseHourlyRateCents(value)).toThrow();
  });
});
