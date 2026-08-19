export const SESSION_CHUNK_SIZE = 1800;
/** Legacy keys scanned so chunks left by the original CHUNKED format are removed. */
export const SESSION_CHUNK_SCAN_LIMIT = 32;

const SESSION_MAX_CHUNKS = 32;
const MANIFEST_PREFIX = "SVL_SESSION_V3:";
const SLOT_RECORD_PREFIX = "SVL_SESSION_SLOT_V3:";
const SLOT_ABORT_PREFIX = "SVL_SESSION_SLOT_ABORTED_V3:";
const TOMBSTONE_CLEARING = "SVL_SESSION_CLEARING_V3";
const TOMBSTONE_CLEARED = "SVL_SESSION_CLEARED_V3";
const SLOT_KEY_MARKER = ".__svl_session_slot_";
const LEGACY_STAGING_SUFFIX = ".__svl_session_staging";

// V3 uses two deterministic slots. A writer fully seals the inactive slot before
// switching the root manifest. Fixed slot names let sign-out remove every possible
// credential even when the root or a slot record is corrupt.

export type SessionKeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type Slot = 0 | 1;

type SlotManifest = {
  slot: Slot;
  writeId: string;
  count: number;
  length: number;
  checksum: string;
};

type SlotRecord = SlotManifest & {
  state: "writing" | "ready";
};

type HeaderState =
  | { kind: "empty" }
  | { kind: "direct"; value: string }
  | { kind: "legacy-chunked"; count: number }
  | { kind: "slot"; manifest: SlotManifest; raw: string }
  | { kind: "tombstone"; phase: "clearing" | "cleared"; raw: string }
  | { kind: "corrupt" };

const operationTails = new Map<string, Promise<void>>();

function legacyChunkKey(key: string, index: number): string {
  return `${key}.${index}`;
}

function slotRecordKey(key: string, slot: Slot): string {
  return `${key}${SLOT_KEY_MARKER}${slot}.__record`;
}

function slotChunkKey(key: string, slot: Slot, index: number): string {
  return `${key}${SLOT_KEY_MARKER}${slot}.${index}`;
}

function validCount(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= SESSION_MAX_CHUNKS;
}

function validSlot(value: unknown): value is Slot {
  return value === 0 || value === 1;
}

function validWriteId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= 80 &&
    /^[a-zA-Z0-9_-]+$/.test(value)
  );
}

function parseSlotManifest(value: unknown): SlotManifest | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<SlotManifest>;
  if (
    !validSlot(candidate.slot) ||
    !validWriteId(candidate.writeId) ||
    !validCount(candidate.count) ||
    !Number.isInteger(candidate.length) ||
    Number(candidate.length) < 0 ||
    typeof candidate.checksum !== "string" ||
    !/^[a-f0-9]{16}$/.test(candidate.checksum)
  ) {
    return null;
  }
  return {
    slot: candidate.slot,
    writeId: candidate.writeId,
    count: candidate.count,
    length: Number(candidate.length),
    checksum: candidate.checksum,
  };
}

function parseSlotRecord(raw: string | null): SlotRecord | null {
  if (!raw?.startsWith(SLOT_RECORD_PREFIX)) {
    return null;
  }
  try {
    const candidate = JSON.parse(raw.slice(SLOT_RECORD_PREFIX.length)) as {
      state?: unknown;
    };
    const manifest = parseSlotManifest(candidate);
    if (!manifest || (candidate.state !== "writing" && candidate.state !== "ready")) {
      return null;
    }
    return { ...manifest, state: candidate.state };
  } catch {
    return null;
  }
}

