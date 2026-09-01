const RECEIPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function receiptNotificationRoute(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const value = data as Record<string, unknown>;
  if (
    value.type !== "receipt_needs_retake" ||
    typeof value.receiptId !== "string" ||
    !RECEIPT_ID_PATTERN.test(value.receiptId)
  ) {
    return null;
  }
  return `/(tabs)/recent?receiptId=${encodeURIComponent(value.receiptId)}`;
}

type ReceiptNotificationResponse = {
  actionIdentifier: string;
  notification: { request: { content: { data?: unknown } } };
};

export function consumeReceiptNotificationResponse(input: {
  response: ReceiptNotificationResponse;
  defaultActionIdentifier: string;
  openRoute(route: string): void;
  clearLastResponse(): void;
}): boolean {
  if (input.response.actionIdentifier !== input.defaultActionIdentifier) {
    return false;
  }
  const route = receiptNotificationRoute(input.response.notification.request.content.data);
  if (!route) {
    return false;
  }
  input.openRoute(route);
  input.clearLastResponse();
  return true;
}
