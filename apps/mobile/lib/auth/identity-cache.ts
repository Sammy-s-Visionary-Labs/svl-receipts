const IDENTITY_KEY = "svl.identity.v1";

export type CachedIdentity = {
  userId: string;
  role: string;
};

type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export async function readCachedIdentity(store: KeyValueStore): Promise<CachedIdentity | null> {
  const raw = await store.getItem(IDENTITY_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CachedIdentity;
    if (typeof parsed.userId !== "string" || typeof parsed.role !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeCachedIdentity(
  store: KeyValueStore,
  identity: CachedIdentity,
): Promise<void> {
  await store.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export async function clearCachedIdentity(store: KeyValueStore): Promise<void> {
  await store.removeItem(IDENTITY_KEY);
}

export { IDENTITY_KEY };
