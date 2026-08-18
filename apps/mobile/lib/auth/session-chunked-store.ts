export const SESSION_CHUNK_SIZE = 1800;
/** Extra keys scanned on shrink/remove so leftover token chunks cannot survive. */
export const SESSION_CHUNK_SCAN_LIMIT = 32;

export type SessionKeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

function chunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

function parseChunkCount(header: string | null): number {
  if (!header?.startsWith("CHUNKED:")) {
    return 0;
  }
  const count = Number(header.slice("CHUNKED:".length));
  if (!Number.isInteger(count) || count < 1) {
    return 0;
  }
  return count;
}

async function deleteChunks(
  store: SessionKeyValueStore,
  key: string,
  fromIndex: number,
  untilIndex: number,
): Promise<void> {
  for (let i = fromIndex; i < untilIndex; i += 1) {
    await store.removeItem(chunkKey(key, i));
  }
}

export async function readPersistedSession(
  store: SessionKeyValueStore,
  key: string,
): Promise<string | null> {
  const header = await store.getItem(key);
  if (!header) {
    return null;
  }
  if (!header.startsWith("CHUNKED:")) {
    return header;
  }
  const count = parseChunkCount(header);
  if (count === 0) {
    await clearPersistedSession(store, key);
    return null;
  }
  let value = "";
  for (let i = 0; i < count; i += 1) {
    const part = await store.getItem(chunkKey(key, i));
    if (part == null) {
      await clearPersistedSession(store, key);
      return null;
    }
    value += part;
  }
  return value;
}

export async function writePersistedSession(
  store: SessionKeyValueStore,
  key: string,
  value: string,
  chunkSize: number = SESSION_CHUNK_SIZE,
): Promise<void> {
  const previousCount = parseChunkCount(await store.getItem(key));
  const deleteUntil = Math.max(previousCount, SESSION_CHUNK_SCAN_LIMIT);

  if (value.length <= chunkSize) {
    await store.setItem(key, value);
    await deleteChunks(store, key, 0, deleteUntil);
    return;
  }

  const count = Math.ceil(value.length / chunkSize);
  for (let i = 0; i < count; i += 1) {
    await store.setItem(chunkKey(key, i), value.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  await store.setItem(key, `CHUNKED:${count}`);
  await deleteChunks(store, key, count, deleteUntil);
}

export async function clearPersistedSession(
  store: SessionKeyValueStore,
  key: string,
): Promise<void> {
  const previousCount = parseChunkCount(await store.getItem(key));
  await store.removeItem(key);
  await deleteChunks(store, key, 0, Math.max(previousCount, SESSION_CHUNK_SCAN_LIMIT));
}
