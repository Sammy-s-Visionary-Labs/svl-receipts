import { MAX_RECEIPT_BYTES, MAX_RECEIPT_PAGES } from "@svl/domain";
import type { fieldApi } from "./api";
import type { FieldDraft } from "./drafts";

type Target = {
  pageIndex: number;
  uploadUrl: string;
  allowedContentType: string;
  maxBytes: number;
};
type Session = { receiptId: string; status: string; submittedAt?: string; targets: Target[] };
export type Acknowledgement = { id: string; status: string; submittedAt: string };
type Dependencies = {
  api: typeof fieldApi;
  put: typeof fetch;
  save: (draft: FieldDraft) => Promise<void>;
  progress: (message: string) => void;
};

export function validUploadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "https:" ||
        (process.env.NODE_ENV !== "production" &&
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}

export async function submitDraft(
  draft: FieldDraft,
  dependencies: Dependencies,
): Promise<Acknowledgement> {
  const { api, put, save, progress } = dependencies;
  const identity = await api<{ userId: string }>("/api/me", { signal: AbortSignal.timeout(8000) });
  if (identity.userId !== draft.ownerId)
    throw new Error("Sign in with the account that saved this draft.");
  if (
    draft.pages.length < 1 ||
    draft.pages.length > MAX_RECEIPT_PAGES ||
    draft.pages.some(
      (p) => p.blob.type !== "image/jpeg" || p.blob.size < 1 || p.blob.size > MAX_RECEIPT_BYTES,
    )
  ) {
    throw new Error("Add between 1 and 5 valid receipt photos before sending.");
  }
  // Persist the immutable page set before any remote side effect. Every retry uses this same ID.
  draft.started = true;
  await save(draft);
  const remaining = draft.pages
    .map((_, index) => index)
    .filter((index) => !draft.uploaded.includes(index));
  if (remaining.length) {
    progress("Connecting to the receipt service…");
    const session = await api<Session>("/api/upload-sessions", {
      method: "POST",
      body: JSON.stringify({
        clientSubmissionId: draft.id,
        pages: draft.pages.map((_, pageIndex) => ({
          pageIndex,
          contentType: "image/jpeg",
          originalFilename: `receipt-page-${pageIndex + 1}.jpg`,
        })),
        location: draft.location,
      }),
    });
    if (session.receiptId !== draft.id)
      throw new Error("The service returned the wrong receipt. Your draft is saved.");
    if (
      session.status === "submitted" &&
      session.submittedAt &&
      !Number.isNaN(Date.parse(session.submittedAt))
    ) {
      return { id: draft.id, status: "submitted", submittedAt: session.submittedAt };
    }
    if (
      session.status !== "upload_pending" ||
      !Array.isArray(session.targets) ||
      session.targets.length !== draft.pages.length ||
      session.targets.some(
        (target, index) =>
          target.pageIndex !== index ||
          target.allowedContentType !== "image/jpeg" ||
          target.maxBytes !== MAX_RECEIPT_BYTES ||
          !validUploadUrl(target.uploadUrl),
      )
    ) {
      throw new Error("The upload could not be prepared safely. Your draft is saved; try again.");
    }
    for (const index of remaining) {
      progress(`Sending page ${index + 1} of ${draft.pages.length}…`);
      const response = await put(session.targets[index].uploadUrl, {
        method: "PUT",
        credentials: "omit",
        body: draft.pages[index].blob,
        headers: {
          "Content-Type": "image/jpeg",
          "x-upsert": "false",
          "cache-control": "max-age=3600",
        },
        signal: AbortSignal.timeout(90_000),
      });
      // A lost response can leave the exact object already present. Confirmation verifies its checksum.
      if (!response.ok && response.status !== 409)
        throw new Error("A photo could not be sent. Your draft is saved; try again.");
      draft.uploaded = [...draft.uploaded, index];
      await save(draft);
    }
  }
  // Once all PUTs are saved, retries go directly to the idempotent confirmation, even after processing starts.
  progress("Confirming your receipt…");
  const acknowledgement = await api<Acknowledgement>(`/api/receipts/${draft.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({
      pages: draft.pages.map((page, pageIndex) => ({ pageIndex, checksum: page.checksum })),
    }),
  });
  if (
    acknowledgement.id !== draft.id ||
    acknowledgement.status !== "submitted" ||
    !acknowledgement.submittedAt ||
    Number.isNaN(Date.parse(acknowledgement.submittedAt))
  ) {
    throw new Error(
      "We could not confirm delivery yet. Retry this saved draft to check without sending a duplicate.",
    );
  }
  return acknowledgement;
}
