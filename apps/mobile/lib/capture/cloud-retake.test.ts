import { describe, expect, it } from "vitest";
import { planCloudRetake } from "./cloud-retake";

describe("planCloudRetake", () => {
  it("keeps every valid failed page when the original capture is still open", () => {
    expect(
      planCloudRetake({
        receiptId: "receipt-1",
        currentReceiptId: "receipt-1",
        pageCount: 3,
        failedPageIndexes: [2, 0, 2, 9],
        hasUnsentDraft: false,
      }),
    ).toEqual({
      kind: "replace_pages",
      indexes: [0, 2],
      warnBeforeReplacingDraft: false,
    });
  });

  it("requires confirmation before an older receipt replaces an unsent draft", () => {
    expect(
      planCloudRetake({
        receiptId: "older-receipt",
        currentReceiptId: null,
        pageCount: 2,
        failedPageIndexes: [0],
        hasUnsentDraft: true,
      }),
    ).toEqual({
      kind: "restart_receipt",
      indexes: [],
      warnBeforeReplacingDraft: true,
    });
  });
});
