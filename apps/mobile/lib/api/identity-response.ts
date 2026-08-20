import { AUTH_ERROR_CODES } from "@svl/domain";
import { type IdentityError, type MeIdentity, parseMeIdentity } from "../auth/phase";

export type IdentityResult =
  | { ok: true; identity: MeIdentity }
  | { ok: false; error: IdentityError };

export async function identityResultFromResponse(response: Response): Promise<IdentityResult> {
  if (response.status === 401) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: unknown };
    } | null;
    return {
      ok: false,
      error: body?.error?.code === AUTH_ERROR_CODES.accountInactive ? "inactive" : "revoked",
    };
  }
  if (!response.ok) {
    return { ok: false, error: "network" };
  }

  const identity = parseMeIdentity(await response.json().catch(() => null));
  return identity ? { ok: true, identity } : { ok: false, error: "inactive" };
}
