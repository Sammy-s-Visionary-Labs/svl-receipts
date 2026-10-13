import { timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { AuthHttpError, getActorFromCookies, requireManager } from "@/lib/auth/guards";
import {
  isLoopbackHost,
  laborDevelopmentEnabled,
  laborFeatureEnabled,
  laborLocalPreviewEnabled,
} from "./config";

export function requireLaborDevelopment(request: Request) {
  if (!laborDevelopmentEnabled()) throw new AuthHttpError(404, "not_found", "Not found");
  const url = new URL(request.url);
  if (!isLoopbackHost(url.hostname))
    throw new AuthHttpError(403, "development_only", "Local development access required");
  const origin = request.headers.get("origin");
  const requestHost = request.headers.get("host");
  const expectedOrigin = requestHost
    ? new URL(`${url.protocol}//${requestHost}`).origin
    : url.origin;
  if (!isLoopbackHost(new URL(expectedOrigin).hostname))
    throw new AuthHttpError(403, "development_only", "Local development access required");
  if (origin && origin !== expectedOrigin)
    throw new AuthHttpError(403, "invalid_origin", "Same-origin request required");
}

export function isLaborWorker(request: Request): boolean {
  const expected = process.env.LABOR_WORKER_TOKEN;
  const supplied = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!expected || !supplied || expected.length < 32 || supplied.length !== expected.length)
    return false;
  if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected)) return false;
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export async function requireLaborAccess(request: Request, allowWorker = false) {
  if (!laborFeatureEnabled()) throw new AuthHttpError(404, "not_found", "Not found");
  const url = new URL(request.url);
  const local =
    laborLocalPreviewEnabled() &&
    isLoopbackHost(url.hostname) &&
    isLoopbackHost((request.headers.get("host") ?? url.host).split(":")[0]);
  if (allowWorker && isLaborWorker(request)) return { actor: null, supabase: null, worker: true };
  if (
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !request.headers.get("authorization")
  ) {
    const origin = request.headers.get("origin");
    const expected = new URL(`${url.protocol}//${request.headers.get("host") ?? url.host}`).origin;
    if (origin !== expected)
      throw new AuthHttpError(403, "invalid_origin", "Same-origin request required");
  }
  if (local)
    return {
      actor: { userId: "local-development", role: "admin" as const, disabled: false },
      supabase: null,
      worker: false,
    };
  return { ...(await requireManager(request, new URL(request.url).pathname)), worker: false };
}

export function requireLaborWorker(request: Request) {
  if (!laborFeatureEnabled()) throw new AuthHttpError(404, "not_found", "Not found");
  if (!isLaborWorker(request))
    throw new AuthHttpError(401, "unauthenticated", "Worker token required");
}

export async function getLaborPageActor() {
  if (!laborFeatureEnabled()) notFound();
  const host = (await headers()).get("host") ?? "";
  const hostname = new URL(`http://${host}`).hostname;
  if (isLoopbackHost(hostname) && laborLocalPreviewEnabled())
    return { userId: "local-development", role: "admin" as const, disabled: false };
  const actor = await getActorFromCookies();
  if (!actor) redirect("/login");
  if (actor.role === "worker") redirect("/field");
  return { ...actor, role: actor.role };
}
