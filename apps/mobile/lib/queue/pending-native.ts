import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  randomUUID,
} from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { clearPersistedSession, readPersistedSession } from "@/lib/auth/session-chunked-store";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";
import { PendingReceiptQueue } from "./pending";

const LEGACY_QUEUE_STORAGE_KEY = "svl.pending-receipts.v1";
const QUEUE_ENCRYPTION_KEY = "svl.pending-receipts.aes-key.v1";
const LEGACY_QUEUE_DIRECTORY = "pending-receipts-v1";
const QUEUE_DIRECTORY = "pending-receipts-v2";
const UPLOAD_STAGING_DIRECTORY = "pending-receipt-upload-staging-v1";
const METADATA_FILE_NAME = "queue-metadata.svle";
const SAFE_QUEUE_ID = /^[a-zA-Z0-9_-]{1,80}$/;

const secureStore = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};

let encryptionKeyPromise: Promise<AESEncryptionKey> | null = null;

async function getEncryptionKey(): Promise<AESEncryptionKey> {
  encryptionKeyPromise ??= loadOrCreateEncryptionKey().catch((error) => {
    encryptionKeyPromise = null;
    throw error;
  });
  return encryptionKeyPromise;
}

async function loadOrCreateEncryptionKey(): Promise<AESEncryptionKey> {
  const stored = await SecureStore.getItemAsync(QUEUE_ENCRYPTION_KEY);
  if (stored) {
    return (await AESEncryptionKey.import(stored, "base64")) as AESEncryptionKey;
  }

  const generated = (await AESEncryptionKey.generate(256)) as AESEncryptionKey;
  const encoded = await generated.encoded("base64");
  try {
    await SecureStore.setItemAsync(QUEUE_ENCRYPTION_KEY, encoded);
  } catch (error) {
    if ((await SecureStore.getItemAsync(QUEUE_ENCRYPTION_KEY)) !== encoded) {
      throw error;
    }
  }
  return generated;
}

async function encryptBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const sealed = await aesEncryptAsync(bytes, await getEncryptionKey());
  return sealed.combined();
}

async function decryptBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const sealed = AESSealedData.fromCombined(bytes);
  return aesDecryptAsync(sealed, await getEncryptionKey());
}

async function writeFileAtomically(destination: File, bytes: Uint8Array): Promise<void> {
  destination.parentDirectory.create({ idempotent: true, intermediates: true });
  const temporary = new File(
    destination.parentDirectory,
    `${destination.name}.${randomUUID()}.tmp`,
  );
  const temporaryUri = temporary.uri;
  try {
    temporary.create({ overwrite: true, intermediates: true });
    temporary.write(bytes);
    if (!temporary.exists || temporary.size !== bytes.byteLength) {
      throw new Error("pending_queue_file_write_failed");
    }
    await temporary.move(destination, { overwrite: true });
  } finally {
    const abandonedTemporary = new File(temporaryUri);
    if (abandonedTemporary.exists) {
      abandonedTemporary.delete();
    }
  }
}

async function writeEncryptedMetadata(value: string): Promise<void> {
  const destination = new File(Paths.document, QUEUE_DIRECTORY, METADATA_FILE_NAME);
  const plaintext = new TextEncoder().encode(value);
  await writeFileAtomically(destination, await encryptBytes(plaintext));
}

async function readEncryptedMetadata(): Promise<string | null> {
  const source = new File(Paths.document, QUEUE_DIRECTORY, METADATA_FILE_NAME);
  if (!source.exists) {
    return null;
  }
  try {
    return new TextDecoder().decode(await decryptBytes(await source.bytes()));
  } catch {
    throw new Error("pending_queue_metadata_unreadable");
  }
}

