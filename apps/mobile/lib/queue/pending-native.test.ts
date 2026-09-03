import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";

const runtime = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  const directories = new Set<string>();
  const secrets = new Map<string, string>();
  let legacyRaw: string | null = null;
  let cryptoCall = 0;
  let failCryptoCall: number | null = null;
  let uuid = 0;

  const uriOf = (value: unknown): string =>
    typeof value === "string" ? value : (value as { uri: string }).uri;
  const join = (...parts: unknown[]): string =>
    parts
      .map(uriOf)
      .filter(Boolean)
      .map((part, index) =>
        index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, ""),
      )
      .join("/");
  const dirname = (uri: string): string => uri.slice(0, uri.lastIndexOf("/"));

  class MockDirectory {
    uri: string;

    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }

    get exists() {
      const prefix = `${this.uri}/`;
      return directories.has(this.uri) || [...files.keys()].some((uri) => uri.startsWith(prefix));
    }

    create() {
      directories.add(this.uri);
    }

    delete() {
      const prefix = `${this.uri}/`;
      for (const uri of files.keys()) {
        if (uri.startsWith(prefix)) {
          files.delete(uri);
        }
      }
      for (const uri of directories) {
        if (uri === this.uri || uri.startsWith(prefix)) {
          directories.delete(uri);
        }
      }
    }
  }

  class MockFile {
    uri: string;

    constructor(...parts: unknown[]) {
      this.uri = join(...parts);
    }

    get exists() {
      return files.has(this.uri);
    }

    get size() {
      return files.get(this.uri)?.byteLength ?? 0;
    }

    get name() {
      return this.uri.slice(this.uri.lastIndexOf("/") + 1);
    }

    get parentDirectory() {
      return new MockDirectory(dirname(this.uri));
    }

    create() {
      files.set(this.uri, new Uint8Array());
    }

    write(bytes: Uint8Array) {
      files.set(this.uri, new Uint8Array(bytes));
    }

    async bytes() {
      const value = files.get(this.uri);
      if (!value) {
        throw new Error("file_missing");
      }
      return new Uint8Array(value);
    }

    async move(destination: MockFile) {
      const value = files.get(this.uri);
      if (!value) {
        throw new Error("file_missing");
      }
      files.set(destination.uri, value);
      files.delete(this.uri);
      this.uri = destination.uri;
    }

    delete() {
      files.delete(this.uri);
    }
  }

  class MockKey {
    static async generate() {
      return new MockKey();
    }

    static async import() {
      return new MockKey();
    }

    async encoded() {
      return "mock-device-key";
    }
  }

  const encrypt = async (plaintext: Uint8Array) => {
    cryptoCall += 1;
    if (cryptoCall === failCryptoCall) {
      failCryptoCall = null;
      throw new Error("encryption_interrupted");
    }
    const combined = new Uint8Array(29 + plaintext.byteLength);
    combined.fill(0xa5, 0, 29);
    plaintext.forEach((byte, index) => {
      combined[29 + index] = byte ^ 0x5a;
    });
    return { combined: async () => combined };
  };

  const decrypt = async (sealed: { combined: Uint8Array }) => {
    const combined = sealed.combined;
    if (combined.byteLength <= 29 || combined.slice(0, 29).some((byte) => byte !== 0xa5)) {
      throw new Error("authentication_failed");
    }
    return combined.slice(29).map((byte) => byte ^ 0x5a);
  };

  return {
    files,
    directories,
    secrets,
    MockDirectory,
    MockFile,
    MockKey,
    encrypt,
    decrypt,
    get legacyRaw() {
      return legacyRaw;
    },
    set legacyRaw(value: string | null) {
      legacyRaw = value;
    },
    set failCryptoCall(value: number | null) {
      failCryptoCall = value;
    },
    get cryptoCall() {
      return cryptoCall;
    },
    nextUuid: () => `uuid-${++uuid}`,
    reset() {
      files.clear();
      directories.clear();
      secrets.clear();
      legacyRaw = null;
      cryptoCall = 0;
      failCryptoCall = null;
      uuid = 0;
    },
  };
});

vi.mock("expo-file-system", () => ({
  Directory: runtime.MockDirectory,
  File: runtime.MockFile,
  Paths: { document: "file:///document", cache: "file:///cache" },
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => runtime.secrets.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    runtime.secrets.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    runtime.secrets.delete(key);
  },
}));

vi.mock("expo-crypto", () => ({
  AESEncryptionKey: runtime.MockKey,
  AESSealedData: {
    fromCombined: (combined: Uint8Array) => ({ combined }),
  },
  aesEncryptAsync: runtime.encrypt,
  aesDecryptAsync: runtime.decrypt,
  randomUUID: runtime.nextUuid,
}));

vi.mock("@/lib/auth/session-chunked-store", () => ({
  readPersistedSession: async () => runtime.legacyRaw,
  clearPersistedSession: async () => {
    runtime.legacyRaw = null;
  },
}));

const bytes = new Uint8Array([1, 2, 3, 4]);

function receiptPage(uri: string): ReceiptPage {
  return {
    uri,
    width: 10,
    height: 20,
    source: "camera",
    fileName: "receipt.jpg",
    fileSize: bytes.byteLength,
    mimeType: "image/jpeg",
    imageMetadata: {
      originalWidth: 10,
      originalHeight: 20,
      finalWidth: 10,
      finalHeight: 20,
      finalBytes: bytes.byteLength,
      mimeType: "image/jpeg",
      preparedAt: "2026-08-28T12:00:00.000Z",
    },
    quality: { status: "unavailable", metrics: null, hints: [] },
  };
}

