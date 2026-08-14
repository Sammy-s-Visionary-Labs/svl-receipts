import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const CHUNK_SIZE = 1800;

async function webGet(key: string): Promise<string | null> {
  return globalThis.localStorage?.getItem(key) ?? null;
}

async function webSet(key: string, value: string): Promise<void> {
  globalThis.localStorage?.setItem(key, value);
}

async function webRemove(key: string): Promise<void> {
  globalThis.localStorage?.removeItem(key);
}

export const sessionStorageAdapter = {
  async getItem(key: string): Promise<string | null> {
    if (Platform.OS === "web" || !(await SecureStore.isAvailableAsync())) {
      return webGet(key);
    }
    const header = await SecureStore.getItemAsync(key);
    if (!header) {
      return null;
    }
    if (!header.startsWith("CHUNKED:")) {
      return header;
    }
    const count = Number(header.slice("CHUNKED:".length));
    let value = "";
    for (let i = 0; i < count; i += 1) {
      value += (await SecureStore.getItemAsync(`${key}.${i}`)) ?? "";
    }
    return value;
  },

  async setItem(key: string, value: string): Promise<void> {
    if (Platform.OS === "web" || !(await SecureStore.isAvailableAsync())) {
      await webSet(key, value);
      return;
    }
    if (value.length <= CHUNK_SIZE) {
      await SecureStore.setItemAsync(key, value);
      return;
    }
    const count = Math.ceil(value.length / CHUNK_SIZE);
    await SecureStore.setItemAsync(key, `CHUNKED:${count}`);
    for (let i = 0; i < count; i += 1) {
      await SecureStore.setItemAsync(
        `${key}.${i}`,
        value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
      );
    }
  },

  async removeItem(key: string): Promise<void> {
    if (Platform.OS === "web" || !(await SecureStore.isAvailableAsync())) {
      await webRemove(key);
      return;
    }
    const header = await SecureStore.getItemAsync(key);
    if (header?.startsWith("CHUNKED:")) {
      const count = Number(header.slice("CHUNKED:".length));
      for (let i = 0; i < count; i += 1) {
        await SecureStore.deleteItemAsync(`${key}.${i}`);
      }
    }
    await SecureStore.deleteItemAsync(key);
  },
};
