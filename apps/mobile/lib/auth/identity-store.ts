import { parseUserRole } from "@svl/domain";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import {
  type CachedIdentity,
  clearCachedIdentity,
  readCachedIdentity,
  writeCachedIdentity,
} from "./identity-cache";
import type { MeIdentity } from "./phase";

const memoryStore = {
  async getItem(key: string) {
    return globalThis.localStorage?.getItem(key) ?? null;
  },
  async setItem(key: string, value: string) {
    globalThis.localStorage?.setItem(key, value);
  },
  async removeItem(key: string) {
    globalThis.localStorage?.removeItem(key);
  },
};

const secureStore = {
  async getItem(key: string) {
    return SecureStore.getItemAsync(key);
  },
  async setItem(key: string, value: string) {
    await SecureStore.setItemAsync(key, value);
  },
  async removeItem(key: string) {
    await SecureStore.deleteItemAsync(key);
  },
};

async function activeStore() {
  if (Platform.OS === "web" || !(await SecureStore.isAvailableAsync())) {
    return memoryStore;
  }
  return secureStore;
}

export async function loadPersistedIdentity(userId: string): Promise<MeIdentity | null> {
  const cached = await readCachedIdentity(await activeStore());
  if (!cached || cached.userId !== userId) {
    return null;
  }
  const role = parseUserRole(cached.role);
  if (!role) {
    return null;
  }
  return { userId: cached.userId, role };
}

export async function persistIdentity(identity: MeIdentity): Promise<void> {
  const record: CachedIdentity = { userId: identity.userId, role: identity.role };
  await writeCachedIdentity(await activeStore(), record);
}

export async function clearPersistedIdentity(): Promise<void> {
  await clearCachedIdentity(await activeStore());
}
