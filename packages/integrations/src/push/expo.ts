import { isExpoPushToken } from "@svl/domain";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export type ReceiptNeedsRetakePushData = {
  type: "receipt_needs_retake";
  receiptId: string;
  route: string;
};

export type ExpoPushTicket = {
  id: string | null;
};

export class ExpoPushError extends Error {
  readonly kind: "retryable" | "permanent";
  readonly code: string;

  constructor(kind: "retryable" | "permanent", code: string) {
    super(code);
    this.name = "ExpoPushError";
    this.kind = kind;
    this.code = code;
  }
}

export async function sendReceiptNeedsRetakePush(input: {
  token: string;
  receiptId: string;
  accessToken?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<ExpoPushTicket> {
  const token = input.token.trim();
  if (!isExpoPushToken(token)) {
    throw new ExpoPushError("permanent", "invalid_push_token");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  let response: Response;
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    const accessToken = input.accessToken?.trim();
    if (accessToken) {
      headers.authorization = `Bearer ${accessToken}`;
    }
    response = await (input.fetch ?? globalThis.fetch)(EXPO_PUSH_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        to: token,
        sound: "default",
        title: "Receipt needs a retake",
        body: "Open SVL to review the pages that need another photo.",
        data: {
          type: "receipt_needs_retake",
          receiptId: input.receiptId,
          route: `/(tabs)/recent?receiptId=${encodeURIComponent(input.receiptId)}`,
        } satisfies ReceiptNeedsRetakePushData,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new ExpoPushError(
      "retryable",
      cause instanceof Error && cause.name === "AbortError" ? "push_timeout" : "push_unavailable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw response.status === 429 || response.status >= 500
      ? new ExpoPushError("retryable", "push_unavailable")
      : new ExpoPushError("permanent", "push_rejected");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ExpoPushError("retryable", "push_invalid_response");
  }
  const rawTicket = (payload as { data?: unknown } | null)?.data;
  const ticket = Array.isArray(rawTicket) ? rawTicket[0] : rawTicket;
  if (!ticket || typeof ticket !== "object") {
    throw new ExpoPushError("retryable", "push_invalid_response");
  }
  const candidate = ticket as {
    status?: unknown;
    id?: unknown;
    details?: { error?: unknown };
  };
  if (candidate.status === "error") {
    throw candidate.details?.error === "DeviceNotRegistered"
      ? new ExpoPushError("permanent", "device_not_registered")
      : new ExpoPushError("permanent", "push_rejected");
  }
  if (candidate.status !== "ok") {
    throw new ExpoPushError("retryable", "push_invalid_response");
  }
  return { id: typeof candidate.id === "string" ? candidate.id : null };
}
