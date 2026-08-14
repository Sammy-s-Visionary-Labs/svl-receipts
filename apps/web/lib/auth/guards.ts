import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  AUTH_ERROR_CODES,
  type AuthzActor,
  actorMayAccessAdminOps,
  actorMayAccessManagerOps,
  actorMayReadReceipt,
  actorMayUseApp,
  parseUserRole,
} from "@svl/domain";
import { getSupabasePublicEnv, readSupabasePublicEnv } from "@/lib/supabase/env";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export class AuthHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AuthHttpError";
    this.status = status;
    this.code = code;
  }
}

type ProfileRow = { id: string; role: string; disabled: boolean };

function logDenied(route: string, actor: AuthzActor | null, reason: string) {
  console.warn("[authz-denied]", { route, userId: actor?.userId ?? null, reason });
}

function toActor(profile: ProfileRow): AuthzActor | null {
  const role = parseUserRole(profile.role);
  if (!role) {
    return null;
  }
  return { userId: profile.id, role, disabled: profile.disabled };
}

async function supabaseForRequest(request: Request): Promise<SupabaseClient> {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const { url, key } = getSupabasePublicEnv();
    return createClient(url, key, {
      global: { headers: { Authorization: header } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return createServerSupabaseClient();
}

export async function getActorFromCookies(): Promise<AuthzActor | null> {
  if (!readSupabasePublicEnv()) {
    return null;
  }
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }
  const actor = await loadProfile(supabase, user.id);
  if (!actor || !actorMayUseApp(actor)) {
    return null;
  }
  return actor;
}

async function loadProfile(supabase: SupabaseClient, userId: string): Promise<AuthzActor | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, role, disabled")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }
  return toActor(data as ProfileRow);
}

export async function requireActor(
  request: Request,
  route: string,
): Promise<{
  actor: AuthzActor;
  supabase: SupabaseClient;
}> {
  const supabase = await supabaseForRequest(request);
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    logDenied(route, null, AUTH_ERROR_CODES.unauthenticated);
    throw new AuthHttpError(401, AUTH_ERROR_CODES.unauthenticated, "Sign in required");
  }

  const actor = await loadProfile(supabase, user.id);
  if (!actor || !actorMayUseApp(actor)) {
    logDenied(route, actor, AUTH_ERROR_CODES.unauthenticated);
    throw new AuthHttpError(401, AUTH_ERROR_CODES.unauthenticated, "Account is not active");
  }

  return { actor, supabase };
}

export async function requireManager(request: Request, route: string) {
  const ctx = await requireActor(request, route);
  if (!actorMayAccessManagerOps(ctx.actor)) {
    logDenied(route, ctx.actor, AUTH_ERROR_CODES.forbidden);
    throw new AuthHttpError(403, AUTH_ERROR_CODES.forbidden, "Manager role required");
  }
  return ctx;
}

export async function requireAdmin(request: Request, route: string) {
  const ctx = await requireActor(request, route);
  if (!actorMayAccessAdminOps(ctx.actor)) {
    logDenied(route, ctx.actor, AUTH_ERROR_CODES.forbidden);
    throw new AuthHttpError(403, AUTH_ERROR_CODES.forbidden, "Admin role required");
  }
  return ctx;
}

export async function requireReceiptAccess(
  request: Request,
  route: string,
  receiptId: string,
): Promise<{ actor: AuthzActor; ownerUserId: string }> {
  const { actor, supabase } = await requireActor(request, route);
  const { data, error } = await supabase
    .from("receipts")
    .select("id, owner_user_id")
    .eq("id", receiptId)
    .maybeSingle();

  if (error || !data) {
    logDenied(route, actor, AUTH_ERROR_CODES.forbidden);
    throw new AuthHttpError(403, AUTH_ERROR_CODES.forbidden, "Receipt access denied");
  }

  const row = data as { id: string; owner_user_id: string };
  const ownerUserId = row.owner_user_id;
  if (!actorMayReadReceipt(actor, ownerUserId)) {
    logDenied(route, actor, AUTH_ERROR_CODES.forbidden);
    throw new AuthHttpError(403, AUTH_ERROR_CODES.forbidden, "Receipt access denied");
  }

  return { actor, ownerUserId };
}

export function authErrorResponse(error: unknown): Response {
  if (error instanceof AuthHttpError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  console.error("[authz-error]", error);
  return Response.json({ error: { code: "internal", message: "Request failed" } }, { status: 500 });
}
