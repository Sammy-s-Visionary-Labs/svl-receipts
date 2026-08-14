import { AUTH_ERROR_CODES } from "@svl/domain";
import { type NextRequest, NextResponse } from "next/server";
import { updateSession } from "./lib/supabase/proxy-session";

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/login/");
}

export async function proxy(request: NextRequest) {
  const { supabaseResponse, signedIn } = await updateSession(request);
  const { pathname } = request.nextUrl;

  if (signedIn || isPublicPath(pathname)) {
    return supabaseResponse;
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: { code: AUTH_ERROR_CODES.unauthenticated, message: "Sign in required" } },
      { status: 401 },
    );
  }

  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.searchParams.set("next", pathname);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