function parseHeader(header: string | null): HeaderState {
  if (header === null) {
    return { kind: "empty" };
  }
  if (header === TOMBSTONE_CLEARING) {
    return { kind: "tombstone", phase: "clearing", raw: header };
  }
  if (header === TOMBSTONE_CLEARED) {
    return { kind: "tombstone", phase: "cleared", raw: header };
  }
  if (header.startsWith(MANIFEST_PREFIX)) {
    try {
      const manifest = parseSlotManifest(JSON.parse(header.slice(MANIFEST_PREFIX.length)));
      return manifest ? { kind: "slot", manifest, raw: header } : { kind: "corrupt" };
    } catch {
      return { kind: "corrupt" };
    }
  }
  if (header.startsWith("CHUNKED:")) {
    const count = Number(header.slice("CHUNKED:".length));
    return validCount(count) ? { kind: "legacy-chunked", count } : { kind: "corrupt" };
  }
  return { kind: "direct", value: header };
}

function serializeManifest(manifest: SlotManifest): string {
  return `${MANIFEST_PREFIX}${JSON.stringify(manifest)}`;
}

function serializeSlotRecord(record: SlotRecord): string {
  return `${SLOT_RECORD_PREFIX}${JSON.stringify(record)}`;
}

function checksum(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    for (const byte of [code & 0xff, code >>> 8]) {
      first ^= byte;
      first = Math.imul(first, 0x01000193);
      second ^= byte + 0x9d;
      second = Math.imul(second, 0x85ebca6b);
      second ^= second >>> 13;
    }
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

function createWriteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function sameManifest(left: SlotManifest, right: SlotManifest): boolean {
  return (
    left.slot === right.slot &&
    left.writeId === right.writeId &&
    left.count === right.count &&
    left.length === right.length &&
    left.checksum === right.checksum
  );
}

async function withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = operationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  operationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (operationTails.get(key) === tail) {
      operationTails.delete(key);
    }
  }
}

async function readSlotChunks(
  store: SessionKeyValueStore,
  key: string,
  manifest: SlotManifest,
): Promise<string | null> {
  let value = "";
  for (let index = 0; index < manifest.count; index += 1) {
    const part = await store.getItem(slotChunkKey(key, manifest.slot, index));
    if (part === null) {
      return null;
    }
    value += part;
  }
  if (value.length !== manifest.length || checksum(value) !== manifest.checksum) {
    return null;
  }
  return value;
}

async function readSealedSlot(
  store: SessionKeyValueStore,
  key: string,
  manifest: SlotManifest,
): Promise<string | null> {
  const expected = serializeSlotRecord({ ...manifest, state: "ready" });
  if ((await store.getItem(slotRecordKey(key, manifest.slot))) !== expected) {
    return null;
  }
  const value = await readSlotChunks(store, key, manifest);
  if (value === null || (await store.getItem(slotRecordKey(key, manifest.slot))) !== expected) {
    return null;
  }
  return value;
}

async function setExact(store: SessionKeyValueStore, key: string, value: string): Promise<void> {
  try {
    await store.setItem(key, value);
  } catch (error) {
    if ((await store.getItem(key)) !== value) {
      throw error;
    }
  }
}

async function removeAllKnownCredentialKeys(
  store: SessionKeyValueStore,
  key: string,
): Promise<void> {
  let firstError: unknown = null;
  const remove = async (candidate: string) => {
    try {
      await store.removeItem(candidate);
    } catch (error) {
      firstError ??= error;
    }
  };

  await remove(`${key}${LEGACY_STAGING_SUFFIX}`);
  for (const slot of [0, 1] as const) {
    await remove(slotRecordKey(key, slot));
    for (let index = 0; index < SESSION_MAX_CHUNKS; index += 1) {
      await remove(slotChunkKey(key, slot, index));
    }
  }
  for (let index = 0; index < SESSION_MAX_CHUNKS; index += 1) {
    await remove(legacyChunkKey(key, index));
  }

  if (firstError !== null) {
    throw firstError;
  }
}

async function finishTombstoneCleanup(store: SessionKeyValueStore, key: string): Promise<void> {
  await removeAllKnownCredentialKeys(store, key);
  if ((await store.getItem(key)) === TOMBSTONE_CLEARING) {
    await setExact(store, key, TOMBSTONE_CLEARED);
  }
}

