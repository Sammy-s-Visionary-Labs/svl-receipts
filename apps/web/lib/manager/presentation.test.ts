import { describe, expect, it } from "vitest";
import {
  extractionFieldLabel,
  groupExtractionWarnings,
  jobLabel,
  jobMetadata,
} from "./presentation";

describe("review presentation", () => {
  it("explains provider job metadata without displaying technician IDs or raw timestamps", () => {
    const label = jobMetadata({
      status: "complete unrated",
      scheduledAt: "2026-08-19T12:00:00+00:00",
      technicians: ["pro_b9ce7babfc374608859d9c1271270e57", "pro_6c0fd6d2fa8041d49f684879c5b86aca"],
      syncedAt: "2026-10-27T09:23:23.413+00:00",
    });
    expect(label).toBe(
      "Completed (unrated) · Scheduled Aug 19, 2026, 8:00 AM · Technician names unavailable · Last checked Oct 27, 2026, 5:23 AM",
    );
    expect(label).not.toMatch(/pro_|T12:00|\+00:00/);
  });
  it("keeps known technician names and marks unresolved assignments honestly", () => {
    expect(
      jobMetadata({
        status: "in_progress",
        technicians: ["Marcy Kuehnle", "Marcy Kuehnle", "pro_12345"],
      }),
    ).toBe(
      "In progress · Schedule unavailable · Technicians: Marcy Kuehnle · Some technician names unavailable",
    );
    expect(jobMetadata({ status: "scheduled", technicians: ["Sam Kale"] })).toBe(
      "Scheduled · Schedule unavailable · Technicians: Sam Kale",
    );
  });
  it("only calls a missing schedule unscheduled when the job status explicitly says so", () => {
    expect(jobMetadata({ status: "needs scheduling" })).toBe(
      "Needs scheduling · Unscheduled · Technician names unavailable",
    );
    expect(jobMetadata({ status: "completed" })).toBe(
      "Completed · Schedule unavailable · Technician names unavailable",
    );
  });
  it("does not print invalid dates or opaque technician identifiers", () => {
    expect(
      jobMetadata({
        status: "",
        scheduledAt: "invalid-date",
        syncedAt: "invalid-sync",
        technicians: ["a2700000-0000-4000-8000-000000000003"],
      }),
    ).toBe("Status unavailable · Schedule unavailable · Technician names unavailable");
  });
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
    expect(jobLabel({ label: "Custom job", customer: "Matt Acton", number: "1975" })).toBe(
      "Matt Acton · Custom job #1975",
    );
    expect(
      jobLabel({ label: "Purshottam Singh #1990", customer: "Purshottam Singh", number: "1990" }),
    ).toBe("Purshottam Singh #1990");
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