const queueFileStore = {
  planPages(queueId: string, pages: ReceiptPage[]): ReceiptPage[] {
    assertSafeQueueId(queueId);
    const directory = new Directory(Paths.document, QUEUE_DIRECTORY, queueId);
    return pages.map((page, index) => ({
      ...page,
      uri: new File(directory, `page-${index}.jpg.svle`).uri,
      fileName: `page-${index}.jpg`,
      mimeType: "image/jpeg",
    }));
  },

  async copyPages(sourcePages: ReceiptPage[], durablePages: ReceiptPage[]): Promise<void> {
    if (sourcePages.length !== durablePages.length) {
      throw new Error("pending_queue_page_count_changed");
    }

    for (let index = 0; index < sourcePages.length; index += 1) {
      const sourcePage = sourcePages[index];
      const destinationPage = durablePages[index];
      if (!sourcePage || !destinationPage) {
        throw new Error("pending_queue_page_missing");
      }
      const destination = new File(destinationPage.uri);
      if (await encryptedPageIsValid(destination, destinationPage)) {
        continue;
      }
      if (destination.exists) {
        destination.delete();
      }

      const source = new File(sourcePage.uri);
      if (!source.exists) {
        throw new Error("pending_queue_source_missing");
      }
      const plaintext = await source.bytes();
      if (plaintext.byteLength !== destinationPage.imageMetadata.finalBytes) {
        throw new Error("pending_queue_source_changed");
      }
      await writeFileAtomically(destination, await encryptBytes(plaintext));
      if (!(await encryptedPageIsValid(destination, destinationPage))) {
        throw new Error("pending_queue_copy_failed");
      }
    }

    for (const page of durablePages) {
      if (!(await encryptedPageIsValid(new File(page.uri), page))) {
        throw new Error("pending_queue_copy_incomplete");
      }
    }
  },

  async prepareUploadPages(queueId: string, durablePages: ReceiptPage[]): Promise<ReceiptPage[]> {
    assertSafeQueueId(queueId);
    const stagingDirectory = new Directory(Paths.cache, UPLOAD_STAGING_DIRECTORY, queueId);
    if (stagingDirectory.exists) {
      stagingDirectory.delete();
    }
    stagingDirectory.create({ idempotent: true, intermediates: true });

    try {
      const staged: ReceiptPage[] = [];
      for (let index = 0; index < durablePages.length; index += 1) {
        const page = durablePages[index];
        if (!page) {
          throw new Error("pending_queue_page_missing");
        }
        const plaintext = await decryptBytes(await new File(page.uri).bytes());
        if (plaintext.byteLength !== page.imageMetadata.finalBytes) {
          throw new Error("pending_queue_decrypted_page_changed");
        }
        const destination = new File(stagingDirectory, `page-${index}.jpg`);
        await writeFileAtomically(destination, plaintext);
        staged.push({
          ...page,
          uri: destination.uri,
          fileName: `page-${index}.jpg`,
          fileSize: plaintext.byteLength,
          mimeType: "image/jpeg",
        });
      }
      return staged;
    } catch (error) {
      if (stagingDirectory.exists) {
        stagingDirectory.delete();
      }
      throw error;
    }
  },

  async removeUploadPages(queueId: string): Promise<void> {
    assertSafeQueueId(queueId);
    const directory = new Directory(Paths.cache, UPLOAD_STAGING_DIRECTORY, queueId);
    if (directory.exists) {
      directory.delete();
    }
  },

  async removePages(queueId: string): Promise<void> {
    assertSafeQueueId(queueId);
    const directory = new Directory(Paths.document, QUEUE_DIRECTORY, queueId);
    if (directory.exists) {
      directory.delete();
    }
  },
};

function assertSafeQueueId(queueId: string): void {
  if (!SAFE_QUEUE_ID.test(queueId)) {
    throw new Error("pending_queue_id_invalid");
  }
}

async function encryptedPageIsValid(file: File, page: ReceiptPage): Promise<boolean> {
  if (!file.exists || file.size <= 28) {
    return false;
  }
  try {
    return (await decryptBytes(await file.bytes())).byteLength === page.imageMetadata.finalBytes;
  } catch {
    return false;
  }
}

const encryptedMetadataStore = {
  async read(): Promise<string | null> {
    const current = await readEncryptedMetadata();
    if (current !== null) {
      await removeLegacyDirectories(current);
      return current;
    }

    const legacy = await readPersistedSession(secureStore, LEGACY_QUEUE_STORAGE_KEY);
    if (legacy === null) {
      return null;
    }
    const migrated = await migrateLegacyQueue(legacy);
    await writeEncryptedMetadata(migrated);
    await clearPersistedSession(secureStore, LEGACY_QUEUE_STORAGE_KEY);
    await removeLegacyDirectories(migrated);
    return migrated;
  },

  write: writeEncryptedMetadata,
};

async function migrateLegacyQueue(raw: string): Promise<string> {
  let document: {
    items?: Array<{ id?: unknown; status?: unknown; filesReady?: unknown; pages?: unknown }>;
    [key: string]: unknown;
  };
  try {
    document = JSON.parse(raw);
  } catch {
    throw new Error("pending_queue_legacy_corrupt");
  }
  if (!Array.isArray(document.items)) {
    throw new Error("pending_queue_legacy_corrupt");
  }

  const items = [];
  for (const rawItem of document.items) {
    if (typeof rawItem.id !== "string" || !Array.isArray(rawItem.pages)) {
      throw new Error("pending_queue_legacy_corrupt");
    }
    const pages = rawItem.pages as ReceiptPage[];
    const durablePages = queueFileStore.planPages(rawItem.id, pages);
    if (rawItem.filesReady === true && rawItem.status !== "sent") {
      await queueFileStore.copyPages(pages, durablePages);
    }
    items.push({ ...rawItem, pages: durablePages });
  }
  return JSON.stringify({ ...document, items });
}

async function removeLegacyDirectories(raw: string): Promise<void> {
  let ids: string[];
  try {
    const parsed = JSON.parse(raw) as { items?: Array<{ id?: unknown }> };
    ids = (parsed.items ?? []).flatMap((item) =>
      typeof item.id === "string" && SAFE_QUEUE_ID.test(item.id) ? [item.id] : [],
    );
  } catch {
    return;
  }
  for (const id of ids) {
    const directory = new Directory(Paths.document, LEGACY_QUEUE_DIRECTORY, id);
    if (directory.exists) {
      directory.delete();
    }
  }
}

let singleton: PendingReceiptQueue | null = null;
let uploadStagingCleaned = false;

export function getPendingReceiptQueue(): PendingReceiptQueue {
  if (!singleton) {
    removeStaleUploadStaging();
    singleton = new PendingReceiptQueue({
      metadata: encryptedMetadataStore,
      files: queueFileStore,
      createId: randomUUID,
      now: () => new Date(),
    });
  }
  return singleton;
}

function removeStaleUploadStaging(): void {
  if (uploadStagingCleaned) {
    return;
  }
  const stagingRoot = new Directory(Paths.cache, UPLOAD_STAGING_DIRECTORY);
  if (stagingRoot.exists) {
    stagingRoot.delete();
  }
  uploadStagingCleaned = true;
}
