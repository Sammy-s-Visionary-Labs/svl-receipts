import { describe, expect, it } from "vitest";
import { extractionFieldLabel, groupExtractionWarnings, jobLabel } from "./presentation";

describe("review presentation", () => {
  it("uses the same human label without exposing opaque job IDs", () => {
    expect(jobLabel({ id: "job_abc123", label: "Matt Acton", number: "1975" })).toBe(
      "Matt Acton #1975",
    );
    expect(jobLabel({ id: "job_abc123", label: "Matt Acton #1975", number: "1975" })).toBe(
      "Matt Acton #1975",
    );
    expect(
      jobLabel({ id: "job_abc123", label: "job_abc123", customer: "Matt Acton", number: "1975" }),
    ).toBe("Matt Acton #1975");
    expect(jobLabel({ id: "job_abc123", label: "job_abc123" })).not.toContain("job_abc123");
  });
  it("groups repeated warnings but preserves all affected fields", () => {
    const groups = groupExtractionWarnings(
      [
        "receipt_total_cents",
        "lines.0.printed_extended_cost_cents",
        "lines.1.printed_extended_cost_cents",
        "receipt_total_cents",
      ].map((field) => ({ field, code: "invalid_money", message: "Check amount" })),
    );
    expect(groups).toEqual([
      {
        code: "invalid_money",
        message: "Check amount",
        fields: ["Receipt total", "Material 1: Line total", "Material 2: Line total"],
      },
    ]);
    expect(extractionFieldLabel("lines.2.job_hint")).toBe("Material 3: Job name");
  });
});
