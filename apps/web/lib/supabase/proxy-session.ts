import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { readSupabasePublicEnv } from "./env";

export async function updateSession(request: NextRequest) {
  const env = readSupabasePublicEnv();
  if (!env) {
    return { supabaseResponse: NextResponse.next({ request }), signedIn: false };
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(env.url, env.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          supabaseResponse.cookies.set(name, value, options);
        }
        for (const [headerName, headerValue] of Object.entries(headers)) {
          supabaseResponse.headers.set(headerName, headerValue);
        }
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  return { supabaseResponse, signedIn: Boolean(data?.claims) };
}
