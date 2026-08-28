import {
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_PAGES,
  parseReceiptUploadTelemetryEvent,
  type ReceiptUploadTelemetryEvent,
} from "@svl/domain";
import { apiBaseUrl } from "@/lib/api/client";
import type { ReceiptLocationMetadata } from "@/lib/capture/receipt-pages";
import { UploadTransportError } from "./errors";
import type {
  PreparedUploadPage,
  ReceiptSubmissionAcknowledgement,
  ReceiptUploadSession,
  ReceiptUploadTarget,
} from "./types";

export type ReceiptUploadUrlPolicy = "production" | "development";

const DEVELOPMENT_HTTP_UPLOAD_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "10.0.2.2"]);

export async function postReceiptUploadSession(input: {
  accessToken: string;
  clientSubmissionId: string;
  pages: PreparedUploadPage[];
  location: ReceiptLocationMetadata | null;
}): Promise<ReceiptUploadSession> {
  const response = await authenticatedFetch("/api/upload-sessions", input.accessToken, {
    method: "POST",
    body: JSON.stringify({
      clientSubmissionId: input.clientSubmissionId,
      pages: input.pages.map((page) => ({
        pageIndex: page.pageIndex,
        contentType: page.contentType,
        originalFilename: page.originalFilename,
      })),
      location: input.location,
    }),
  });
  if (!response.ok) {
    throw await responseError(response, "session");
  }
  return parseReceiptUploadSession(await response.json(), runtimeUploadUrlPolicy());
}

export async function putReceiptPage(
  target: ReceiptUploadTarget,
  page: PreparedUploadPage,
  signal: AbortSignal,
): Promise<void> {
  try {
    const body = page.bytes.buffer.slice(
      page.bytes.byteOffset,
      page.bytes.byteOffset + page.bytes.byteLength,
    ) as ArrayBuffer;
    const response = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: {
        "cache-control": "max-age=3600",
        "content-type": target.allowedContentType,
        "x-upsert": "false",
      },
      body,
      signal,
    });
    // If the first response was lost, the non-upsert retry can find the exact
    // object already present. Server confirmation remains the integrity gate.
    if (response.ok || response.status === 409) {
      return;
    }
    if (response.status === 401 || response.status === 403) {
      throw new UploadTransportError("session_expired", "The upload session expired");
    }
    throw new UploadTransportError("storage_rejected", "Storage rejected a receipt page");
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new UploadTransportError("cancelled", "Upload cancelled");
    }
    if (error instanceof UploadTransportError) {
      throw error;
    }
    throw new UploadTransportError("network", "The receipt page could not be uploaded");
  }
}

export async function postReceiptConfirmation(input: {
  accessToken: string;
  receiptId: string;
  pages: PreparedUploadPage[];
}): Promise<ReceiptSubmissionAcknowledgement> {
  const response = await authenticatedFetch(
    `/api/receipts/${encodeURIComponent(input.receiptId)}/confirm`,
    input.accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        pages: input.pages.map((page) => ({
          pageIndex: page.pageIndex,
          checksum: page.checksum,
        })),
      }),
    },
  );
  if (!response.ok) {
    throw await responseError(response, "confirmation");
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    value.status !== "submitted" ||
    typeof value.submittedAt !== "string" ||
    Number.isNaN(Date.parse(value.submittedAt))
  ) {
    throw new UploadTransportError("invalid_response", "Confirmation response was incomplete");
  }
  return { id: value.id, status: "submitted", submittedAt: value.submittedAt };
}

export async function postReceiptUploadEvent(
  accessToken: string,
  rawEvent: ReceiptUploadTelemetryEvent,
): Promise<void> {
  const event = parseReceiptUploadTelemetryEvent(rawEvent);
  if (!event) {
    return;
  }
  try {
    await authenticatedFetch("/api/upload-events", accessToken, {
      method: "POST",
      body: JSON.stringify(event),
    });
  } catch {
    // Metrics never control field submission success.
  }
}

