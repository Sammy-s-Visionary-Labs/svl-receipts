import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  clearPersistedSession,
  readPersistedSession,
  type SessionKeyValueStore,
  writePersistedSession,
} from "./session-chunked-store";

const memoryStore: SessionKeyValueStore = {
  async getItem(key) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  async setItem(key, value) {
    globalThis.localStorage?.setItem(key, value);
  },
  async removeItem(key) {
    globalThis.localStorage?.removeItem(key);
  },
};

const secureStore: SessionKeyValueStore = {
  async getItem(key) {
    return SecureStore.getItemAsync(key);
  },
  async setItem(key, value) {
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key) {
    await SecureStore.deleteItemAsync(key);
  },
};

async function activeStore(): Promise<SessionKeyValueStore> {
  if (Platform.OS === "web" || !(await SecureStore.isAvailableAsync())) {
    return memoryStore;
  }
  return secureStore;
}

export const sessionStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    return readPersistedSession(await activeStore(), key);
  },

  async setItem(key: string, value: string): Promise<void> {
    await writePersistedSession(await activeStore(), key, value);
  },

  async removeItem(key: string): Promise<void> {
    await clearPersistedSession(await activeStore(), key);
  },
};
