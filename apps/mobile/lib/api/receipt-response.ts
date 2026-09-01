import {
  isReadabilityReason,
  isReceiptStatus,
  type ReadabilityReason,
  type ReceiptStatus,
} from "@svl/domain";

const RECEIPT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReceiptReadabilityEvidence = {
  readable: boolean;
  failedPageIndexes: number[];
  reasons: Array<{ code: ReadabilityReason; guidance: string }>;
  checkedAt: string;
};

export type ReceiptReadabilityStatus = {
  status: ReceiptStatus | null;
  readability: ReceiptReadabilityEvidence | null;
};

export type RecentReceipt = ReceiptReadabilityStatus & {
  id: string;
  submittedAt: string | null;
};

function parseReadability(value: unknown): ReceiptReadabilityEvidence | null | undefined {
  if (value === null) {
    return null;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.readable !== "boolean" ||
    !Array.isArray(candidate.failedPageIndexes) ||
    !Array.isArray(candidate.reasons) ||
    typeof candidate.checkedAt !== "string" ||
    Number.isNaN(Date.parse(candidate.checkedAt)) ||
    !candidate.failedPageIndexes.every(
      (index) => typeof index === "number" && Number.isInteger(index) && index >= 0,
    )
  ) {
    return undefined;
  }
  const reasons = candidate.reasons.map((reason) => {
    if (!reason || typeof reason !== "object") {
      return null;
    }
    const item = reason as Record<string, unknown>;
    return typeof item.code === "string" &&
      isReadabilityReason(item.code) &&
      typeof item.guidance === "string" &&
      item.guidance.trim().length > 0
      ? { code: item.code, guidance: item.guidance }
      : null;
  });
  if (reasons.some((reason) => reason === null)) {
    return undefined;
  }
  if (
    (candidate.readable &&
      (candidate.failedPageIndexes.length > 0 || candidate.reasons.length > 0)) ||
    (!candidate.readable &&
      (candidate.failedPageIndexes.length === 0 || candidate.reasons.length === 0))
  ) {
    return undefined;
  }
  return {
    readable: candidate.readable,
    failedPageIndexes: candidate.failedPageIndexes as number[],
    reasons: reasons as Array<{ code: ReadabilityReason; guidance: string }>,
    checkedAt: candidate.checkedAt,
  };
}

export function parseReceiptReadabilityStatus(value: unknown): ReceiptReadabilityStatus | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  const status = candidate.status;
  if (status !== null && (typeof status !== "string" || !isReceiptStatus(status))) {
    return null;
  }
  const readability = parseReadability(candidate.readability);
  if (readability === undefined) {
    return null;
  }
  return { status, readability } as ReceiptReadabilityStatus;
}

export function parseRecentReceiptsResponse(value: unknown): RecentReceipt[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const receipts = (value as Record<string, unknown>).receipts;
  if (!Array.isArray(receipts) || receipts.length > 25) {
    return null;
  }
  const parsed = receipts.map((receipt) => {
    if (!receipt || typeof receipt !== "object") {
      return null;
    }
    const candidate = receipt as Record<string, unknown>;
    const status = parseReceiptReadabilityStatus(candidate);
    const submittedAt = candidate.submittedAt;
    if (
      !status ||
      typeof candidate.id !== "string" ||
      !RECEIPT_ID_PATTERN.test(candidate.id) ||
      (submittedAt !== null &&
        (typeof submittedAt !== "string" || Number.isNaN(Date.parse(submittedAt))))
    ) {
      return null;
    }
    return {
      id: candidate.id,
      submittedAt,
      ...status,
    } as RecentReceipt;
  });
  return parsed.some((receipt) => receipt === null) ? null : (parsed as RecentReceipt[]);
}
