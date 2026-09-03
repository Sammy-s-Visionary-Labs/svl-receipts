import { randomUUID } from "node:crypto";
import {
  actorMayReadReceipt,
  type ConfirmedReceiptPage,
  canonicalReceiptUploadId,
  createReceiptUploadServerMetric,
  evaluateReceiptTransition,
  isReceiptContentType,
  isSha256Checksum,
  MAX_RECEIPT_PAGES,
  normalizeChecksum,
  receiptManifestDigestInput,
} from "@svl/domain";
import { AuthHttpError, requireActor } from "@/lib/auth/guards";
import { rpcHttpError } from "@/lib/db/errors";
import { HttpError } from "@/lib/http";
import {
  checksumsMatch,
  objectMatchesSession,
  readReceiptObject,
  sha256Hex,
} from "@/lib/storage/receipts";
import { createServiceRoleClient } from "@/lib/supabase/service";
import { committedConfirmationReplay } from "./confirmation-replay";

type RequestedConfirmation = {
  pageIndex: number;
  checksum: string;
};

type ReceiptRow = {
  id: string;
  owner_user_id: string;
  status: string;
  cleanup_claimed_at: string | null;
  submitted_at: string | null;
};

type ReceiptPageRow = {
  page_index: number;
  storage_key: string;
  content_type: string;
  checksum: string | null;
  byte_size: number | null;
};

export async function confirmReceiptUpload(request: Request, rawReceiptId: string) {
  // Reject untrusted route text before entering the metric-producing flow. Only
  // the canonical UUID below may be queried or emitted as a correlation id.
  const receiptId = canonicalReceiptUploadId(rawReceiptId);
  if (!receiptId) {
    throw new HttpError(400, "invalid_request", "Receipt id must be a UUID");
  }
  const startedAt = Date.now();
  let pageCount = 0;
  try {
    const { actor, supabase } = await requireActor(request, "POST /api/receipts/[id]/confirm");
    const requestedPages = parseRequestedConfirmations(await readJson(request));
    pageCount = requestedPages.length;

    const { data, error } = await supabase
      .from("receipts")
      .select("id, owner_user_id, status, cleanup_claimed_at, submitted_at")
      .eq("id", receiptId)
      .maybeSingle();
    if (error || !data) {
      throw new AuthHttpError(403, "forbidden", "Receipt access denied");
    }

    const row = data as ReceiptRow;
    if (!actorMayReadReceipt(actor, row.owner_user_id) || actor.userId !== row.owner_user_id) {
      throw new AuthHttpError(403, "forbidden", "Receipt access denied");
    }

    const pageRows = await loadReceiptPages(supabase, receiptId);
    assertExactPageSet(pageRows, requestedPages);

    if (row.status !== "upload_pending") {
      // The acknowledgement may be lost after the database commits. Readability
      // can advance the receipt to processing (or beyond) before the durable
      // mobile queue replays this exact confirmation, so submitted_at plus the
      // immutable confirmed checksums is the idempotency fence.
      const replay = committedConfirmationReplay({
        id: row.id,
        status: row.status,
        submittedAt: row.submitted_at,
        checksumsMatch: storedChecksumsMatch(pageRows, requestedPages),
      });
      if (replay) {
        logMetric(
          "confirmation_api_completed",
          receiptId,
          pageCount,
          Date.now() - startedAt,
          "success",
        );
        return replay;
      }
      throw new HttpError(409, "conflict", "Receipt is not awaiting upload confirmation");
    }
    if (row.cleanup_claimed_at) {
      throw new HttpError(409, "conflict", "Upload session is no longer available");
    }

    const confirmedPages: ConfirmedReceiptPage[] = [];
    for (const page of pageRows) {
      if (!isReceiptContentType(page.content_type)) {
        throw new HttpError(409, "conflict", "Upload session is incomplete");
      }
      const object = await readReceiptObject(page.storage_key);
      if (!object) {
        throw new HttpError(404, "not_found", `Uploaded page ${page.page_index + 1} is missing`);
      }
      if (
        !objectMatchesSession({
          bytes: object.bytes,
          contentType: object.contentType,
          expectedContentType: page.content_type,
        })
      ) {
        throw new HttpError(409, "conflict", `Uploaded page ${page.page_index + 1} is invalid`);
      }
      const expected = requestedPages[page.page_index];
      const actualChecksum = sha256Hex(object.bytes);
      if (!expected || !checksumsMatch(expected.checksum, actualChecksum)) {
        throw new HttpError(
          409,
          "conflict",
          `Checksum for uploaded page ${page.page_index + 1} does not match`,
        );
      }
      confirmedPages.push({
        pageIndex: page.page_index,
        checksum: actualChecksum,
        byteSize: object.bytes.byteLength,
      });
    }

    const transition = evaluateReceiptTransition({
      from: row.status,
      to: "submitted",
      actorId: actor.userId,
      occurredAt: new Date(),
    });
    if (!transition.ok) {
      throw new HttpError(409, "conflict", "Illegal status transition");
    }

    const manifestChecksum = sha256Hex(Buffer.from(receiptManifestDigestInput(confirmedPages)));
    const totalByteSize = confirmedPages.reduce((total, page) => total + page.byteSize, 0);
    const service = createServiceRoleClient();
    const { data: submitted, error: submitError } = await service.rpc(
      "submit_confirmed_receipt_set",
      {
        p_receipt_id: row.id,
        p_actor_id: actor.userId,
        p_pages: confirmedPages,
        p_manifest_checksum: manifestChecksum,
        p_total_byte_size: totalByteSize,
        p_correlation_id: randomUUID(),
      },
    );
    if (submitError) {
      console.error("[upload-confirm]", { receiptId, code: submitError.code });
      throw rpcHttpError(submitError);
    }

    const result = submitted as { id?: string; status?: string; submittedAt?: string } | null;
    logMetric(
      "confirmation_api_completed",
      receiptId,
      pageCount,
      Date.now() - startedAt,
      "success",
    );
    return {
      id: result?.id ?? row.id,
      status: result?.status ?? "submitted",
      submittedAt: result?.submittedAt ?? new Date().toISOString(),
    };
  } catch (error) {
    logMetric("confirmation_api_failed", receiptId, pageCount, Date.now() - startedAt, "failure");
    throw error;
  }
}

