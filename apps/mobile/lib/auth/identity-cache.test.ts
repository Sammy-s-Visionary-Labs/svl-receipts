import { describe, expect, it } from "vitest";
import { clearCachedIdentity, readCachedIdentity, writeCachedIdentity } from "./identity-cache";

describe("identity cache", () => {
  it("round-trips a worker identity and clears on sign-out", async () => {
    const data = new Map<string, string>();
    const store = {
      async getItem(key: string) {
        return data.get(key) ?? null;
      },
      async setItem(key: string, value: string) {
        data.set(key, value);
      },
      async removeItem(key: string) {
        data.delete(key);
      },
    };

    await writeCachedIdentity(store, { userId: "u1", role: "worker" });
    expect(await readCachedIdentity(store)).toEqual({ userId: "u1", role: "worker" });
    await clearCachedIdentity(store);
    expect(await readCachedIdentity(store)).toBeNull();
  });
});
