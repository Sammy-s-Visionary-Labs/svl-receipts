import { randomUUID } from "node:crypto";
import {
  ALLOWED_RECEIPT_CONTENT_TYPES,
  buildReceiptStorageKey,
  createReceiptUploadServerMetric,
  isReceiptContentType,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_PAGES,
  type ReceiptContentType,
  UPLOAD_SESSION_TTL_SECONDS,
} from "@svl/domain";
import { AuthHttpError } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError } from "@/lib/http";
import { createReceiptUploadTarget } from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";

type SessionBody = {
  clientSubmissionId?: unknown;
  pages?: unknown;
  location?: unknown;
};

type RequestedPage = {
  pageIndex: number;
  contentType: ReceiptContentType;
  originalFilename: string | null;
};

type StoredPage = {
  page_index: number;
  storage_key: string;
  content_type: string;
};

type StoredReceipt = {
  id: string;
  owner_user_id: string;
  status: string;
  cleanup_claimed_at: string | null;
  submitted_at: string | null;
};

type ReceiptLocation = {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  capturedAt: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createOrResumeUploadSession(userId: string, rawBody: unknown) {
  const startedAt = Date.now();
  const body = (rawBody ?? {}) as SessionBody;
  const receiptId = parseSubmissionId(body.clientSubmissionId);
  const pages = parseRequestedPages(body.pages);
  const location = parseLocation(body.location);
  const service = createServiceRoleClient();

  try {
    const existing = await loadReceipt(service, receiptId);
    if (existing) {
      assertResumableReceipt(existing, userId);
      if (existing.status === "submitted") {
        return {
          receiptId,
          status: "submitted" as const,
          submittedAt: existing.submitted_at,
          targets: [],
        };
      }
      const storedPages = await loadStoredPages(service, receiptId);
      assertPageContract(storedPages, pages);
      const response = await signedSessionResponse(receiptId, storedPages);
      logMetric(
        "session_api_completed",
        receiptId,
        storedPages.length,
        Date.now() - startedAt,
        "success",
      );
      return response;
    }

    const pendingPages = pages.map((page) => ({
      pageIndex: page.pageIndex,
      storageKey: buildReceiptStorageKey({
        ownerUserId: userId,
        receiptId,
        objectId: randomUUID(),
        contentType: page.contentType,
      }),
      contentType: page.contentType,
      originalFilename: page.originalFilename,
    }));

    const { error: insertError } = await service.rpc("create_upload_pending_receipt_set", {
      p_actor_id: userId,
      p_receipt_id: receiptId,
      p_pages: pendingPages,
      p_gps_lat: location.latitude,
      p_gps_lng: location.longitude,
      p_gps_accuracy_meters: location.accuracyMeters,
      p_gps_captured_at: location.capturedAt,
      p_correlation_id: randomUUID(),
    });
    if (insertError) {
      console.error("[upload-session]", { receiptId, code: insertError.code });
      throw rpcHttpError(insertError);
    }

    // A concurrent retry can win the insert. Always sign the stored object keys.
    const storedPages = await loadStoredPages(service, receiptId);
    assertPageContract(storedPages, pages);
    const response = await signedSessionResponse(receiptId, storedPages);
    logMetric(
      "session_api_completed",
      receiptId,
      storedPages.length,
      Date.now() - startedAt,
      "success",
    );
    return response;
  } catch (error) {
    logMetric("session_api_failed", receiptId, pages.length, Date.now() - startedAt, "failure");
    throw error;
  }
}

function parseSubmissionId(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new HttpError(400, "invalid_request", "clientSubmissionId must be a UUID");
  }
  return value.toLowerCase();
}

function parseRequestedPages(value: unknown): RequestedPage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_RECEIPT_PAGES) {
    throw new HttpError(400, "invalid_request", `pages must contain 1-${MAX_RECEIPT_PAGES} items`);
  }
  return value.map((raw, pageIndex) => {
    if (!raw || typeof raw !== "object") {
      throw new HttpError(400, "invalid_request", "Each page must be an object");
    }
    const page = raw as Record<string, unknown>;
    if (page.pageIndex !== pageIndex || !isReceiptContentType(String(page.contentType ?? ""))) {
      throw new HttpError(400, "invalid_request", "Pages must be ordered with supported types");
    }
    return {
      pageIndex,
      contentType: page.contentType as ReceiptContentType,
      originalFilename:
        typeof page.originalFilename === "string" && page.originalFilename.length > 0
          ? page.originalFilename.slice(0, 255)
          : null,
    };
  });
}

