import { QUEUE_SIGN_OUT_POLICY, type ReceiptUploadFailureCategory } from "@svl/domain";
import type { ReceiptLocationMetadata, ReceiptPage } from "@/lib/capture/receipt-pages";
import type { ReceiptSubmissionAcknowledgement, ReceiptUploadAttempt } from "@/lib/upload/types";

export const PENDING_QUEUE_VERSION = 1 as const;
export const PENDING_QUEUE_MAX_ATTEMPTS = 8;
export const PENDING_QUEUE_RETRY_CAP_MS = 24 * 60 * 60 * 1000;
export const PENDING_QUEUE_SENDING_LEASE_MS = 5 * 60 * 1000;

export type PendingReceiptQueueStatus = "pending" | "sending" | "failed" | "sent";

export type PendingReceiptQueueItem = {
  version: typeof PENDING_QUEUE_VERSION;
  id: string;
  ownerUserId: string;
  status: PendingReceiptQueueStatus;
  pages: ReceiptPage[];
  sourcePages: ReceiptPage[] | null;
  filesReady: boolean;
  location: ReceiptLocationMetadata | null;
  attempt: ReceiptUploadAttempt | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  failureCategory: ReceiptUploadFailureCategory | null;
  confirmation: ReceiptSubmissionAcknowledgement | null;
  cleanupError: boolean;
  createdAt: string;
  updatedAt: string;
};

type QueueDocument = {
  version: typeof PENDING_QUEUE_VERSION;
  items: PendingReceiptQueueItem[];
};

export type PendingQueueMetadataStore = {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
};

export type PendingQueueFileStore = {
  planPages(queueId: string, pages: ReceiptPage[]): ReceiptPage[];
  copyPages(sourcePages: ReceiptPage[], durablePages: ReceiptPage[]): Promise<void>;
  prepareUploadPages(queueId: string, durablePages: ReceiptPage[]): Promise<ReceiptPage[]>;
  removeUploadPages(queueId: string): Promise<void>;
  removePages(queueId: string): Promise<void>;
};

export type PendingReceiptQueueDependencies = {
  metadata: PendingQueueMetadataStore;
  files: PendingQueueFileStore;
  createId(): string;
  now(): Date;
};

