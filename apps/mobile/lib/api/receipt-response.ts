import {
  isReadabilityReason,
  isReceiptStatus,
  isWorkerFacingStatus,
  type ReadabilityReason,
  type ReceiptStatus,
  type WorkerFacingStatus,
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
  workerStatus: WorkerFacingStatus;
  pageCount: number;
  thumbnail: SignedReceiptImage | null;
};

export type SignedReceiptImage = { url: string; expiresAt: string };

export type RecentReceiptsPage = {
  receipts: RecentReceipt[];
  nextCursor: string | null;
};

export type WorkerReceiptDetail = ReceiptReadabilityStatus & {
  id: string;
  submittedAt: string | null;
  workerStatus: WorkerFacingStatus;
  pages: Array<{ pageIndex: number; image: SignedReceiptImage }>;
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

function parseSignedImage(value: unknown): SignedReceiptImage | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const image = value as Record<string, unknown>;
  if (
    typeof image.url !== "string" ||
    !/^https?:\/\//.test(image.url) ||
    typeof image.expiresAt !== "string" ||
    Number.isNaN(Date.parse(image.expiresAt))
  ) {
    return undefined;
  }
  return { url: image.url, expiresAt: image.expiresAt };
}

export function parseRecentReceiptsResponse(value: unknown): RecentReceiptsPage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const envelope = value as Record<string, unknown>;
  const receipts = envelope.receipts;
  if (!Array.isArray(receipts) || receipts.length > 25) {
    return null;
  }
  if (
    envelope.nextCursor !== null &&
    (typeof envelope.nextCursor !== "string" || envelope.nextCursor.length === 0)
  ) {
    return null;
  }
  const parsed = receipts.map((receipt) => {
    if (!receipt || typeof receipt !== "object") {
      return null;
    }
    const candidate = receipt as Record<string, unknown>;
    const status = parseReceiptReadabilityStatus(candidate);
    const submittedAt = candidate.submittedAt;
    const thumbnail = parseSignedImage(candidate.thumbnail);
    if (
      !status ||
      typeof candidate.id !== "string" ||
      !RECEIPT_ID_PATTERN.test(candidate.id) ||
      typeof candidate.workerStatus !== "string" ||
      !isWorkerFacingStatus(candidate.workerStatus) ||
      typeof candidate.pageCount !== "number" ||
      !Number.isInteger(candidate.pageCount) ||
      candidate.pageCount < 1 ||
      candidate.pageCount > 5 ||
      thumbnail === undefined ||
      (submittedAt !== null &&
        (typeof submittedAt !== "string" || Number.isNaN(Date.parse(submittedAt))))
    ) {
      return null;
    }
    return {
      id: candidate.id,
      submittedAt,
      workerStatus: candidate.workerStatus,
      pageCount: candidate.pageCount,
      thumbnail,
      ...status,
    } as RecentReceipt;
  });
  return parsed.some((receipt) => receipt === null)
    ? null
    : {
        receipts: parsed as RecentReceipt[],
        nextCursor: envelope.nextCursor as string | null,
      };
}

export function parseWorkerReceiptDetail(value: unknown): WorkerReceiptDetail | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const rawStatus = candidate.status;
  const readability = parseReadability(candidate.readability);
  const submittedAt = candidate.submittedAt;
  if (
    readability === undefined ||
    (rawStatus !== undefined &&
      rawStatus !== null &&
      (typeof rawStatus !== "string" || !isReceiptStatus(rawStatus))) ||
    typeof candidate.id !== "string" ||
    !RECEIPT_ID_PATTERN.test(candidate.id) ||
    typeof candidate.workerStatus !== "string" ||
    !isWorkerFacingStatus(candidate.workerStatus) ||
    (submittedAt !== null &&
      (typeof submittedAt !== "string" || Number.isNaN(Date.parse(submittedAt)))) ||
    !Array.isArray(candidate.pages) ||
    candidate.pages.length < 1 ||
    candidate.pages.length > 5
  ) {
    return null;
  }
  const pages = candidate.pages.map((value) => {
    if (!value || typeof value !== "object") return null;
    const page = value as Record<string, unknown>;
    const image = parseSignedImage(page.image);
    return typeof page.pageIndex === "number" &&
      Number.isInteger(page.pageIndex) &&
      page.pageIndex >= 0 &&
      page.pageIndex < 5 &&
      image
      ? { pageIndex: page.pageIndex, image }
      : null;
  });
  if (pages.some((page) => page === null)) return null;
  const typedPages = pages as Array<{ pageIndex: number; image: SignedReceiptImage }>;
  if (
    typedPages.some((page, index) => {
      const previous = typedPages[index - 1];
      return previous ? page.pageIndex <= previous.pageIndex : false;
    })
  ) {
    return null;
  }
  return {
    id: candidate.id,
    submittedAt,
    workerStatus: candidate.workerStatus,
    pages: typedPages,
    status: (rawStatus ?? null) as ReceiptStatus | null,
    readability,
  } as WorkerReceiptDetail;
}
