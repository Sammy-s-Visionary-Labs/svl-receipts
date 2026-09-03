import { type WorkerFacingStatus, workerStatusFromDeviceQueue } from "@svl/domain";
import type { ReceiptReadabilityEvidence, RecentReceipt } from "@/lib/api/receipt-response";
import type { PendingReceiptQueueItem } from "@/lib/queue/pending";

export type RecentHistoryItem = {
  id: string;
  source: "device" | "cloud";
  localQueueId: string | null;
  submittedAt: string | null;
  workerStatus: WorkerFacingStatus;
  pageCount: number;
  thumbnailUri: string | null;
  readability: ReceiptReadabilityEvidence | null;
};

export function mergeRecentHistory(input: {
  cloud: RecentReceipt[];
  device: PendingReceiptQueueItem[];
  devicePreviewUris?: ReadonlyMap<string, string>;
}): RecentHistoryItem[] {
  const byId = new Map<string, RecentHistoryItem>();
  for (const item of input.device) {
    const serverId = item.confirmation?.id ?? item.attempt?.receiptId ?? item.id;
    byId.set(serverId, {
      id: serverId,
      source: "device",
      localQueueId: item.id,
      submittedAt: item.confirmation?.submittedAt ?? item.createdAt,
      workerStatus: workerStatusFromDeviceQueue(item.status),
      pageCount: item.pages.length,
      thumbnailUri: input.devicePreviewUris?.get(item.id) ?? null,
      readability: null,
    });
  }
  for (const receipt of input.cloud) {
    byId.set(receipt.id, {
      id: receipt.id,
      source: "cloud",
      localQueueId: null,
      submittedAt: receipt.submittedAt,
      workerStatus: receipt.workerStatus,
      pageCount: receipt.pageCount,
      thumbnailUri: receipt.thumbnail?.url ?? null,
      readability: receipt.readability,
    });
  }
  return [...byId.values()].sort((left, right) => {
    const byTime = sortableTime(right.submittedAt) - sortableTime(left.submittedAt);
    return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
  });
}

export function appendRecentReceiptPage(
  current: RecentReceipt[],
  next: RecentReceipt[],
): RecentReceipt[] {
  const byId = new Map(current.map((receipt) => [receipt.id, receipt]));
  for (const receipt of next) byId.set(receipt.id, receipt);
  return [...byId.values()];
}

function sortableTime(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