export class PendingReceiptQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: PendingReceiptQueueDependencies) {}

  async enqueue(input: {
    ownerUserId: string;
    pages: ReceiptPage[];
    location: ReceiptLocationMetadata | null;
  }): Promise<PendingReceiptQueueItem> {
    return this.lock(async () => {
      const document = await this.readDocument();
      const id = this.dependencies.createId();
      const now = this.dependencies.now().toISOString();
      const durablePages = this.dependencies.files.planPages(id, input.pages);
      let item: PendingReceiptQueueItem = {
        version: PENDING_QUEUE_VERSION,
        id,
        ownerUserId: input.ownerUserId,
        status: "pending",
        pages: durablePages,
        sourcePages: input.pages,
        filesReady: false,
        location: input.location,
        attempt: null,
        attemptCount: 0,
        nextAttemptAt: now,
        failureCategory: null,
        confirmation: null,
        cleanupError: false,
        createdAt: now,
        updatedAt: now,
      };

      document.items.push(item);
      await this.writeDocument(document);

      try {
        await this.dependencies.files.copyPages(input.pages, durablePages);
      } catch (error) {
        item = {
          ...item,
          status: "failed",
          nextAttemptAt: null,
          failureCategory: "unknown",
          updatedAt: this.dependencies.now().toISOString(),
        };
        document.items = replaceItem(document.items, item);
        await this.writeDocument(document);
        throw error;
      }

      item = {
        ...item,
        sourcePages: null,
        filesReady: true,
        updatedAt: this.dependencies.now().toISOString(),
      };
      document.items = replaceItem(document.items, item);
      // If this final metadata commit fails, the first traceable record remains.
      // Recovery validates/reuses the already encrypted pages and completes it.
      await this.writeDocument(document);
      return item;
    });
  }

  async recoverInterrupted(
    ownerUserId?: string,
    activeQueueIds: ReadonlySet<string> = new Set(),
  ): Promise<PendingReceiptQueueItem[]> {
    return this.lock(async () => {
      const document = await this.readDocument();
      const nowDate = this.dependencies.now();
      const now = nowDate.toISOString();
      let changed = false;
      const recovered: PendingReceiptQueueItem[] = [];
      for (const original of document.items) {
        let item = original;
        if (
          item.status === "sent" &&
          (ownerUserId === undefined || item.ownerUserId === ownerUserId)
        ) {
          try {
            await this.dependencies.files.removeUploadPages(item.id).catch(() => undefined);
            await this.dependencies.files.removePages(item.id);
            changed = true;
            continue;
          } catch {
            item = { ...item, cleanupError: true, updatedAt: now };
            changed = true;
          }
        }
        if (
          !item.filesReady &&
          item.sourcePages &&
          (ownerUserId === undefined || item.ownerUserId === ownerUserId)
        ) {
          try {
            await this.dependencies.files.copyPages(item.sourcePages, item.pages);
            item = {
              ...item,
              sourcePages: null,
              filesReady: true,
              status: "pending",
              nextAttemptAt: now,
              failureCategory: null,
              updatedAt: now,
            };
            changed = true;
          } catch {
            // Keep the traceable queue record and source reference for a later/manual recovery.
          }
        }
        if (
          item.status !== "sending" ||
          (ownerUserId !== undefined && item.ownerUserId !== ownerUserId) ||
          activeQueueIds.has(item.id) ||
          !sendingLeaseExpired(item.updatedAt, nowDate)
        ) {
          recovered.push(item);
          continue;
        }
        changed = true;
        recovered.push({ ...item, status: "pending", nextAttemptAt: now, updatedAt: now });
      }
      document.items = recovered;
      if (changed) {
        await this.writeDocument(document);
      }
      return document.items.filter(
        (item) => ownerUserId === undefined || item.ownerUserId === ownerUserId,
      );
    });
  }

  async list(ownerUserId?: string): Promise<PendingReceiptQueueItem[]> {
    return this.lock(async () => {
      const document = await this.readDocument();
      return document.items.filter(
        (item) => ownerUserId === undefined || item.ownerUserId === ownerUserId,
      );
    });
  }

  async count(ownerUserId?: string): Promise<number> {
    const items = await this.list(ownerUserId);
    return items.filter((item) => item.status !== "sent").length;
  }

  async get(id: string): Promise<PendingReceiptQueueItem | null> {
    const items = await this.list();
    return items.find((item) => item.id === id) ?? null;
  }

  async due(ownerUserId: string): Promise<PendingReceiptQueueItem[]> {
    const now = this.dependencies.now().getTime();
    const items = await this.list(ownerUserId);
    return items.filter(
      (item) =>
        item.filesReady &&
        item.status !== "sending" &&
        item.status !== "sent" &&
        item.attemptCount < PENDING_QUEUE_MAX_ATTEMPTS &&
        item.nextAttemptAt !== null &&
        Date.parse(item.nextAttemptAt) <= now,
    );
  }

  async prepareUploadPages(id: string): Promise<ReceiptPage[]> {
    const item = await this.get(id);
    if (!item?.filesReady || item.status === "sent") {
      throw new Error("pending_receipt_files_not_ready");
    }
    return this.dependencies.files.prepareUploadPages(item.id, item.pages);
  }

  async removeUploadPages(id: string): Promise<void> {
    await this.dependencies.files.removeUploadPages(id);
  }

  async markSending(id: string): Promise<PendingReceiptQueueItem> {
    return this.update(id, (item, now) => ({
      ...item,
      status: "sending",
      nextAttemptAt: null,
      failureCategory: null,
      updatedAt: now,
    }));
  }

  async saveAttempt(
    id: string,
    attempt: ReceiptUploadAttempt | null,
  ): Promise<PendingReceiptQueueItem> {
    return this.update(id, (item, now) => ({ ...item, attempt, updatedAt: now }));
  }

  async markFailed(input: {
    id: string;
    category: ReceiptUploadFailureCategory;
    attempt: ReceiptUploadAttempt | null;
    retryable?: boolean;
  }): Promise<PendingReceiptQueueItem> {
    return this.update(input.id, (item, now) => {
      const attemptCount = item.attemptCount + 1;
      const retryable = input.retryable ?? isAutomaticRetryable(input.category);
      return {
        ...item,
        status: "failed",
        attempt: input.attempt,
        attemptCount,
        nextAttemptAt:
          retryable && attemptCount < PENDING_QUEUE_MAX_ATTEMPTS
            ? new Date(Date.parse(now) + pendingQueueRetryDelayMs(attemptCount)).toISOString()
            : null,
        failureCategory: input.category,
        updatedAt: now,
      };
    });
  }

  async requestManualRetry(id: string): Promise<PendingReceiptQueueItem> {
    return this.update(id, (item, now) => {
      if (item.status === "sent" || !item.filesReady) {
        throw new Error("pending_receipt_not_retryable");
      }
      return {
        ...item,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
        failureCategory: null,
        updatedAt: now,
      };
    });
  }

  async markConfirmed(id: string, confirmation: ReceiptSubmissionAcknowledgement): Promise<void> {
    await this.update(id, (item, now) => ({
      ...item,
      status: "sent",
      confirmation,
      nextAttemptAt: null,
      failureCategory: null,
      updatedAt: now,
    }));

    // Confirmation is the durable boundary. Cleanup after it is best-effort and
    // must never make the caller mark a server-confirmed receipt Failed.
    await this.dependencies.files.removeUploadPages(id).catch(() => undefined);
    try {
      await this.dependencies.files.removePages(id);
    } catch {
      await this.update(id, (item, now) => ({ ...item, cleanupError: true, updatedAt: now })).catch(
        () => undefined,
      );
      return;
    }

    await this.lock(async () => {
      const document = await this.readDocument();
      document.items = document.items.filter((item) => item.id !== id);
      await this.writeDocument(document);
    }).catch(() => undefined);
  }

  private async update(
    id: string,
    change: (item: PendingReceiptQueueItem, now: string) => PendingReceiptQueueItem,
  ): Promise<PendingReceiptQueueItem> {
    return this.lock(async () => {
      const document = await this.readDocument();
      const item = document.items.find((candidate) => candidate.id === id);
      if (!item) {
        throw new Error("pending_receipt_not_found");
      }
      const updated = change(item, this.dependencies.now().toISOString());
      document.items = replaceItem(document.items, updated);
      await this.writeDocument(document);
      return updated;
    });
  }

  private async readDocument(): Promise<QueueDocument> {
    const raw = await this.dependencies.metadata.read();
    if (raw === null) {
      return { version: PENDING_QUEUE_VERSION, items: [] };
    }
    return parseQueueDocument(raw);
  }

  private async writeDocument(document: QueueDocument): Promise<void> {
    await this.dependencies.metadata.write(JSON.stringify(document));
  }

  private async lock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export function pendingQueueRetryDelayMs(attemptCount: number): number {
  const safeAttempt = Math.max(1, Math.trunc(attemptCount));
  return Math.min(60_000 * 2 ** (safeAttempt - 1), PENDING_QUEUE_RETRY_CAP_MS);
}

