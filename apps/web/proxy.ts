import { AUTH_ERROR_CODES } from "@svl/domain";
import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "./lib/supabase/proxy-session";

function isPublicPath(pathname: string): boolean {
  return (
    ["/login", "/worker-login", "/request-access", "/api/access-requests"].includes(pathname) ||
    pathname.startsWith("/login/")
  );
}

export async function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/field/manifest.webmanifest") return NextResponse.next();
  const { supabaseResponse, signedIn } = await updateSession(request);
  const { pathname } = request.nextUrl;
  const hasBearer = request.headers.get("authorization")?.startsWith("Bearer ");

  if (signedIn || isPublicPath(pathname) || (pathname.startsWith("/api/") && hasBearer)) {
    return supabaseResponse;
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: AUTH_ERROR_CODES.unauthenticated, message: "Sign in required" } },
      { status: 401 },
    );
  }

  const login = request.nextUrl.clone();
  login.pathname = pathname.startsWith("/field") ? "/worker-login" : "/login";
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
