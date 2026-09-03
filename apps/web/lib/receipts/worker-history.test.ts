import { describe, expect, it } from "vitest";
import {
  decodeRecentReceiptCursor,
  encodeRecentReceiptCursor,
  normalizeReadability,
  recentReceiptCursorFilter,
  workerStatusForStoredReceipt,
} from "./worker-history";

const cursor = {
  submittedAt: "2026-09-03T12:34:56.000Z",
  id: "8BB96A3A-7A5C-4EC8-B4CF-B5A7463D78C1",
};

describe("worker receipt history helpers", () => {
  it("round-trips an opaque, bounded cursor and produces a stable tie-break filter", () => {
    const encoded = encodeRecentReceiptCursor(cursor);
    expect(encoded).not.toContain(cursor.id);
    expect(decodeRecentReceiptCursor(encoded)).toEqual({
      ...cursor,
      id: cursor.id.toLowerCase(),
    });
    const decoded = decodeRecentReceiptCursor(encoded);
    expect(decoded).not.toBeNull();
    if (!decoded) throw new Error("cursor should decode");
    expect(recentReceiptCursorFilter(decoded)).toBe(
      "submitted_at.lt.2026-09-03T12:34:56.000Z,and(submitted_at.eq.2026-09-03T12:34:56.000Z,id.lt.8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1)",
    );
  });

  it("rejects malformed, oversized, and non-UUID cursors", () => {
    expect(decodeRecentReceiptCursor("not-base64-json")).toBeNull();
    expect(decodeRecentReceiptCursor("a".repeat(513))).toBeNull();
    expect(
      decodeRecentReceiptCursor(
        Buffer.from(
          JSON.stringify({ version: 1, submittedAt: cursor.submittedAt, id: "receipt-1" }),
        ).toString("base64url"),
      ),
    ).toBeNull();
  });

  it("maps only canonical stored statuses and normalizes safe readability evidence", () => {
    expect(workerStatusForStoredReceipt("processing")).toBe("sent");
    expect(workerStatusForStoredReceipt("failed")).toBe("declined");
    expect(() => workerStatusForStoredReceipt("needs_clarification")).toThrow(
      "receipt_status_invalid",
    );
    expect(
      normalizeReadability({
        receipt_id: cursor.id,
        readable: false,
        failed_page_indexes: [1, -1, 2.5],
        reasons: ["glare", "provider-secret"],
        created_at: cursor.submittedAt,
      }),
    ).toEqual({
      readable: false,
      failedPageIndexes: [1],
      reasons: [
        {
          code: "glare",
          guidance: "Tilt the phone or receipt until reflections move off the printed details.",
        },
      ],
      checkedAt: cursor.submittedAt,
    });
  });
});
