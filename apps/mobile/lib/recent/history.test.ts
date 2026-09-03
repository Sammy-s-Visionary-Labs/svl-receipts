import { describe, expect, it } from "vitest";
import type { RecentReceipt } from "@/lib/api/receipt-response";
import type { PendingReceiptQueueItem } from "@/lib/queue/pending";
import { appendRecentReceiptPage, mergeRecentHistory } from "./history";

const cloudReceipt = (id: string, submittedAt: string): RecentReceipt => ({
  id,
  status: "processing",
  workerStatus: "sent",
  submittedAt,
  pageCount: 2,
  thumbnail: null,
  readability: null,
});

const deviceReceipt = (id: string, createdAt: string): PendingReceiptQueueItem => ({
  version: 1,
  id,
  ownerUserId: "worker-1",
  status: "failed",
  pages: [{}, {}] as PendingReceiptQueueItem["pages"],
  sourcePages: null,
  filesReady: true,
  location: null,
  attempt: null,
  attemptCount: 1,
  nextAttemptAt: null,
  failureCategory: "network",
  confirmation: null,
  cleanupError: false,
  createdAt,
  updatedAt: createdAt,
});

describe("recent receipt history", () => {
  it("merges local delivery state with cloud history newest first", () => {
    const device = deviceReceipt("local-1", "2026-09-03T12:02:00.000Z");
    const result = mergeRecentHistory({
      cloud: [cloudReceipt("cloud-1", "2026-09-03T12:01:00.000Z")],
      device: [device],
      devicePreviewUris: new Map([[device.id, "file:///preview.jpg"]]),
    });
    expect(
      result.map(({ id, workerStatus, pageCount, thumbnailUri }) => ({
        id,
        workerStatus,
        pageCount,
        thumbnailUri,
      })),
    ).toEqual([
      {
        id: "local-1",
        workerStatus: "failed",
        pageCount: 2,
        thumbnailUri: "file:///preview.jpg",
      },
      { id: "cloud-1", workerStatus: "sent", pageCount: 2, thumbnailUri: null },
    ]);
  });

  it("lets confirmed cloud state replace a matching queued receipt", () => {
    const device = {
      ...deviceReceipt("queue-1", "2026-09-03T12:02:00.000Z"),
      attempt: {
        clientSubmissionId: "client-1",
        receiptId: "cloud-1",
        checksums: [],
        uploadedPageIndexes: [],
        session: null,
      },
    };
    expect(
      mergeRecentHistory({
        cloud: [cloudReceipt("cloud-1", "2026-09-03T12:03:00.000Z")],
        device: [device],
      }),
    ).toHaveLength(1);
    expect(
      mergeRecentHistory({
        cloud: [cloudReceipt("cloud-1", "2026-09-03T12:03:00.000Z")],
        device: [device],
      })[0],
    ).toMatchObject({ source: "cloud", workerStatus: "sent" });
  });

  it("appends a page without duplicating a receipt", () => {
    const older = cloudReceipt("older", "2026-09-02T12:00:00.000Z");
    const updated = { ...older, workerStatus: "approved" as const };
    expect(
      appendRecentReceiptPage(
        [older],
        [updated, cloudReceipt("oldest", "2026-09-01T12:00:00.000Z")],
      ),
    ).toEqual([updated, expect.objectContaining({ id: "oldest" })]);
  });
});
