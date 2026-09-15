import { MAX_RECEIPT_BYTES } from "@svl/domain";
import { describe, expect, it, vi } from "vitest";
import type { fieldApi } from "./api";
import type { FieldDraft } from "./drafts";
import { submitDraft, validUploadUrl } from "./submission";

function fixture() {
  const draft: FieldDraft = {
    id: "b3700000-0000-4000-8000-000000000001",
    ownerId: "worker-a",
    createdAt: "2026-09-15T10:00:00Z",
    pages: [0, 1].map((index) => ({
      id: `page-${index}`,
      blob: new Blob([`image-${index}`], { type: "image/jpeg" }),
      checksum: `${index}`.repeat(64),
      width: 900,
      height: 1800,
    })),
    location: null,
    started: false,
    uploaded: [],
  };
  const acknowledgement = {
    id: draft.id,
    status: "submitted",
    submittedAt: "2026-09-15T12:00:00Z",
  };
  const session = {
    receiptId: draft.id,
    status: "upload_pending",
    targets: draft.pages.map((_, pageIndex) => ({
      pageIndex,
      uploadUrl: `https://storage.example.invalid/page-${pageIndex}`,
      allowedContentType: "image/jpeg",
      maxBytes: MAX_RECEIPT_BYTES,
    })),
  };
  const api = vi.fn(async (path: string) =>
    path === "/api/me"
      ? { userId: draft.ownerId }
      : path === "/api/upload-sessions"
        ? session
        : acknowledgement,
  );
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const saved: FieldDraft[] = [];
  const save = vi.fn(async (value: FieldDraft) => {
    saved.push(structuredClone(value));
  });
  const dependencies = {
    api: api as typeof fieldApi,
    put: put as typeof fetch,
    save,
    progress: vi.fn(),
  };
  return { draft, session, acknowledgement, api, put, save, saved, dependencies };
}

describe("worker web submission through the existing API", () => {
  it("sends the ordered page set and checksums, persisting the draft before remote writes", async () => {
    const f = fixture();
    f.api.mockImplementation(async (path) => {
      if (path === "/api/me") return { userId: f.draft.ownerId };
      expect(f.saved[0].started).toBe(true);
      return path === "/api/upload-sessions" ? f.session : f.acknowledgement;
    });
    expect(await submitDraft(f.draft, f.dependencies)).toEqual(f.acknowledgement);
    expect(f.put).toHaveBeenCalledTimes(2);
    const calls = f.api.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(String(calls[1][1].body)).clientSubmissionId).toBe(f.draft.id);
    expect(JSON.parse(String(calls[2][1].body)).pages).toEqual(
      f.draft.pages.map((page, pageIndex) => ({ pageIndex, checksum: page.checksum })),
    );
    expect(f.saved.at(-1)?.uploaded).toEqual([0, 1]);
  });
  it("resumes after a failed page without re-uploading confirmed progress or generating another receipt", async () => {
    const f = fixture();
    f.put
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockRejectedValueOnce(new Error("offline"));
    await expect(submitDraft(f.draft, f.dependencies)).rejects.toThrow("offline");
    const recovered = structuredClone(f.saved.at(-1) as FieldDraft);
    expect(recovered.uploaded).toEqual([0]);
    expect(await submitDraft(recovered, f.dependencies)).toEqual(f.acknowledgement);
    expect(f.put).toHaveBeenCalledTimes(3);
    expect(f.api.mock.calls.filter(([path]) => path.endsWith("/confirm"))).toHaveLength(1);
  });
  it("replays only confirmation after a lost acknowledgement and page processing has already started", async () => {
    const f = fixture();
    f.draft.started = true;
    f.draft.uploaded = [0, 1];
    await submitDraft(f.draft, f.dependencies);
    expect(f.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/me",
      `/api/receipts/${f.draft.id}/confirm`,
    ]);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("uses the server checksum gate after a duplicate-object response", async () => {
    const f = fixture();
    f.put.mockResolvedValue(new Response(null, { status: 409 }));
    await expect(submitDraft(f.draft, f.dependencies)).resolves.toEqual(f.acknowledgement);
    expect(f.api.mock.calls.at(-1)?.[0]).toContain("/confirm");
  });
  it("never sends a draft from another account", async () => {
    const f = fixture();
    f.api.mockResolvedValueOnce({ userId: "worker-b" });
    await expect(submitDraft(f.draft, f.dependencies)).rejects.toThrow("account that saved");
    expect(f.put).not.toHaveBeenCalled();
    expect(f.save).not.toHaveBeenCalled();
  });
  it("does not create a remote session if durable draft saving fails", async () => {
    const f = fixture();
    f.save.mockRejectedValue(new Error("storage full"));
    await expect(submitDraft(f.draft, f.dependencies)).rejects.toThrow("storage full");
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.put).not.toHaveBeenCalled();
  });
  it("rejects incomplete page targets before uploading any bytes", async () => {
    const f = fixture();
    f.session.targets.pop();
    await expect(submitDraft(f.draft, f.dependencies)).rejects.toThrow("prepared safely");
    expect(f.put).not.toHaveBeenCalled();
  });
  it("does not report sent when the acknowledgement belongs to another receipt", async () => {
    const f = fixture();
    f.acknowledgement.id = "other-id";
    await expect(submitDraft(f.draft, f.dependencies)).rejects.toThrow(
      "could not confirm delivery",
    );
  });
  it("rejects insecure and credential-bearing upload addresses", () => {
    expect(validUploadUrl("https://storage.example.invalid/object")).toBe(true);
    for (const value of [
      "javascript:alert(1)",
      "http://storage.example.invalid/object",
      "https://user:secret@example.invalid/object",
      "//example.invalid",
    ])
      expect(validUploadUrl(value)).toBe(false);
  });
});
