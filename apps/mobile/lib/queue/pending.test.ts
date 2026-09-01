import { QUEUE_SIGN_OUT_POLICY } from "@svl/domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";
import {
  PENDING_QUEUE_MAX_ATTEMPTS,
  PENDING_QUEUE_SENDING_LEASE_MS,
  type PendingQueueFileStore,
  type PendingQueueMetadataStore,
  PendingReceiptQueue,
  pendingQueueRetryDelayMs,
  shouldWarnOnSignOut,
} from "./pending";

const page: ReceiptPage = {
  uri: "file:///temporary/receipt.jpg",
  width: 1200,
  height: 1800,
  source: "camera",
  fileName: "receipt.jpg",
  fileSize: 120_000,
  mimeType: "image/jpeg",
  imageMetadata: {
    originalWidth: 1200,
    originalHeight: 1800,
    finalWidth: 1200,
    finalHeight: 1800,
    finalBytes: 120_000,
    mimeType: "image/jpeg",
    preparedAt: "2026-08-28T12:00:00.000Z",
  },
  quality: {
    status: "unavailable",
    metrics: null,
    hints: [],
  },
};

describe("durable pending receipt queue", () => {
  let raw: string | null;
  let now: Date;
  let metadata: PendingQueueMetadataStore;
  let files: PendingQueueFileStore;

  beforeEach(() => {
    raw = null;
    now = new Date("2026-08-28T12:00:00.000Z");
    metadata = {
      read: vi.fn(async () => raw),
      write: vi.fn(async (value) => {
        raw = value;
      }),
    };
    files = {
      planPages: (id, pages) =>
        pages.map((candidate, index) => ({
          ...candidate,
          uri: `file:///documents/pending/${id}/page-${index}.jpg`,
        })),
      copyPages: vi.fn(async () => undefined),
      prepareUploadPages: vi.fn(async (_id, pages) =>
        pages.map((candidate: ReceiptPage) => ({
          ...candidate,
          uri: `${candidate.uri}.decrypted`,
        })),
      ),
      removeUploadPages: vi.fn(async () => undefined),
      removePages: vi.fn(async () => undefined),
    };
  });

  function queue() {
    return new PendingReceiptQueue({
      metadata,
      files,
      createId: () => "queue-1",
      now: () => now,
    });
  }

  it("commits encrypted metadata before copying and keeps a durable image URI", async () => {
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });

    expect(metadata.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(metadata.write).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(files.copyPages).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(item.filesReady).toBe(true);
    expect(item.sourcePages).toBeNull();
    expect(item.pages[0]?.uri).toContain("/documents/pending/queue-1/");
    expect(await pending.count("worker-1")).toBe(1);
  });

  it("recovers only an expired sending lease and never resets an active run", async () => {
    const first = queue();
    const item = await first.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });
    await first.markSending(item.id);

    const restarted = queue();
    expect((await restarted.recoverInterrupted("worker-1"))[0]?.status).toBe("sending");

    now = new Date(now.getTime() + PENDING_QUEUE_SENDING_LEASE_MS + 1);
    expect((await restarted.recoverInterrupted("worker-1", new Set([item.id])))[0]?.status).toBe(
      "sending",
    );
    const [recovered] = await restarted.recoverInterrupted("worker-1");

    expect(recovered?.status).toBe("pending");
    expect(recovered?.nextAttemptAt).toBe(now.toISOString());
  });

  it("keeps a traceable job and finishes an interrupted durable image copy", async () => {
    files.copyPages = vi.fn(async () => {
      throw new Error("copy_interrupted");
    });
    await expect(
      queue().enqueue({ ownerUserId: "worker-1", pages: [page], location: null }),
    ).rejects.toThrow("copy_interrupted");

    files.copyPages = vi.fn(async () => undefined);
    const [recovered] = await queue().recoverInterrupted("worker-1");
    expect(recovered).toMatchObject({ filesReady: true, status: "pending", sourcePages: null });
  });

  it("recovers when encrypted pages were copied but the ready metadata write failed", async () => {
    let writes = 0;
    metadata.write = vi.fn(async (value) => {
      writes += 1;
      if (writes === 2) {
        throw new Error("metadata_write_interrupted");
      }
      raw = value;
    });
    await expect(
      queue().enqueue({ ownerUserId: "worker-1", pages: [page], location: null }),
    ).rejects.toThrow("metadata_write_interrupted");

    const [recovered] = await queue().recoverInterrupted("worker-1");
    expect(files.copyPages).toHaveBeenCalledTimes(2);
    expect(recovered).toMatchObject({ filesReady: true, status: "pending", sourcePages: null });
  });

  it("uses bounded exponential retry and allows a manual retry after a permanent failure", async () => {
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });

    const failed = await pending.markFailed({
      id: item.id,
      category: "network",
      attempt: null,
    });
    expect(failed.status).toBe("failed");
    expect(failed.nextAttemptAt).toBe("2026-08-28T12:01:00.000Z");
    expect(pendingQueueRetryDelayMs(99)).toBe(24 * 60 * 60 * 1000);

    const permanent = await pending.markFailed({
      id: item.id,
      category: "confirmation_rejected",
      attempt: null,
    });
    expect(permanent.nextAttemptAt).toBeNull();
    expect((await pending.requestManualRetry(item.id)).nextAttemptAt).toBe(now.toISOString());
  });

  it("persists a full manual retry budget after restart and max attempts", async () => {
    const first = queue();
    const item = await first.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });
    for (let attempt = 0; attempt < PENDING_QUEUE_MAX_ATTEMPTS; attempt += 1) {
      await first.markFailed({ id: item.id, category: "network", attempt: null });
    }
    expect((await first.get(item.id))?.nextAttemptAt).toBeNull();

    const restarted = queue();
    const retried = await restarted.requestManualRetry(item.id);
    expect(retried).toMatchObject({ status: "pending", attemptCount: 0 });
    expect((await queue().due("worker-1"))[0]?.id).toBe(item.id);
  });

  it("uses a decrypted staging copy for upload and removes it independently", async () => {
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });

    const [uploadPage] = await pending.prepareUploadPages(item.id);
    expect(uploadPage?.uri).toBe(`${item.pages[0]?.uri}.decrypted`);
    await pending.removeUploadPages(item.id);
    expect(files.removeUploadPages).toHaveBeenCalledWith(item.id);
    expect(files.removePages).not.toHaveBeenCalled();
  });

  it("never cleans Pending or Failed files and cleans only after durable confirmation", async () => {
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });
    await pending.markFailed({ id: item.id, category: "network", attempt: null });
    expect(files.removePages).not.toHaveBeenCalled();

    await pending.markConfirmed(item.id, {
      id: "receipt-1",
      status: "submitted",
      submittedAt: now.toISOString(),
    });
    expect(files.removePages).toHaveBeenCalledWith(item.id);
    expect(files.removeUploadPages).toHaveBeenCalledWith(item.id);
    expect(await pending.get(item.id)).toBeNull();
  });

  it("keeps Sent durable when final metadata cleanup cannot be committed", async () => {
    let failEmptyWrite = false;
    metadata.write = vi.fn(async (value) => {
      const document = JSON.parse(value) as { items: unknown[] };
      if (failEmptyWrite && document.items.length === 0) {
        throw new Error("secure_store_busy");
      }
      raw = value;
    });
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });
    failEmptyWrite = true;

    await expect(
      pending.markConfirmed(item.id, {
        id: "receipt-1",
        status: "submitted",
        submittedAt: now.toISOString(),
      }),
    ).resolves.toBeUndefined();
    expect(await pending.get(item.id)).toMatchObject({ status: "sent" });
    expect(files.removePages).toHaveBeenCalledWith(item.id);
  });

  it("records cleanup failure separately without turning Sent back into Failed", async () => {
    files.removePages = vi.fn(async () => {
      throw new Error("disk_busy");
    });
    const pending = queue();
    const item = await pending.enqueue({ ownerUserId: "worker-1", pages: [page], location: null });

    await pending.markConfirmed(item.id, {
      id: "receipt-1",
      status: "submitted",
      submittedAt: now.toISOString(),
    });
    expect(await pending.count("worker-1")).toBe(0);
    expect(await pending.get(item.id)).toMatchObject({ status: "sent", cleanupError: true });

    files.removePages = vi.fn(async () => undefined);
    await queue().recoverInterrupted("worker-1");
    expect(await queue().get(item.id)).toBeNull();
  });
});

describe("sign-out queue guard", () => {
  it("does not delete queued images and warns only when the queue is non-empty", () => {
    expect(QUEUE_SIGN_OUT_POLICY.deleteQueuedImages).toBe(false);
    expect(shouldWarnOnSignOut(0)).toBe(false);
    expect(shouldWarnOnSignOut(2)).toBe(true);
  });
});
