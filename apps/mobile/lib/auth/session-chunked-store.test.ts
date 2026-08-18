import { describe, expect, it, vi } from "vitest";
import {
  clearPersistedSession,
  readPersistedSession,
  SESSION_CHUNK_SIZE,
  type SessionKeyValueStore,
  writePersistedSession,
} from "./session-chunked-store";

type MemoryStore = SessionKeyValueStore & { data: Map<string, string> };

function memoryStore(): MemoryStore {
  const data = new Map<string, string>();
  return {
    data,
    async getItem(key) {
      return data.get(key) ?? null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
    async removeItem(key) {
      data.delete(key);
    },
  };
}

function slotKeys(store: MemoryStore, key = "session"): string[] {
  return [...store.data.keys()].filter((candidate) =>
    candidate.startsWith(`${key}.__svl_session_slot_`),
  );
}

function sessionValue(character: string): string {
  return JSON.stringify({
    access_token: character.repeat(2200),
    refresh_token: character.repeat(2200),
    expires_at: 123,
  });
}

function supabaseSessionValue(character: string): string {
  return JSON.stringify({
    access_token: `access-${character}-${character.repeat(1200)}`,
    refresh_token: `refresh-${character}-${character.toLowerCase().repeat(2200)}`,
    expires_at: 123,
    token_type: "bearer",
  });
}

describe("two-slot session persistence", () => {
  it("still reads legacy direct and CHUNKED sessions", async () => {
    const store = memoryStore();
    store.data.set("direct", "legacy-direct-session");
    store.data.set("chunked", "CHUNKED:2");
    store.data.set("chunked.0", "legacy-");
    store.data.set("chunked.1", "chunked-session");

    await expect(readPersistedSession(store, "direct")).resolves.toBe("legacy-direct-session");
    await expect(readPersistedSession(store, "chunked")).resolves.toBe("legacy-chunked-session");
  });

  it("keeps the old complete session when an inactive-slot write is interrupted", async () => {
    const store = memoryStore();
    const oldValue = sessionValue("A");
    await writePersistedSession(store, "session", oldValue);
    let newChunkWrites = 0;

    const interruptedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        if (key.includes(".__svl_session_slot_1.")) {
          newChunkWrites += 1;
          if (newChunkWrites === 3) {
            throw new Error("simulated_process_interruption");
          }
        }
        store.data.set(key, value);
      },
      async removeItem() {
        // A killed process cannot run the writer's best-effort cleanup.
        throw new Error("simulated_process_interruption");
      },
    };

    await expect(
      writePersistedSession(interruptedStore, "session", sessionValue("B")),
    ).rejects.toThrow("simulated_process_interruption");

    const recovered = await readPersistedSession(store, "session");
    expect(recovered).toBe(oldValue);
    expect(recovered).not.toContain('"access_token":"B');
    expect([...store.data.keys()].some((key) => key.includes("staging"))).toBe(false);
    expect([...store.data.keys()].some((key) => key.includes(".__svl_session_generation_"))).toBe(
      false,
    );
    expect(slotKeys(store).every((key) => /\.__svl_session_slot_[01]\./.test(key))).toBe(true);
    await clearPersistedSession(store, "session");
    expect(slotKeys(store)).toEqual([]);
  });

  it("keeps the old complete session when the manifest switch fails before commit", async () => {
    const store = memoryStore();
    const oldValue = sessionValue("A");
    await writePersistedSession(store, "session", oldValue);
    const oldHeader = store.data.get("session");

    const interruptedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        if (key === "session" && value !== oldHeader) {
          throw new Error("manifest_not_committed");
        }
        store.data.set(key, value);
      },
      removeItem: store.removeItem,
    };

    await expect(
      writePersistedSession(interruptedStore, "session", sessionValue("B")),
    ).rejects.toThrow("manifest_not_committed");
    await expect(readPersistedSession(store, "session")).resolves.toBe(oldValue);
  });

  it("uses the new complete session when the manifest committed before an error was reported", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", sessionValue("A"));
    const newValue = sessionValue("B");
    let injected = false;

    const ambiguousStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        store.data.set(key, value);
        if (key === "session" && !injected) {
          injected = true;
          throw new Error("manifest_committed_then_interrupted");
        }
      },
      removeItem: store.removeItem,
    };

    await expect(
      writePersistedSession(ambiguousStore, "session", newValue),
    ).resolves.toBeUndefined();
    await expect(readPersistedSession(store, "session")).resolves.toBe(newValue);
  });

  it("fails closed and clears an incomplete or corrupted active slot", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", sessionValue("A"));
    const [firstChunk] = slotKeys(store).filter((key) => /\.\d+$/.test(key));
    expect(firstChunk).toBeDefined();
    store.data.set(firstChunk, `${store.data.get(firstChunk)}corrupt`);

    await expect(readPersistedSession(store, "session")).resolves.toBeNull();
    expect(slotKeys(store)).toEqual([]);
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("retries interrupted inactive-slot cleanup on read", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", sessionValue("A"));
    const oldSlotKeys = slotKeys(store);
    const failedChunk = oldSlotKeys.find((key) => /\.\d+$/.test(key));
    expect(failedChunk).toBeDefined();
    let failedCleanup = false;

    const cleanupInterruptedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      setItem: store.setItem,
      async removeItem(key) {
        if (!failedCleanup && key === failedChunk) {
          failedCleanup = true;
          throw new Error("cleanup_interrupted");
        }
        store.data.delete(key);
      },
    };

    const newValue = sessionValue("B");
    await expect(
      writePersistedSession(cleanupInterruptedStore, "session", newValue),
    ).resolves.toBeUndefined();
    expect(oldSlotKeys.some((key) => store.data.has(key))).toBe(true);

    await expect(readPersistedSession(store, "session")).resolves.toBe(newValue);
    expect(oldSlotKeys.some((key) => store.data.has(key))).toBe(false);
  });

  it("cleans the inactive slot when shrinking and removes all credentials on sign-out", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", sessionValue("A"));
    const oldSlotKeys = slotKeys(store);

    await writePersistedSession(store, "session", "short");
    await expect(readPersistedSession(store, "session")).resolves.toBe("short");
    expect(oldSlotKeys.some((key) => store.data.has(key))).toBe(false);
    expect(slotKeys(store)).toHaveLength(2);

    // Also remove a chunk left by the legacy chunked-to-direct implementation.
    store.data.set("session.5", "orphan-token");
    await clearPersistedSession(store, "session");
    expect(slotKeys(store)).toEqual([]);
    expect(store.data.get("session.5")).toBeUndefined();
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("fails closed when a legacy CHUNKED session is incomplete", async () => {
    const store = memoryStore();
    store.data.set("session", "CHUNKED:2");
    store.data.set("session.0", "partial-token");

    await expect(readPersistedSession(store, "session")).resolves.toBeNull();
    expect(store.data.get("session.0")).toBeUndefined();
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("exhaustively removes both deterministic slots when the root manifest is corrupt", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", supabaseSessionValue("A"));
    await writePersistedSession(store, "session", supabaseSessionValue("B"));
    store.data.set("session.31", "legacy-secret");
    expect(slotKeys(store)).not.toHaveLength(0);

    const root = store.data.get("session");
    expect(root).toBeDefined();
    store.data.set("session", root?.slice(0, -1) ?? "corrupt");

    await expect(readPersistedSession(store, "session")).resolves.toBeNull();
    expect(slotKeys(store)).toEqual([]);
    expect(store.data.get("session.31")).toBeUndefined();
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("retains deterministic cleanup discoverability after precommit and deletion failures", async () => {
    const store = memoryStore();
    const oldValue = supabaseSessionValue("A");
    await writePersistedSession(store, "session", oldValue);
    const oldHeader = store.data.get("session");

    const failedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        if (key === "session" && value !== oldHeader) {
          throw new Error("manifest_not_committed");
        }
        store.data.set(key, value);
      },
      async removeItem(key) {
        if (key.includes(".__svl_session_slot_1.")) {
          throw new Error("precommit_delete_failed");
        }
        store.data.delete(key);
      },
    };

    await expect(
      writePersistedSession(failedStore, "session", supabaseSessionValue("B")),
    ).rejects.toThrow("manifest_not_committed");
    await expect(readPersistedSession(store, "session")).resolves.toBe(oldValue);

    await clearPersistedSession(store, "session");
    expect(slotKeys(store)).toEqual([]);
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("keeps a fixed-size tombstone across repeated cleanup failures and later recovers", async () => {
    const store = memoryStore();
    await writePersistedSession(store, "session", supabaseSessionValue("A"));
    const deletionFailedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      setItem: store.setItem,
      async removeItem(key) {
        if (key.includes(".__svl_session_slot_")) {
          throw new Error("cleanup_interrupted");
        }
        store.data.delete(key);
      },
    };

    await expect(clearPersistedSession(deletionFailedStore, "session")).rejects.toThrow(
      "cleanup_interrupted",
    );
    const tombstone = store.data.get("session");
    expect(tombstone).toBe("SVL_SESSION_CLEARING_V3");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(readPersistedSession(deletionFailedStore, "session")).resolves.toBeNull();
      expect(store.data.get("session")).toBe(tombstone);
      expect(store.data.get("session")?.length).toBeLessThan(64);
    }

    await expect(readPersistedSession(store, "session")).resolves.toBeNull();
    expect(slotKeys(store)).toEqual([]);
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("cleans a stale writer that observes sign-out after sealing its slot", async () => {
    const runtimeA = await import("./session-chunked-store");
    vi.resetModules();
    const runtimeB = await import("./session-chunked-store");
    const store = memoryStore();
    await runtimeA.writePersistedSession(store, "session", supabaseSessionValue("A"));

    let rootReads = 0;
    let releaseRootCheck = () => {};
    let reportRootCheck = () => {};
    const rootCheckReached = new Promise<void>((resolve) => {
      reportRootCheck = resolve;
    });
    const rootCheckRelease = new Promise<void>((resolve) => {
      releaseRootCheck = resolve;
    });
    const pausedWriterStore: SessionKeyValueStore = {
      async getItem(key) {
        if (key === "session") {
          rootReads += 1;
          if (rootReads === 2) {
            reportRootCheck();
            await rootCheckRelease;
          }
        }
        return store.data.get(key) ?? null;
      },
      setItem: store.setItem,
      removeItem: store.removeItem,
    };

    const staleWrite = runtimeA.writePersistedSession(
      pausedWriterStore,
      "session",
      supabaseSessionValue("B"),
    );
    await rootCheckReached;
    await runtimeB.clearPersistedSession(store, "session");
    releaseRootCheck();

    await expect(staleWrite).rejects.toThrow("concurrent_session_write");
    await expect(runtimeB.readPersistedSession(store, "session")).resolves.toBeNull();
    expect(slotKeys(store)).toEqual([]);
    expect([...store.data.values()].some((value) => value.includes("access-B-"))).toBe(false);
    expect([...store.data.values()].some((value) => value.includes("refresh-B-"))).toBe(false);
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("scrubs chunks written after sign-out removed a stale writer record", async () => {
    const runtimeA = await import("./session-chunked-store");
    vi.resetModules();
    const runtimeB = await import("./session-chunked-store");
    const store = memoryStore();
    await runtimeA.writePersistedSession(store, "session", supabaseSessionValue("A"));

    let releaseFirstChunk = () => {};
    let reportFirstChunk = () => {};
    const firstChunkReached = new Promise<void>((resolve) => {
      reportFirstChunk = resolve;
    });
    const firstChunkRelease = new Promise<void>((resolve) => {
      releaseFirstChunk = resolve;
    });
    let paused = false;
    const pausedWriterStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        if (!paused && key === "session.__svl_session_slot_1.0") {
          paused = true;
          reportFirstChunk();
          await firstChunkRelease;
        }
        store.data.set(key, value);
      },
      removeItem: store.removeItem,
    };

    const staleWrite = runtimeA.writePersistedSession(
      pausedWriterStore,
      "session",
      supabaseSessionValue("B"),
    );
    await firstChunkReached;
    expect(store.data.has("session.__svl_session_slot_1.__record")).toBe(true);
    await runtimeB.clearPersistedSession(store, "session");
    expect(slotKeys(store)).toEqual([]);
    releaseFirstChunk();

    await expect(staleWrite).rejects.toThrow("concurrent_session_write");
    await expect(runtimeB.readPersistedSession(store, "session")).resolves.toBeNull();
    expect(slotKeys(store)).toEqual([]);
    expect([...store.data.values()].some((value) => value.includes("access-B-"))).toBe(false);
    expect([...store.data.values()].some((value) => value.includes("refresh-B-"))).toBe(false);
    expect(store.data.get("session")).toBe("SVL_SESSION_CLEARED_V3");
  });

  it("fails closed instead of returning mixed Supabase tokens from two runtimes", async () => {
    const runtimeA = await import("./session-chunked-store");
    vi.resetModules();
    const runtimeB = await import("./session-chunked-store");
    const store = memoryStore();
    const pending = new Map<string, Array<{ value: string; resolve: () => void }>>();
    const interleavedStore: SessionKeyValueStore = {
      getItem: store.getItem,
      async setItem(key, value) {
        const isWritingRecord = key.endsWith(".__record") && value.includes('"state":"writing"');
        const isChunk = /\.__svl_session_slot_[01]\.\d+$/.test(key);
        if (!isWritingRecord && !isChunk) {
          store.data.set(key, value);
          return;
        }
        await new Promise<void>((resolve) => {
          const waiting = pending.get(key) ?? [];
          waiting.push({ value, resolve });
          pending.set(key, waiting);
          if (waiting.length !== 2) {
            return;
          }
          const [first, second] = waiting;
          if (!first || !second) {
            throw new Error("missing_interleaved_write");
          }
          const chunkIndex = Number(key.slice(key.lastIndexOf(".") + 1));
          const last = isChunk && chunkIndex % 2 === 1 ? first : second;
          store.data.set(key, last.value);
          pending.delete(key);
          first.resolve();
          second.resolve();
        });
      },
      removeItem: store.removeItem,
    };
    const valueA = supabaseSessionValue("A");
    const valueB = supabaseSessionValue("B");
    expect(() => JSON.parse(valueA)).not.toThrow();
    expect(() => JSON.parse(valueB)).not.toThrow();

    const results = await Promise.allSettled([
      runtimeA.writePersistedSession(interleavedStore, "session", valueA),
      runtimeB.writePersistedSession(interleavedStore, "session", valueB),
    ]);
    expect(results.some((result) => result.status === "rejected")).toBe(true);
    const recovered = await readPersistedSession(store, "session");
    expect(recovered === null || recovered === valueA || recovered === valueB).toBe(true);
    if (recovered !== null) {
      const parsed = JSON.parse(recovered) as { access_token: string; refresh_token: string };
      const marker = parsed.access_token.includes("access-A-") ? "A" : "B";
      expect(parsed.refresh_token).toContain(`refresh-${marker}-`);
    }

    await clearPersistedSession(store, "session");
    expect(slotKeys(store)).toEqual([]);
  });

  it("rejects invalid chunk sizes and values beyond the bounded manifest", async () => {
    const store = memoryStore();
    await expect(writePersistedSession(store, "session", "value", 0)).rejects.toThrow(
      "invalid_session_chunk_size",
    );
    await expect(
      writePersistedSession(store, "session", "x".repeat(SESSION_CHUNK_SIZE * 33)),
    ).rejects.toThrow("session_too_large");
  });
});
