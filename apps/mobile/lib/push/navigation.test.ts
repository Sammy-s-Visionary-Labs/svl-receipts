import { describe, expect, it } from "vitest";
import { consumeReceiptNotificationResponse, receiptNotificationRoute } from "./navigation";

describe("receiptNotificationRoute", () => {
  it("builds the canonical Recent route for a retake notification", () => {
    expect(
      receiptNotificationRoute({
        type: "receipt_needs_retake",
        receiptId: "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1",
        route: "/untrusted/value",
      }),
    ).toBe("/(tabs)/recent?receiptId=8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1");
  });

  it("rejects unknown notification types and invalid receipt ids", () => {
    expect(
      receiptNotificationRoute({
        type: "receipt_needs_retake",
        receiptId: "../../profile",
      }),
    ).toBeNull();
    expect(
      receiptNotificationRoute({
        type: "other",
        receiptId: "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1",
      }),
    ).toBeNull();
  });

  it("consumes a default tap once and ignores custom actions", () => {
    const opened: string[] = [];
    let clearCount = 0;
    const response = {
      actionIdentifier: "default",
      notification: {
        request: {
          content: {
            data: {
              type: "receipt_needs_retake",
              receiptId: "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1",
            },
          },
        },
      },
    };
    expect(
      consumeReceiptNotificationResponse({
        response,
        defaultActionIdentifier: "default",
        openRoute: (route) => opened.push(route),
        clearLastResponse: () => {
          clearCount += 1;
        },
      }),
    ).toBe(true);
    expect(opened).toHaveLength(1);
    expect(clearCount).toBe(1);

    expect(
      consumeReceiptNotificationResponse({
        response: { ...response, actionIdentifier: "dismiss" },
        defaultActionIdentifier: "default",
        openRoute: (route) => opened.push(route),
        clearLastResponse: () => {
          clearCount += 1;
        },
      }),
    ).toBe(false);
    expect(opened).toHaveLength(1);
    expect(clearCount).toBe(1);
  });
});
