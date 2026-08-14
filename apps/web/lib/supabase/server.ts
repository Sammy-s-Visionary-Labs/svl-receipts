import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabasePublicEnv } from "./env";

export async function createServerSupabaseClient() {
  const cookieStore = await cookies();
  const { url, key } = getSupabasePublicEnv();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet, _headers) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot always persist cookies; proxy.ts refreshes the session.
        }
      },
    },
  });
}
