import type { ReceiptUploadFailureCategory } from "@svl/domain";

export class UploadTransportError extends Error {
  readonly category: Exclude<ReceiptUploadFailureCategory, "unknown">;

  constructor(category: UploadTransportError["category"], message: string) {
    super(message);
    this.name = "UploadTransportError";
    this.category = category;
  }
}
