import { describe, expect, it } from "vitest";
import {
  clearPersistedSession,
  readPersistedSession,
  SESSION_CHUNK_SIZE,
  type SessionKeyValueStore,
  writePersistedSession,
} from "./session-chunked-store";

function memoryStore(): SessionKeyValueStore & { data: Map<string, string> } {
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

describe("chunked session persistence", () => {
  it("writes chunks before the header and removes leftover chunks when shrinking", async () => {
    const store = memoryStore();
    const longValue = "a".repeat(SESSION_CHUNK_SIZE * 3 + 10);
    await writePersistedSession(store, "session", longValue, SESSION_CHUNK_SIZE);
    expect(store.data.get("session")).toBe("CHUNKED:4");
    expect(store.data.get("session.0")?.length).toBe(SESSION_CHUNK_SIZE);

    await writePersistedSession(store, "session", "short", SESSION_CHUNK_SIZE);
    expect(store.data.get("session")).toBe("short");
    expect(store.data.get("session.0")).toBeUndefined();
    expect(store.data.get("session.3")).toBeUndefined();
  });

  it("clears trailing chunks when the chunk count drops, including beyond the new header", async () => {
    const store = memoryStore();
    await writePersistedSession(
      store,
      "session",
      "a".repeat(SESSION_CHUNK_SIZE * 3),
      SESSION_CHUNK_SIZE,
    );
    await writePersistedSession(
      store,
      "session",
      "b".repeat(SESSION_CHUNK_SIZE + 1),
      SESSION_CHUNK_SIZE,
    );
    expect(store.data.get("session")).toBe("CHUNKED:2");
    expect(store.data.get("session.2")).toBeUndefined();
  });

  it("removes every described and leftover chunk on sign-out", async () => {
    const store = memoryStore();
    await writePersistedSession(
      store,
      "session",
      "a".repeat(SESSION_CHUNK_SIZE * 2),
      SESSION_CHUNK_SIZE,
    );
    store.data.set("session.5", "orphan-token");
    await clearPersistedSession(store, "session");
    expect(store.data.get("session")).toBeUndefined();
    expect(store.data.get("session.0")).toBeUndefined();
    expect(store.data.get("session.5")).toBeUndefined();
  });

  it("treats a missing chunk as a corrupt session and clears it", async () => {
    const store = memoryStore();
    await writePersistedSession(
      store,
      "session",
      "a".repeat(SESSION_CHUNK_SIZE * 2),
      SESSION_CHUNK_SIZE,
    );
    store.data.delete("session.1");
    await expect(readPersistedSession(store, "session")).resolves.toBeNull();
    expect(store.data.get("session")).toBeUndefined();
  });
});