function parseLocation(value: unknown): ReceiptLocation {
  const empty: ReceiptLocation = {
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    capturedAt: null,
  };
  if (value === null || value === undefined) {
    return empty;
  }
  if (!value || typeof value !== "object") {
    throw new HttpError(400, "invalid_request", "location must be an object or null");
  }
  const location = value as Record<string, unknown>;
  const { latitude, longitude, accuracyMeters, capturedAt } = location;
  if (
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    (accuracyMeters !== null &&
      accuracyMeters !== undefined &&
      (typeof accuracyMeters !== "number" ||
        !Number.isFinite(accuracyMeters) ||
        accuracyMeters < 0)) ||
    typeof capturedAt !== "string" ||
    Number.isNaN(Date.parse(capturedAt))
  ) {
    throw new HttpError(400, "invalid_request", "location sample is invalid");
  }
  return {
    latitude,
    longitude,
    accuracyMeters: typeof accuracyMeters === "number" ? accuracyMeters : null,
    capturedAt,
  };
}

async function loadReceipt(
  service: ReturnType<typeof createServiceRoleClient>,
  id: string,
): Promise<StoredReceipt | null> {
  const { data, error } = await service
    .from("receipts")
    .select("id, owner_user_id, status, cleanup_claimed_at, submitted_at")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    throw new HttpError(500, "internal", "Upload session lookup failed");
  }
  return data as StoredReceipt | null;
}

async function loadStoredPages(
  service: ReturnType<typeof createServiceRoleClient>,
  id: string,
): Promise<StoredPage[]> {
  const { data, error } = await service
    .from("receipt_pages")
    .select("page_index, storage_key, content_type")
    .eq("receipt_id", id)
    .order("page_index", { ascending: true });
  if (error) {
    throw new HttpError(500, "internal", "Upload page lookup failed");
  }
  return (data ?? []) as StoredPage[];
}

function assertResumableReceipt(receipt: StoredReceipt, userId: string) {
  if (receipt.owner_user_id !== userId) {
    throw new AuthHttpError(403, "forbidden", "Receipt access denied");
  }
  if (receipt.status !== "upload_pending" && receipt.status !== "submitted") {
    throw new HttpError(409, "conflict", "Receipt upload can no longer be resumed");
  }
  if (receipt.cleanup_claimed_at) {
    throw new HttpError(409, "conflict", "Upload session is no longer available");
  }
}

function assertPageContract(stored: StoredPage[], requested: RequestedPage[]) {
  if (
    stored.length !== requested.length ||
    stored.some(
      (page, index) =>
        page.page_index !== index || page.content_type !== requested[index]?.contentType,
    )
  ) {
    throw new HttpError(409, "conflict", "Receipt page set does not match the original session");
  }
}

async function signedSessionResponse(receiptId: string, pages: StoredPage[]) {
  const targets = await Promise.all(
    pages.map(async (page) => {
      const upload = await createReceiptUploadTarget(page.storage_key);
      return {
        pageIndex: page.page_index,
        storageKey: page.storage_key,
        uploadUrl: upload.signedUrl,
        token: upload.token,
        allowedContentType: page.content_type,
        maxBytes: MAX_RECEIPT_BYTES,
      };
    }),
  );
  return {
    receiptId,
    status: "upload_pending" as const,
    expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_SECONDS * 1000).toISOString(),
    allowedContentTypes: ALLOWED_RECEIPT_CONTENT_TYPES,
    maxBytes: MAX_RECEIPT_BYTES,
    maxPages: MAX_RECEIPT_PAGES,
    targets,
  };
}

function logMetric(
  event: "session_api_completed" | "session_api_failed",
  receiptId: string,
  pageCount: number,
  durationMs: number,
  result: "success" | "failure",
) {
  const metric = createReceiptUploadServerMetric({
    event,
    receiptId,
    pageCount,
    durationMs,
    result,
  });
  if (metric) {
    console.info("[receipt-upload-server-metric]", metric);
  }
}
