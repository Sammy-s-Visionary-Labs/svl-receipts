export type DraftPage = {
  id: string;
  blob: Blob;
  bytes?: ArrayBuffer;
  checksum: string;
  width: number;
  height: number;
};

export type FieldDraft = {
  id: string;
  ownerId: string;
  createdAt: string;
  pages: DraftPage[];
  location: {
    latitude: number;
    longitude: number;
    accuracyMeters: number;
    capturedAt: string;
  } | null;
  started: boolean;
  uploaded: number[];
  completed?: boolean;
};

const DATABASE = "svl-field-drafts-v1";
const STORE = "drafts";

type StoredDraft = Omit<FieldDraft, "pages"> & {
  pages: (Omit<DraftPage, "blob"> & { bytes?: ArrayBuffer; blob?: Blob })[];
};

function decodeDraft(draft: StoredDraft): FieldDraft {
  return {
    ...draft,
    pages: draft.pages.map(({ bytes, blob, ...page }) => {
      if (!blob && !bytes) throw new Error("A saved photo could not be opened. Please retake it.");
      return {
        ...page,
        bytes,
        blob: blob ?? new Blob([bytes as ArrayBuffer], { type: "image/jpeg" }),
      };
    }),
  };
}

async function encodeDraft(draft: FieldDraft): Promise<StoredDraft> {
  // Store ArrayBuffers, not Blob/File objects: WebKit can reject their IndexedDB serialization.
  // Read bytes before opening the transaction so asynchronous work cannot close it early.
  return {
    ...draft,
    pages: await Promise.all(
      draft.pages.map(async ({ blob, ...page }) => ({
        ...page,
        bytes: page.bytes ?? (await blob.arrayBuffer()),
      })),
    ),
  };
}

async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("This browser could not open saved drafts."));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("Draft could not be saved. Check available space and try again."));
    });
  } finally {
    db.close();
  }
}

export async function listDrafts(ownerId: string): Promise<FieldDraft[]> {
  const rows = (await transact("readonly", (store) => store.getAll())) as StoredDraft[];
  return rows
    .filter((row) => row.ownerId === ownerId && !row.completed)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(decodeDraft);
}

export async function readDraft(id: string, ownerId: string): Promise<FieldDraft | null> {
  const row = (await transact("readonly", (store) => store.get(id))) as StoredDraft | undefined;
  return row?.ownerId === ownerId && !row.completed ? decodeDraft(row) : null;
}

export async function saveDraft(draft: FieldDraft): Promise<void> {
  const encoded = await encodeDraft(draft);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE, "readwrite");
      const store = transaction.objectStore(STORE);
      const request = store.get(draft.id);
      request.onsuccess = () => {
        const existing = request.result as FieldDraft | undefined;
        if (
          existing &&
          (existing.ownerId !== draft.ownerId ||
            existing.completed ||
            (existing.started &&
              (!draft.started ||
                existing.pages.map((page) => page.checksum).join() !==
                  draft.pages.map((page) => page.checksum).join())))
        ) {
          reject(new Error("This draft changed in another tab. Reopen it before continuing."));
          transaction.abort();
          return;
        }
        store.put({
          ...encoded,
          uploaded: [...new Set([...(existing?.uploaded ?? []), ...draft.uploaded])],
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(new Error("Draft could not be saved. Check available space and try again."));
    });
  } finally {
    db.close();
  }
}

export async function deleteDraft(id: string, ownerId: string): Promise<void> {
  if (await readDraft(id, ownerId)) await transact("readwrite", (store) => store.delete(id));
}

export async function completeDraft(draft: FieldDraft): Promise<void> {
  // Retain only an ID/owner tombstone so a stale tab cannot reuse a sent draft ID.
  // Receipt photos and location are removed from browser storage after acknowledgement.
  await transact("readwrite", (store) =>
    store.put({
      ...draft,
      pages: [],
      location: null,
      uploaded: [],
      completed: true,
    }),
  );
}

export function newDraft(ownerId: string): FieldDraft {
  return {
    id: crypto.randomUUID(),
    ownerId,
    createdAt: new Date().toISOString(),
    pages: [],
    location: null,
    started: false,
    uploaded: [],
  };
}
