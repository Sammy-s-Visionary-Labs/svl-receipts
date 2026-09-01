import Constants from "expo-constants";
import * as Device from "expo-device";
import { Platform } from "react-native";
import type { IdentityError, MeIdentity } from "@/lib/auth/phase";
import { resolveApiBaseUrl } from "./config";
import { identityResultFromResponse } from "./identity-response";
import {
  parseReceiptReadabilityStatus,
  parseRecentReceiptsResponse,
  type ReceiptReadabilityStatus,
  type RecentReceipt,
} from "./receipt-response";

export type { ReceiptReadabilityStatus, RecentReceipt } from "./receipt-response";

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
    platform: Platform.OS,
    isDevice: Device.isDevice,
  });
}

async function apiFetch(path: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetch(`${apiBaseUrl()}${path}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
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

  return identityResultFromResponse(response);
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

export async function fetchReceiptReadability(
  accessToken: string,
  receiptId: string,
): Promise<ReceiptReadabilityStatus> {
  let response: Response;
  try {
    response = await apiFetch(`/api/receipts/${encodeURIComponent(receiptId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new ApiError(0, "network", "Readability status could not be reached");
  }
  if (!response.ok) {
    throw new ApiError(
      response.status,
      response.status === 401 ? "unauthenticated" : "internal",
      "Readability status could not be loaded",
    );
  }
  try {
    const parsed = parseReceiptReadabilityStatus(await response.json());
    if (!parsed) {
      throw new ApiError(502, "invalid_response", "Readability status response was invalid");
    }
    return parsed;
  } catch {
    throw new ApiError(502, "invalid_response", "Readability status response was invalid");
  }
}

export async function fetchRecentReceipts(accessToken: string): Promise<RecentReceipt[]> {
  const response = await apiFetch("/api/me/receipts", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new ApiError(response.status, "internal", "Recent receipts could not be loaded");
  }
  let parsed: RecentReceipt[] | null;
  try {
    parsed = parseRecentReceiptsResponse(await response.json());
  } catch {
    parsed = null;
  }
  if (!parsed) {
    throw new ApiError(502, "invalid_response", "Recent receipts response was invalid");
  }
  return parsed;
}