async function newQueue() {
  vi.resetModules();
  return (await import("./pending-native")).getPendingReceiptQueue();
}

describe("native encrypted pending receipt storage", () => {
  beforeEach(() => {
    runtime.reset();
  });

  it("stores metadata and receipt pages as ciphertext and stages plaintext only for upload", async () => {
    const sourceUri = "file:///source/receipt.jpg";
    runtime.files.set(sourceUri, bytes);
    const queue = await newQueue();
    const item = await queue.enqueue({
      ownerUserId: "worker-1",
      pages: [receiptPage(sourceUri)],
      location: null,
    });

    const encrypted = runtime.files.get(item.pages[0]?.uri ?? "");
    expect(encrypted).toBeDefined();
    expect(Array.from(encrypted ?? [])).not.toEqual(Array.from(bytes));
    const metadata = runtime.files.get("file:///document/pending-receipts-v2/queue-metadata.svle");
    expect(new TextDecoder().decode(metadata)).not.toContain("worker-1");
    expect([...runtime.secrets.keys()]).toEqual(["svl.pending-receipts.aes-key.v1"]);

    const [staged] = await queue.prepareUploadPages(item.id);
    expect(Array.from(runtime.files.get(staged?.uri ?? "") ?? [])).toEqual(Array.from(bytes));
    await queue.removeUploadPages(item.id);
    expect(runtime.files.has(staged?.uri ?? "")).toBe(false);
    expect(runtime.files.has(item.pages[0]?.uri ?? "")).toBe(true);
  });

  it("recovers a partial encrypted copy without accepting an incomplete page set", async () => {
    const secondBytes = new Uint8Array([5, 6, 7, 8]);
    runtime.files.set("file:///source/one.jpg", bytes);
    runtime.files.set("file:///source/two.jpg", secondBytes);
    runtime.failCryptoCall = 3;
    const queue = await newQueue();
    await expect(
      queue.enqueue({
        ownerUserId: "worker-1",
        pages: [receiptPage("file:///source/one.jpg"), receiptPage("file:///source/two.jpg")],
        location: null,
      }),
    ).rejects.toThrow("encryption_interrupted");

    const recovered = await queue.recoverInterrupted("worker-1");
    expect(recovered[0]).toMatchObject({ filesReady: true, status: "pending" });
    const staged = await queue.prepareUploadPages(recovered[0]?.id ?? "");
    expect(Array.from(runtime.files.get(staged[0]?.uri ?? "") ?? [])).toEqual(Array.from(bytes));
    expect(Array.from(runtime.files.get(staged[1]?.uri ?? "") ?? [])).toEqual(
      Array.from(secondBytes),
    );
  });

  it("removes stale decrypted staging on app restart without touching durable ciphertext", async () => {
    const sourceUri = "file:///source/receipt.jpg";
    runtime.files.set(sourceUri, bytes);
    const firstQueue = await newQueue();
    const item = await firstQueue.enqueue({
      ownerUserId: "worker-1",
      pages: [receiptPage(sourceUri)],
      location: null,
    });
    const [staged] = await firstQueue.prepareUploadPages(item.id);
    const durableUri = item.pages[0]?.uri ?? "";
    expect(runtime.files.has(staged?.uri ?? "")).toBe(true);
    expect(runtime.files.has(durableUri)).toBe(true);

    const restartedQueue = await newQueue();
    expect(runtime.files.has(staged?.uri ?? "")).toBe(false);
    expect(runtime.files.has(durableUri)).toBe(true);
    expect((await restartedQueue.get(item.id))?.id).toBe(item.id);
  });

  it("stages one decrypted preview in cache and removes it without touching ciphertext", async () => {
    const sourceUri = "file:///source/receipt.jpg";
    runtime.files.set(sourceUri, bytes);
    const queue = await newQueue();
    const item = await queue.enqueue({
      ownerUserId: "worker-1",
      pages: [receiptPage(sourceUri)],
      location: null,
    });

    const previewUri = await queue.preparePreviewPage(item.id);
    expect(previewUri).toContain("pending-receipt-preview-staging-v1");
    expect(Array.from(runtime.files.get(previewUri) ?? [])).toEqual(Array.from(bytes));
    await queue.removePreviewPages(item.id);
    expect(runtime.files.has(previewUri)).toBe(false);
    expect(runtime.files.has(item.pages[0]?.uri ?? "")).toBe(true);
  });

  it("migrates legacy plaintext queue files before removing them", async () => {
    const legacyPage = receiptPage("file:///document/pending-receipts-v1/legacy-1/page-0.jpg");
    runtime.files.set(legacyPage.uri, bytes);
    runtime.legacyRaw = JSON.stringify({
      version: 1,
      items: [
        {
          version: 1,
          id: "legacy-1",
          ownerUserId: "worker-1",
          status: "pending",
          pages: [legacyPage],
          sourcePages: null,
          filesReady: true,
          location: null,
          attempt: null,
          attemptCount: 0,
          nextAttemptAt: "2026-08-28T12:00:00.000Z",
          failureCategory: null,
          confirmation: null,
          cleanupError: false,
          createdAt: "2026-08-28T12:00:00.000Z",
          updatedAt: "2026-08-28T12:00:00.000Z",
        },
      ],
    });

    const [migrated] = await (await newQueue()).list("worker-1");
    expect(migrated?.pages[0]?.uri).toContain("pending-receipts-v2");
    expect(runtime.files.has(legacyPage.uri)).toBe(false);
    expect(runtime.legacyRaw).toBeNull();
  });
});
