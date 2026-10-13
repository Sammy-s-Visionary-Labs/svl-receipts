import { describe, expect, it } from "vitest";
import { parseLaborJobComment } from "./labor-comment";

describe("daily labor job comments", () => {
  it("retains a complete normalized job name and recognizes the exported Other prefix", () => {
    for (const text of [
      "Christiansen",
      "  OTHER-Christiansen  ",
      "Other: Christiansen",
      "Other Christiansen",
    ])
      expect(parseLaborJobComment(text)).toEqual({
        sourceAlias: null,
        destinationAlias: "christiansen",
      });
    expect(parseLaborJobComment("  Johnson, Larry  & Jill  ")).toEqual({
      sourceAlias: null,
      destinationAlias: "johnson, larry & jill",
    });
  });

  it("recognizes the observed source-to-destination corrections without creating a global alias", () => {
    for (const text of [
      "Davis = Johnson",
      "OtherDavis = Johnson",
      "Other-Davis = Johnson",
      "Other-Davis is Johnson Job",
      "Davis IS Johnson",
    ])
      expect(parseLaborJobComment(text)).toEqual({
        sourceAlias: "davis",
        destinationAlias: "johnson",
      });
  });

  it("requires callers to match the whole extracted name, preserving additional words and multiple destinations", () => {
    const reviewed = new Set(["christiansen", "johnson"]);
    for (const text of [
      "Assign all hours to Christiansen",
      "Other-Christiansen and Johnson",
      "Christiansen / Johnson",
      "Christiansen yesterday",
      "Clock in 7:30. MWK took off lunch break",
      "Other-Davis is Johnson Job and Christiansen",
    ]) {
      const parsed = parseLaborJobComment(text);
      expect(parsed).not.toBeNull();
      expect(reviewed.has(parsed?.destinationAlias ?? "")).toBe(false);
    }
  });

  it("rejects empty and malformed corrections rather than selecting one destination", () => {
    for (const text of [
      "",
      "   ",
      "Other-",
      "Davis =",
      "= Johnson",
      "Davis = Johnson = Christiansen",
      "Davis is Johnson is Christiansen",
      "Davis = Johnson is Christiansen",
    ])
      expect(parseLaborJobComment(text)).toBeNull();
  });

  it("does not mistake a customer name beginning with Other for the exported category", () => {
    expect(parseLaborJobComment("Otherland")).toEqual({
      sourceAlias: null,
      destinationAlias: "otherland",
    });
  });
});
