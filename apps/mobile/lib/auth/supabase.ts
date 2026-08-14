import { createClient } from "@supabase/supabase-js";
import { sessionStorageAdapter } from "./session-storage";

function readEnv(): { url: string; key: string } {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error("Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY");
  }
  return { url, key };
}

let client: ReturnType<typeof createClient> | null = null;

export function getMobileSupabaseClient() {
  if (client) {
    return client;
  }
  const { url, key } = readEnv();
  client = createClient(url, key, {
    auth: {
      storage: sessionStorageAdapter,
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
    },
  });
  return client;
}