function parseRequestedConfirmations(value: unknown): RequestedConfirmation[] {
  const pages = (value as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > MAX_RECEIPT_PAGES) {
    throw new HttpError(400, "invalid_request", `pages must contain 1-${MAX_RECEIPT_PAGES} items`);
  }
  return pages.map((raw, pageIndex) => {
    if (!raw || typeof raw !== "object") {
      throw new HttpError(400, "invalid_request", "Each page confirmation must be an object");
    }
    const page = raw as Record<string, unknown>;
    if (
      page.pageIndex !== pageIndex ||
      typeof page.checksum !== "string" ||
      !isSha256Checksum(page.checksum)
    ) {
      throw new HttpError(400, "invalid_request", "Page confirmations must be ordered checksums");
    }
    return { pageIndex, checksum: normalizeChecksum(page.checksum) };
  });
}

async function loadReceiptPages(
  supabase: Awaited<ReturnType<typeof requireActor>>["supabase"],
  receiptId: string,
): Promise<ReceiptPageRow[]> {
  const { data, error } = await supabase
    .from("receipt_pages")
    .select("page_index, storage_key, content_type, checksum, byte_size")
    .eq("receipt_id", receiptId)
    .order("page_index", { ascending: true });
  if (error) {
    throw new AuthHttpError(403, "forbidden", "Receipt access denied");
  }
  return (data ?? []) as ReceiptPageRow[];
}

function assertExactPageSet(rows: ReceiptPageRow[], requested: RequestedConfirmation[]) {
  if (
    rows.length !== requested.length ||
    rows.some((page, index) => page.page_index !== index || requested[index]?.pageIndex !== index)
  ) {
    throw new HttpError(409, "conflict", "The full receipt page set was not supplied");
  }
}

function storedChecksumsMatch(rows: ReceiptPageRow[], requested: RequestedConfirmation[]): boolean {
  return rows.every((page, index) => {
    const expected = requested[index];
    return Boolean(page.checksum && expected && checksumsMatch(page.checksum, expected.checksum));
  });
}

function logMetric(
  event: "confirmation_api_completed" | "confirmation_api_failed",
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
