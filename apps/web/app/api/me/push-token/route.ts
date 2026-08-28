import { AUTH_ERROR_CODES, isExpoPushToken } from "@svl/domain";
import { AuthHttpError, authErrorResponse, requireActor } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError, httpErrorResponse } from "@/lib/http";
import { createServiceRoleClient } from "@/lib/supabase/service";

export async function POST(request: Request) {
  try {
    const { actor } = await requireActor(request, "POST /api/me/push-token");
    if (actor.role !== "worker") {
      throw new AuthHttpError(403, AUTH_ERROR_CODES.forbidden, "Worker role required");
    }

    const body = (await readJson(request)) as { token?: unknown; platform?: unknown };
    if (typeof body.token !== "string" || !isExpoPushToken(body.token)) {
      throw new HttpError(400, "invalid_request", "token is required");
    }
    const platform = parsePlatform(body.platform);
    if (!platform) {
      throw new HttpError(400, "invalid_request", "platform is required");
    }

    const { error } = await createServiceRoleClient().rpc("upsert_device_push_token", {
      p_user_id: actor.userId,
      p_token: body.token.trim(),
      p_platform: platform,
    });
    if (error) {
      console.error("[push-token]", error);
      throw rpcHttpError(error);
    }
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return httpErrorResponse(error);
    }
    return authErrorResponse(error);
  }
}

function parsePlatform(value: unknown): "ios" | "android" | "web" | null {
  return value === "ios" || value === "android" || value === "web" ? value : null;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, "invalid_request", "Invalid JSON");
  }
}
