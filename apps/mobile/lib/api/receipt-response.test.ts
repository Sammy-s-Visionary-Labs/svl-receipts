import { describe, expect, it } from "vitest";
import {
  parseReceiptReadabilityStatus,
  parseRecentReceiptsResponse,
  parseWorkerReceiptDetail,
} from "./receipt-response";

const id = "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c1";

describe("receipt API response parsing", () => {
  it("accepts normalized readability evidence", () => {
    expect(
      parseReceiptReadabilityStatus({
        status: "rejected_unreadable",
        readability: {
          readable: false,
          failedPageIndexes: [1],
          reasons: [{ code: "glare", guidance: "Tilt the receipt." }],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toEqual({
      status: "rejected_unreadable",
      readability: {
        readable: false,
        failedPageIndexes: [1],
        reasons: [{ code: "glare", guidance: "Tilt the receipt." }],
        checkedAt: "2026-09-01T18:00:00.000Z",
      },
    });
  });

  it("rejects contradictory or unknown readability evidence", () => {
    expect(
      parseReceiptReadabilityStatus({
        status: "processing",
        readability: {
          readable: true,
          failedPageIndexes: [0],
          reasons: [],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toBeNull();
    expect(
      parseReceiptReadabilityStatus({
        status: "processing",
        readability: {
          readable: false,
          failedPageIndexes: [0],
          reasons: [{ code: "vendor_secret_reason", guidance: "Try again." }],
          checkedAt: "2026-09-01T18:00:00.000Z",
        },
      }),
    ).toBeNull();
  });

  it("accepts the bounded recent-receipts envelope and rejects invalid ids", () => {
    expect(
      parseRecentReceiptsResponse({
        receipts: [
          {
            id,
            status: "processing",
            workerStatus: "sent",
            pageCount: 2,
            thumbnail: {
              url: "https://storage.example/first.jpg?token=short-lived",
              expiresAt: "2026-09-01T17:56:00.000Z",
            },
            submittedAt: "2026-09-01T17:55:00.000Z",
            readability: null,
          },
        ],
        nextCursor: "opaque-cursor",
      }),
    ).toEqual({
      receipts: [
        {
          id,
          status: "processing",
          workerStatus: "sent",
          pageCount: 2,
          thumbnail: {
            url: "https://storage.example/first.jpg?token=short-lived",
            expiresAt: "2026-09-01T17:56:00.000Z",
          },
          submittedAt: "2026-09-01T17:55:00.000Z",
          readability: null,
        },
      ],
      nextCursor: "opaque-cursor",
    });
    expect(
      parseRecentReceiptsResponse({
        receipts: [
          {
            id: "not-a-receipt",
            status: "processing",
            workerStatus: "sent",
            pageCount: 1,
            thumbnail: null,
            submittedAt: null,
            readability: null,
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
  });

  it("accepts ordered read-only detail and rejects unordered pages", () => {
    const detail = {
      id,
      status: "rejected_unreadable",
      workerStatus: "needs_retake",
      submittedAt: "2026-09-01T17:55:00.000Z",
      readability: {
        readable: false,
        failedPageIndexes: [1],
        reasons: [{ code: "glare", guidance: "Tilt the receipt." }],
        checkedAt: "2026-09-01T18:00:00.000Z",
      },
      pages: [
        {
          pageIndex: 0,
          image: {
            url: "https://storage.example/one.jpg",
            expiresAt: "2026-09-01T18:01:00.000Z",
          },
        },
        {
          pageIndex: 1,
          image: {
            url: "https://storage.example/two.jpg",
            expiresAt: "2026-09-01T18:01:00.000Z",
          },
        },
      ],
    };
    expect(parseWorkerReceiptDetail(detail)).toEqual(detail);
    expect(
      parseWorkerReceiptDetail({ ...detail, clarification: "Confirm the quantity" })?.clarification,
    ).toBe("Confirm the quantity");
    expect(
      parseWorkerReceiptDetail({ ...detail, clarification: "a".repeat(2001) })?.clarification,
    ).toBeUndefined();
    expect(parseWorkerReceiptDetail({ ...detail, pages: [...detail.pages].reverse() })).toBeNull();
  });

  it("keeps a new upload visible alongside older records without photo pages", () => {
    const uploaded = {
      id,
      status: "needs_review",
      workerStatus: "in_review",
      pageCount: 1,
      thumbnail: null,
      submittedAt: "2026-09-11T17:19:42.796605+00:00",
      readability: null,
    };
    const older = {
      ...uploaded,
      id: "8bb96a3a-7a5c-4ec8-b4cf-b5a7463d78c2",
      pageCount: 0,
      submittedAt: "2026-09-08T17:52:04.354443+00:00",
    };
    const response = { receipts: [uploaded, older], nextCursor: "older-page" };

    expect(parseRecentReceiptsResponse(response)).toEqual(response);
  });

  it("accepts ten-page history and ordered detail through page index nine", () => {
    const record = {
      id,
      status: "needs_review",
      workerStatus: "in_review",
      submittedAt: null,
      readability: null,
    };
    const history = { receipts: [{ ...record, pageCount: 10, thumbnail: null }], nextCursor: null };
    expect(parseRecentReceiptsResponse(history)).toEqual(history);
    const detail = {
      ...record,
      pages: Array.from({ length: 10 }, (_, pageIndex) => ({
        pageIndex,
        image: {
          url: `https://storage.example/${pageIndex}.jpg`,
          expiresAt: "2026-09-01T18:01:00.000Z",
        },
      })),
    };
    expect(parseWorkerReceiptDetail(detail)).toEqual(detail);
    const firstPage = detail.pages[0];
    if (!firstPage) throw new Error("Missing synthetic page");
    expect(
      parseWorkerReceiptDetail({
        ...detail,
        pages: [...detail.pages, { ...firstPage, pageIndex: 10 }],
      }),
    ).toBeNull();
    expect(
      parseWorkerReceiptDetail({ ...detail, pages: [{ ...firstPage, pageIndex: 10 }] }),
    ).toBeNull();
  });

  it.each([-1, 1.5, 11, "0"])("rejects an invalid history page count of %s", (pageCount) => {
    expect(
      parseRecentReceiptsResponse({
        receipts: [
          {
            id,
            status: "needs_review",
            workerStatus: "in_review",
            pageCount,
            thumbnail: null,
            submittedAt: null,
            readability: null,
          },
        ],
        nextCursor: null,
      }),
    ).toBeNull();
  });
});
