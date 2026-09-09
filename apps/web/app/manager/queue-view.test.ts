import { describe, expect, it } from "vitest";
import { DEFAULT_QUEUE_FILTERS } from "@/lib/manager/queue-contract";
import {
  activeFilterCount,
  confidenceLabel,
  filtersFromSearch,
  money,
  queueSearch,
  receiptAge,
  warningLabel,
} from "./queue-view";

describe("manager queue URL state", () => {
  it("opens the needs-review queue oldest first and bounds unsupported deep links", () => {
    expect(filtersFromSearch(new URLSearchParams())).toEqual(DEFAULT_QUEUE_FILTERS);
    const filters = filtersFromSearch(
      new URLSearchParams({
        tab: "anything",
        status: "upload_pending",
        sort: "random",
        limit: "100",
        search: "x".repeat(200),
      }),
    );
    expect(filters.tab).toBe("needs-review");
    expect(filters.status).toBe("all");
    expect(filters.sort).toBe("oldest");
    expect(filters.limit).toBe(25);
    expect(filters.search).toHaveLength(120);
    expect(filtersFromSearch(new URLSearchParams({ limit: "2" })).limit).toBe(2);
  });

  it("preserves all active filters and an opaque cursor across a URL round trip", () => {
    const filters = {
      ...DEFAULT_QUEUE_FILTERS,
      tab: "completed" as const,
      sort: "newest" as const,
      status: "exported" as const,
      age: "over-7d" as const,
      submitter: "11111111-1111-4111-8111-111111111111",
      vendor: "A & B #1",
      confidence: "low" as const,
      duplicate: "unmarked" as const,
      housecall: "succeeded" as const,
      search: "Invoice / #1",
      from: "2026-08-01",
      to: "2026-08-31",
      limit: 50,
    };
    const search = new URLSearchParams(queueSearch(filters, "opaque+/=cursor"));
    expect(filtersFromSearch(search)).toEqual(filters);
    expect(search.get("cursor")).toBe("opaque+/=cursor");
    expect(activeFilterCount(filters)).toBe(9);
    expect(queueSearch(DEFAULT_QUEUE_FILTERS)).toBe("");
  });
});

describe("honest receipt summaries", () => {
  it("distinguishes an unavailable reference total from a zero-value receipt", () => {
    expect(money(null)).toBe("Total unavailable");
    expect(money(Number.NaN)).toBe("Total unavailable");
    expect(money(0)).toBe("$0.00");
    expect(money(12345)).toBe("$123.45");
  });

  it("never presents missing or invalid confidence as a measured result", () => {
    for (const value of [null, -1, 1.1, Number.NaN])
      expect(confidenceLabel(value)).toBe("Unavailable");
    expect(confidenceLabel(0)).toBe("Low confidence");
    expect(confidenceLabel(0.799)).toBe("Low confidence");
    expect(confidenceLabel(0.8)).toBe("High confidence");
    expect(warningLabel("No job suggestion")).toBe("No job suggestion");
  });

  it("handles future clocks, malformed dates, and day boundaries in receipt age", () => {
    const now = Date.parse("2026-09-07T12:00:00Z");
    expect(receiptAge("invalid", now)).toBe("Age unavailable");
    expect(receiptAge("2026-09-08T12:00:00Z", now)).toBe("Just now");
    expect(receiptAge("2026-09-07T11:59:00Z", now)).toBe("1m ago");
    expect(receiptAge("2026-09-06T12:01:00Z", now)).toBe("23h ago");
    expect(receiptAge("2026-09-06T12:00:00Z", now)).toBe("1d ago");
  });
});
