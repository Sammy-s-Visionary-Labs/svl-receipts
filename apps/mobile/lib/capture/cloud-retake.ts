export type CloudRetakePlan =
  | { kind: "replace_pages"; indexes: number[]; warnBeforeReplacingDraft: false }
  | { kind: "restart_receipt"; indexes: []; warnBeforeReplacingDraft: boolean };

export function planCloudRetake(input: {
  receiptId: string;
  currentReceiptId: string | null;
  pageCount: number;
  failedPageIndexes: readonly number[];
  hasUnsentDraft: boolean;
}): CloudRetakePlan {
  const indexes = [...new Set(input.failedPageIndexes)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < input.pageCount)
    .sort((left, right) => left - right);
  if (input.currentReceiptId === input.receiptId && indexes.length > 0) {
    return { kind: "replace_pages", indexes, warnBeforeReplacingDraft: false };
  }
  return {
    kind: "restart_receipt",
    indexes: [],
    warnBeforeReplacingDraft: input.hasUnsentDraft && input.currentReceiptId !== input.receiptId,
  };
}
