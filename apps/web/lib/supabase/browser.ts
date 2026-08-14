import { createBrowserClient } from "@supabase/ssr";
import { getSupabasePublicEnv } from "./env";

export function createBrowserSupabaseClient() {
  const { url, key } = getSupabasePublicEnv();
  return createBrowserClient(url, key);
}