async function authenticatedFetch(path: string, accessToken: string, init: RequestInit) {
  try {
    return await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new UploadTransportError("network", "The receipt service could not be reached");
  }
}

async function responseError(response: Response, phase: "session" | "confirmation") {
  if (response.status === 401 || response.status === 403) {
    return new UploadTransportError("unauthorized", "Your session is no longer authorized");
  }
  if (response.status === 409 && phase === "session") {
    return new UploadTransportError("session_expired", "The upload session cannot be resumed");
  }
  if (phase === "confirmation") {
    return new UploadTransportError(
      "confirmation_rejected",
      "The server could not confirm every receipt page",
    );
  }
  return new UploadTransportError("network", "Upload session creation failed");
}

export function isAllowedReceiptUploadUrl(rawUrl: string, policy: ReceiptUploadUrlPolicy): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!url.hostname || url.username || url.password) {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (policy !== "development" || url.protocol !== "http:") {
    return false;
  }
  const hostname =
    url.hostname.startsWith("[") && url.hostname.endsWith("]")
      ? url.hostname.slice(1, -1)
      : url.hostname;
  return DEVELOPMENT_HTTP_UPLOAD_HOSTS.has(hostname);
}

export function parseReceiptUploadSession(
  value: unknown,
  urlPolicy: ReceiptUploadUrlPolicy,
): ReceiptUploadSession {
  if (!value || typeof value !== "object") {
    throw new UploadTransportError("invalid_response", "Upload session response was incomplete");
  }
  const session = value as Record<string, unknown>;
  if (typeof session.receiptId !== "string") {
    throw new UploadTransportError("invalid_response", "Upload session response was incomplete");
  }
  if (session.status === "submitted") {
    if (typeof session.submittedAt !== "string" || Number.isNaN(Date.parse(session.submittedAt))) {
      throw new UploadTransportError(
        "invalid_response",
        "Submitted receipt response was incomplete",
      );
    }
    return {
      receiptId: session.receiptId,
      status: "submitted",
      submittedAt: session.submittedAt,
      targets: [],
    };
  }
  if (
    session.status !== "upload_pending" ||
    typeof session.expiresAt !== "string" ||
    Number.isNaN(Date.parse(session.expiresAt)) ||
    !Array.isArray(session.targets) ||
    session.targets.length < 1 ||
    session.targets.length > MAX_RECEIPT_PAGES
  ) {
    throw new UploadTransportError("invalid_response", "Upload session response was incomplete");
  }
  const targets = session.targets.map((raw, pageIndex) => parseTarget(raw, pageIndex, urlPolicy));
  return {
    receiptId: session.receiptId,
    status: "upload_pending",
    expiresAt: session.expiresAt,
    targets,
  };
}

function parseTarget(
  value: unknown,
  pageIndex: number,
  urlPolicy: ReceiptUploadUrlPolicy,
): ReceiptUploadTarget {
  if (!value || typeof value !== "object") {
    throw new UploadTransportError("invalid_response", "Upload target was incomplete");
  }
  const target = value as Record<string, unknown>;
  if (
    target.pageIndex !== pageIndex ||
    typeof target.storageKey !== "string" ||
    target.storageKey.length === 0 ||
    typeof target.uploadUrl !== "string" ||
    !isAllowedReceiptUploadUrl(target.uploadUrl, urlPolicy) ||
    typeof target.token !== "string" ||
    target.allowedContentType !== "image/jpeg" ||
    target.maxBytes !== MAX_RECEIPT_BYTES
  ) {
    throw new UploadTransportError("invalid_response", "Upload target was incomplete");
  }
  return {
    pageIndex,
    storageKey: target.storageKey,
    uploadUrl: target.uploadUrl,
    token: target.token,
    allowedContentType: "image/jpeg",
    maxBytes: target.maxBytes,
  };
}

function runtimeUploadUrlPolicy(): ReceiptUploadUrlPolicy {
  return typeof __DEV__ !== "undefined" && __DEV__ ? "development" : "production";
}
