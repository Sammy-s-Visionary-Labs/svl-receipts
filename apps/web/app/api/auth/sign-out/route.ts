import { AUTH_ERROR_CODES } from "@svl/domain";
import { AuthHttpError, authErrorResponse } from "@/lib/auth/guards";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function POST(request: Request) {
  try {
    const all = new URL(request.url).searchParams.get("all") === "1";
    const scope = all ? "global" : "local";
    const header = request.headers.get("authorization");

    if (header?.startsWith("Bearer ")) {
      const jwt = header.slice("Bearer ".length).trim();
      if (!jwt) {
        throw new AuthHttpError(401, AUTH_ERROR_CODES.unauthenticated, "Sign-out failed");
      }
      try {
        await createServiceRoleClient().auth.admin.signOut(jwt, scope);
      } catch {
        throw new AuthHttpError(401, AUTH_ERROR_CODES.unauthenticated, "Sign-out failed");
      }
      return Response.json({ ok: true, scope });
    }

    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.auth.signOut({ scope });
    if (error) {
      throw new AuthHttpError(401, AUTH_ERROR_CODES.unauthenticated, "Sign-out failed");
    }
    return Response.json({ ok: true, scope });
  } catch (error) {
    return authErrorResponse(error);
  }
}
