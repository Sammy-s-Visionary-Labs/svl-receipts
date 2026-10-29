export type ReceiptType = "debit" | "credit";
export type ReceiptTypeSelection = ReceiptType | "";
export const receiptTypeLabel = (value: ReceiptTypeSelection | undefined) =>
  value === "credit" ? "Credit" : value === "" ? "Review required" : "Debit";
export const receiptDirection = (value: ReceiptTypeSelection | undefined) =>
  value === "credit" ? -1 : 1;
