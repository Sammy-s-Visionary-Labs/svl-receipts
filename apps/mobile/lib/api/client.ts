import Constants from "expo-constants";
import { type IdentityError, type MeIdentity, parseMeIdentity } from "@/lib/auth/phase";
import { resolveApiBaseUrl } from "./config";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function apiBaseUrl(): string {
  return resolveApiBaseUrl({
    envUrl: process.env.EXPO_PUBLIC_API_URL,
    hostUri: Constants.expoConfig?.hostUri ?? null,
  });
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, init);
}

export async function fetchMe(
  accessToken: string,
): Promise<{ ok: true; identity: MeIdentity } | { ok: false; error: IdentityError }> {
  let response: Response;
  try {
    response = await apiFetch("/api/me", {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, error: "network" };
  }

  if (response.status === 401) {
    return { ok: false, error: "inactive" };
  }
  if (!response.ok) {
    return { ok: false, error: "network" };
  }

  const identity = parseMeIdentity(await response.json());
  if (!identity) {
    return { ok: false, error: "inactive" };
  }
  return { ok: true, identity };
}

export async function postSignOut(accessToken: string, everywhere: boolean): Promise<void> {
  const query = everywhere ? "?all=1" : "";
  await apiFetch(`/api/auth/sign-out${query}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

export async function postPushToken(
  accessToken: string,
  token: string,
  platform: "ios" | "android" | "web",
): Promise<void> {
  const response = await apiFetch("/api/me/push-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, platform }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, "internal", "Push token was not stored");
  }
}