async function failClosedAndCleanup(store: SessionKeyValueStore, key: string): Promise<void> {
  try {
    await setExact(store, key, TOMBSTONE_CLEARING);
  } catch {
    return;
  }
  await finishTombstoneCleanup(store, key).catch(() => {});
}

async function abortOwnedSlot(
  store: SessionKeyValueStore,
  key: string,
  manifest: SlotManifest,
  forceWhenOwnershipIsGone = false,
): Promise<void> {
  const recordKey = slotRecordKey(key, manifest.slot);
  const observed = parseSlotRecord(await store.getItem(recordKey));
  if ((!observed || !sameManifest(observed, manifest)) && !forceWhenOwnershipIsGone) {
    return;
  }

  const abortedRecord = `${SLOT_ABORT_PREFIX}${manifest.writeId}`;
  await setExact(store, recordKey, abortedRecord).catch(() => {});
  if ((await store.getItem(recordKey)) !== abortedRecord && !forceWhenOwnershipIsGone) {
    return;
  }

  let deletionFailed = false;
  for (let index = 0; index < SESSION_MAX_CHUNKS; index += 1) {
    try {
      await store.removeItem(slotChunkKey(key, manifest.slot, index));
    } catch {
      deletionFailed = true;
    }
  }
  if (!deletionFailed && (await store.getItem(recordKey)) === abortedRecord) {
    await store.removeItem(recordKey).catch(() => {});
  }
}

async function retryAbortedSlotCleanup(
  store: SessionKeyValueStore,
  key: string,
  slot: Slot,
): Promise<void> {
  const recordKey = slotRecordKey(key, slot);
  const abortedRecord = await store.getItem(recordKey);
  if (!abortedRecord?.startsWith(SLOT_ABORT_PREFIX)) {
    return;
  }

  let deletionFailed = false;
  for (let index = 0; index < SESSION_MAX_CHUNKS; index += 1) {
    try {
      await store.removeItem(slotChunkKey(key, slot, index));
    } catch {
      deletionFailed = true;
    }
  }
  if (!deletionFailed && (await store.getItem(recordKey)) === abortedRecord) {
    await store.removeItem(recordKey);
  }
}

async function prepareRootForWrite(
  store: SessionKeyValueStore,
  key: string,
): Promise<{ raw: string | null; state: HeaderState }> {
  let raw = await store.getItem(key);
  let state = parseHeader(raw);
  if (state.kind !== "tombstone" && state.kind !== "corrupt") {
    return { raw, state };
  }

  if (state.kind === "corrupt") {
    await setExact(store, key, TOMBSTONE_CLEARING);
    await finishTombstoneCleanup(store, key);
  } else if (state.phase === "clearing") {
    await finishTombstoneCleanup(store, key);
  }
  raw = await store.getItem(key);
  state = parseHeader(raw);
  return { raw, state };
}

async function readPersistedSessionUnlocked(
  store: SessionKeyValueStore,
  key: string,
): Promise<string | null> {
  await retryAbortedSlotCleanup(store, key, 0).catch(() => {});
  await retryAbortedSlotCleanup(store, key, 1).catch(() => {});
  const raw = await store.getItem(key);
  const state = parseHeader(raw);

  if (state.kind === "empty") {
    return null;
  }
  if (state.kind === "direct") {
    return state.value;
  }
  if (state.kind === "legacy-chunked") {
    let value = "";
    for (let index = 0; index < state.count; index += 1) {
      const part = await store.getItem(legacyChunkKey(key, index));
      if (part === null) {
        if ((await store.getItem(key)) === raw) {
          await failClosedAndCleanup(store, key);
        }
        return null;
      }
      value += part;
    }
    return value;
  }
  if (state.kind === "tombstone") {
    if (state.phase === "clearing") {
      await finishTombstoneCleanup(store, key).catch(() => {});
    }
    return null;
  }
  if (state.kind === "corrupt") {
    if ((await store.getItem(key)) === raw) {
      await failClosedAndCleanup(store, key);
    }
    return null;
  }

  const value = await readSealedSlot(store, key, state.manifest);
  if ((await store.getItem(key)) !== state.raw) {
    return null;
  }
  if (value === null) {
    await failClosedAndCleanup(store, key);
    return null;
  }
  return value;
}

