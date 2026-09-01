import { describe, expect, it, vi } from "vitest";
import { type ExpoPushError, sendReceiptNeedsRetakePush } from "./expo";

const token = "ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
const receiptId = "779c1a21-ecf3-4edc-b0d3-7bf673ebf712";

describe("Expo receipt push", () => {
  it("sends only safe retake data with the Recent deep link", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.data).toEqual({
        type: "receipt_needs_retake",
        receiptId,
        route: `/(tabs)/recent?receiptId=${receiptId}`,
      });
      expect(JSON.stringify(body)).not.toMatch(/blurry|vendor|price|reason/i);
      expect(init?.headers).toMatchObject({ authorization: "Bearer push-access-token" });
      return Response.json({ data: { status: "ok", id: "ticket-1" } });
    });

    await expect(
      sendReceiptNeedsRetakePush({
        token,
        receiptId,
        accessToken: "push-access-token",
        fetch: request,
      }),
    ).resolves.toEqual({ id: "ticket-1" });
  });

  it("identifies an unregistered device so callers can remove its token", async () => {
    await expect(
      sendReceiptNeedsRetakePush({
        token,
        receiptId,
        fetch: async () =>
          Response.json({
            data: {
              status: "error",
              details: { error: "DeviceNotRegistered" },
            },
          }),
      }),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "device_not_registered",
    } satisfies Partial<ExpoPushError>);
  });

  it("treats service throttling as retryable", async () => {
    await expect(
      sendReceiptNeedsRetakePush({
        token,
        receiptId,
        fetch: async () => new Response(null, { status: 429 }),
      }),
    ).rejects.toMatchObject({
      kind: "retryable",
      code: "push_unavailable",
    } satisfies Partial<ExpoPushError>);
  });
});
