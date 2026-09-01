import { describe, expect, it } from "vitest";
import { parseReceiptReadabilityStatus, parseRecentReceiptsResponse } from "./receipt-response";

const id = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1";

describe("receipt API response parsing", () => {
  it("accepts normalized readability evidence", () => {
    expect(
      parseReceiptReadabilityStatus({
        status: "rejected_unreadable",
        readability: {
          readable: false,
          failedPageIndexes: [1],
          reasons: [{ code: "glare", guidance: "Tilt the receipt." }],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toEqual({
      status: "rejected_unreadable",
      readability: {
        readable: false,
        failedPageIndexes: [1],
        reasons: [{ code: "glare", guidance: "Tilt the receipt." }],
        checkedAt: "2026-09-01T18:00:00.000Z",
      },
    });
  });

  it("rejects contradictory or unknown readability evidence", () => {
    expect(
      parseReceiptReadabilityStatus({
        status: "processing",
        readability: {
          readable: true,
          failedPageIndexes: [0],
          reasons: [],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toBeNull();
    expect(
      parseReceiptReadabilityStatus({
        status: "processing",
        readability: {
          readable: false,
          failedPageIndexes: [0],
          reasons: [{ code: "vendor_secret_reason", guidance: "Try again." }],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toBeNull();
  });

  it("accepts the bounded recent-receipts envelope and rejects invalid ids", () => {
    expect(
      parseRecentReceiptsResponse({
        receipts: [
          {
            id,
            status: "processing",
            submittedAt: "2026-09-01T17:55:00.000Z",
            readability: null,
          },
        ],
      }),
    ).toEqual([
      {
        id,
        status: "processing",
        submittedAt: "2026-09-01T17:55:00.000Z",
        readability: null,
      },
    ]);
    expect(
      parseRecentReceiptsResponse({
        receipts: [
          { id: "not-a-receipt", status: "processing", submittedAt: null, readability: null },
        ],
      }),
    ).toBeNull();
  });
});