export function isAutomaticRetryable(category: ReceiptUploadFailureCategory): boolean {
  return !["confirmation_rejected", "invalid_response"].includes(category);
}

function sendingLeaseExpired(updatedAt: string, now: Date): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  return (
    !Number.isFinite(updatedAtMs) || updatedAtMs <= now.getTime() - PENDING_QUEUE_SENDING_LEASE_MS
  );
}

export async function countQueuedReceipts(ownerUserId?: string): Promise<number> {
  const { getPendingReceiptQueue } = await import("./pending-native");
  return getPendingReceiptQueue().count(ownerUserId);
}

export function shouldWarnOnSignOut(queuedCount: number): boolean {
  return QUEUE_SIGN_OUT_POLICY.warnWhenQueueNonEmpty && queuedCount > 0;
}

function replaceItem(
  items: PendingReceiptQueueItem[],
  replacement: PendingReceiptQueueItem,
): PendingReceiptQueueItem[] {
  return items.map((item) => (item.id === replacement.id ? replacement : item));
}

function parseQueueDocument(raw: string): QueueDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("pending_queue_corrupt");
  }
  if (!value || typeof value !== "object") {
    throw new Error("pending_queue_corrupt");
  }
  const candidate = value as Partial<QueueDocument>;
  if (candidate.version !== PENDING_QUEUE_VERSION || !Array.isArray(candidate.items)) {
    throw new Error("pending_queue_version_unsupported");
  }
  if (!candidate.items.every(isPendingQueueItem)) {
    throw new Error("pending_queue_corrupt");
  }
  return { version: PENDING_QUEUE_VERSION, items: candidate.items };
}

function isPendingQueueItem(value: unknown): value is PendingReceiptQueueItem {
  if (!value || typeof value !== "object") {
    return false;
  }
  const item = value as Partial<PendingReceiptQueueItem>;
  return (
    item.version === PENDING_QUEUE_VERSION &&
    typeof item.id === "string" &&
    typeof item.ownerUserId === "string" &&
    ["pending", "sending", "failed", "sent"].includes(item.status ?? "") &&
    Array.isArray(item.pages) &&
    (item.sourcePages === null || Array.isArray(item.sourcePages)) &&
    typeof item.filesReady === "boolean" &&
    Number.isInteger(item.attemptCount) &&
    Number(item.attemptCount) >= 0 &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}