export async function readPersistedSession(
  store: SessionKeyValueStore,
  key: string,
): Promise<string | null> {
  return withKeyLock(key, () => readPersistedSessionUnlocked(store, key));
}

export async function writePersistedSession(
  store: SessionKeyValueStore,
  key: string,
  value: string,
  chunkSize: number = SESSION_CHUNK_SIZE,
): Promise<void> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new Error("invalid_session_chunk_size");
  }

  return withKeyLock(key, async () => {
    const initial = await prepareRootForWrite(store, key);
    const count = Math.max(1, Math.ceil(value.length / chunkSize));
    if (!validCount(count)) {
      throw new Error("session_too_large");
    }

    const slot: Slot = initial.state.kind === "slot" && initial.state.manifest.slot === 0 ? 1 : 0;
    const manifest: SlotManifest = {
      slot,
      writeId: createWriteId(),
      count,
      length: value.length,
      checksum: checksum(value),
    };
    const writingRecord = serializeSlotRecord({ ...manifest, state: "writing" });
    const readyRecord = serializeSlotRecord({ ...manifest, state: "ready" });
    const recordKey = slotRecordKey(key, slot);

    let committedHeader: string | null = null;
    try {
      await store.setItem(recordKey, writingRecord);
      for (let index = 0; index < count; index += 1) {
        await store.setItem(
          slotChunkKey(key, slot, index),
          value.slice(index * chunkSize, (index + 1) * chunkSize),
        );
      }

      if ((await store.getItem(recordKey)) !== writingRecord) {
        throw new Error("concurrent_session_write");
      }
      if ((await readSlotChunks(store, key, manifest)) !== value) {
        throw new Error("session_slot_verification_failed");
      }

      await store.setItem(recordKey, readyRecord);
      if (
        (await store.getItem(recordKey)) !== readyRecord ||
        (await readSlotChunks(store, key, manifest)) !== value
      ) {
        throw new Error("session_slot_seal_failed");
      }
      if ((await store.getItem(key)) !== initial.raw) {
        throw new Error("concurrent_session_write");
      }

      committedHeader = serializeManifest(manifest);
      await setExact(store, key, committedHeader);
      const observed = parseHeader(await store.getItem(key));
      if (
        observed.kind !== "slot" ||
        !sameManifest(observed.manifest, manifest) ||
        (await readSealedSlot(store, key, manifest)) !== value
      ) {
        throw new Error("session_commit_verification_failed");
      }
    } catch (error) {
      await (async () => {
        const currentRoot = await store.getItem(key);
        if (committedHeader !== null && currentRoot === committedHeader) {
          await failClosedAndCleanup(store, key);
          return;
        }
        const currentState = parseHeader(currentRoot);
        await abortOwnedSlot(store, key, manifest, currentState.kind === "tombstone");
      })().catch(() => {});
      throw error;
    }

    if (
      initial.state.kind === "slot" &&
      committedHeader !== null &&
      (await store.getItem(key)) === committedHeader
    ) {
      await abortOwnedSlot(store, key, initial.state.manifest).catch(() => {});
    }
  });
}

export async function clearPersistedSession(
  store: SessionKeyValueStore,
  key: string,
): Promise<void> {
  return withKeyLock(key, async () => {
    await setExact(store, key, TOMBSTONE_CLEARING);
    await finishTombstoneCleanup(store, key);
  });
}
