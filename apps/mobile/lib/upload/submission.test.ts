import { describe, expect, it, vi } from "vitest";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";
import { executeReceiptSubmission, ReceiptSubmissionError } from "./submission";
import type {
  PreparedUploadPage,
  ReceiptSubmissionDependencies,
  ReceiptUploadAttempt,
} from "./types";

const receiptPages = [receiptPage("file:///one.jpg"), receiptPage("file:///two.jpg")];

function receiptPage(uri: string): ReceiptPage {
  return {
    uri,
    width: 800,
    height: 1200,
    source: "camera",
    imageMetadata: {
      originalWidth: 800,
      originalHeight: 1200,
      finalWidth: 800,
      finalHeight: 1200,
      finalBytes: 3,
      mimeType: "image/jpeg",
      preparedAt: "2026-08-21T12:00:00.000Z",
    },
    quality: { status: "unavailable", metrics: null, hints: [] },
  };
}

function prepared(pageIndex: number): PreparedUploadPage {
  return {
    pageIndex,
    bytes: new Uint8Array([pageIndex, 1, 2]),
    checksum: String(pageIndex + 1).repeat(64),
    byteSize: 3,
    contentType: "image/jpeg",
    originalFilename: null,
  };
}

function dependencies(order: string[]): ReceiptSubmissionDependencies {
  let now = Date.parse("2026-08-21T12:00:00.000Z");
  return {
    createSubmissionId: () => "11111111-1111-4111-8111-111111111111",
    preparePage: async (_page, pageIndex) => {
      order.push(`prepare:${pageIndex}`);
      return prepared(pageIndex);
    },
    createSession: async ({ clientSubmissionId, pages }) => {
      order.push("session");
      return {
        receiptId: clientSubmissionId,
        status: "upload_pending",
        expiresAt: "2026-08-21T14:00:00.000Z",
        targets: pages.map((page) => ({
          pageIndex: page.pageIndex,
          storageKey: `owner/${clientSubmissionId}/${page.pageIndex}.jpg`,
          uploadUrl: `https://storage.invalid/${page.pageIndex}`,
          token: "secret",
          allowedContentType: "image/jpeg",
          maxBytes: 10 * 1024 * 1024,
        })),
      };
    },
    uploadPage: async (_target, page) => {
      order.push(`upload:${page.pageIndex}`);
    },
    confirmReceipt: async ({ receiptId }) => {
      order.push("confirm");
      return { id: receiptId, status: "submitted", submittedAt: new Date(now).toISOString() };
    },
    recordEvent: async () => undefined,
    now: () => {
      now += 10;
      return new Date(now);
    },
  };
}

describe("active receipt submission", () => {
  it("hashes every page, uploads the full set, and shows Sent only after acknowledgement", async () => {
    const order: string[] = [];
    const updates: string[] = [];
    const confirmation = await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt: null,
      signal: new AbortController().signal,
      dependencies: dependencies(order),
      onUpdate: (update) => updates.push(update.phase),
    });
    expect(order).toEqual(["prepare:0", "prepare:1", "session", "upload:0", "upload:1", "confirm"]);
    expect(confirmation.status).toBe("submitted");
    expect(updates.at(-1)).toBe("sent");
    expect(updates.slice(0, -1)).not.toContain("sent");
  });

  it("completes submission when telemetry never settles", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const recordEvent = vi.fn<ReceiptSubmissionDependencies["recordEvent"]>(
      () => new Promise<void>(() => undefined),
    );
    deps.recordEvent = recordEvent;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      const confirmation = await Promise.race([
        executeReceiptSubmission({
          pages: receiptPages,
          location: null,
          accessToken: "access",
          existingAttempt: null,
          signal: new AbortController().signal,
          dependencies: deps,
          onUpdate: () => undefined,
        }),
        new Promise<never>((_resolve, reject) => {
          timeoutId = setTimeout(() => reject(new Error("submission waited for telemetry")), 250);
        }),
      ]);

      expect(confirmation.status).toBe("submitted");
      expect(order).toEqual([
        "prepare:0",
        "prepare:1",
        "session",
        "upload:0",
        "upload:1",
        "confirm",
      ]);
      expect(recordEvent).toHaveBeenCalledTimes(4);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  });

  it("never confirms a multi-page receipt when one page fails", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    deps.uploadPage = async (_target, page) => {
      order.push(`upload:${page.pageIndex}`);
      if (page.pageIndex === 1) {
        throw new Error("offline");
      }
    };
    await expect(
      executeReceiptSubmission({
        pages: receiptPages,
        location: null,
        accessToken: "access",
        existingAttempt: null,
        signal: new AbortController().signal,
        dependencies: deps,
        onUpdate: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ReceiptSubmissionError);
    expect(order).not.toContain("confirm");
  });

  it("retries a lost confirmation without creating another receipt or re-uploading pages", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const existingAttempt: ReceiptUploadAttempt = {
      clientSubmissionId: "11111111-1111-4111-8111-111111111111",
      receiptId: "11111111-1111-4111-8111-111111111111",
      checksums: ["1".repeat(64), "2".repeat(64)],
      uploadedPageIndexes: [0, 1],
      session: null,
    };
    await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt,
      signal: new AbortController().signal,
      dependencies: deps,
      onUpdate: () => undefined,
    });
    expect(order).toEqual(["prepare:0", "prepare:1", "confirm"]);
  });

  it("renews an expired signed session for the same receipt and only sends remaining pages", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const existingAttempt: ReceiptUploadAttempt = {
      clientSubmissionId: "11111111-1111-4111-8111-111111111111",
      receiptId: "11111111-1111-4111-8111-111111111111",
      checksums: ["1".repeat(64), "2".repeat(64)],
      uploadedPageIndexes: [0],
      session: {
        receiptId: "11111111-1111-4111-8111-111111111111",
        status: "upload_pending",
        expiresAt: "2026-08-21T11:00:00.000Z",
        targets: [],
      },
    };
    await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt,
      signal: new AbortController().signal,
      dependencies: deps,
      onUpdate: () => undefined,
    });
    expect(order).toEqual(["prepare:0", "prepare:1", "session", "upload:1", "confirm"]);
  });

  it("drops a stale attempt after prepared checksums change so the next retry starts fresh", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const createSubmissionId = vi.fn(() => "22222222-2222-4222-8222-222222222222");
    deps.createSubmissionId = createSubmissionId;
    const staleAttempt: ReceiptUploadAttempt = {
      clientSubmissionId: "11111111-1111-4111-8111-111111111111",
      receiptId: "11111111-1111-4111-8111-111111111111",
      checksums: ["9".repeat(64), "8".repeat(64)],
      uploadedPageIndexes: [0],
      session: null,
    };

    const failure = await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt: staleAttempt,
      signal: new AbortController().signal,
      dependencies: deps,
      onUpdate: () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReceiptSubmissionError);
    expect((failure as ReceiptSubmissionError).attempt).toBeNull();
    expect(createSubmissionId).not.toHaveBeenCalled();

    const confirmation = await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt: (failure as ReceiptSubmissionError).attempt,
      signal: new AbortController().signal,
      dependencies: deps,
      onUpdate: () => undefined,
    });

    expect(createSubmissionId).toHaveBeenCalledOnce();
    expect(confirmation.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(order).toEqual([
      "prepare:0",
      "prepare:1",
      "prepare:0",
      "prepare:1",
      "session",
      "upload:0",
      "upload:1",
      "confirm",
    ]);
  });

  it("retains the attempt when cancellation aborts a transfer", async () => {
    const order: string[] = [];
    const deps = dependencies(order);
    const controller = new AbortController();
    deps.uploadPage = async () => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    };
    const failure = await executeReceiptSubmission({
      pages: receiptPages,
      location: null,
      accessToken: "access",
      existingAttempt: null,
      signal: controller.signal,
      dependencies: deps,
      onUpdate: () => undefined,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ReceiptSubmissionError);
    expect((failure as ReceiptSubmissionError).category).toBe("cancelled");
    expect((failure as ReceiptSubmissionError).attempt?.receiptId).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(vi.isMockFunction(deps.confirmReceipt)).toBe(false);
    expect(order).not.toContain("confirm");
  });

  it("logs a sanitized development diagnostic and skips telemetry before an attempt exists", async () => {
    vi.stubGlobal("__DEV__", true);
    const order: string[] = [];
    const deps = dependencies(order);
    const recordEvent = vi.fn<ReceiptSubmissionDependencies["recordEvent"]>();
    deps.recordEvent = recordEvent;
    deps.preparePage = async () => {
      const error = new TypeError(
        "Could not read file:///private/worker/receipt.jpg?token=sensitive-image-token",
      );
      Object.assign(error, { code: "unsafe/path/with/sensitive-image-token" });
      throw error;
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const failure = await executeReceiptSubmission({
        pages: receiptPages,
        location: null,
        accessToken: "access-token-that-must-not-be-logged",
        existingAttempt: null,
        signal: new AbortController().signal,
        dependencies: deps,
        onUpdate: () => undefined,
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ReceiptSubmissionError);
      expect((failure as ReceiptSubmissionError).category).toBe("unknown");
      expect((failure as ReceiptSubmissionError).attempt).toBeNull();
      expect(recordEvent).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith("[receipt-upload] unexpected preflight failure", {
        stage: "preparing_page",
        code: "type_error",
        message: "Receipt preflight received an unsupported value.",
      });
      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain("file://");
      expect(logged).not.toContain("sensitive-image-token");
      expect(logged).not.toContain("access-token-that-must-not-be-logged");
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("does not log an unexpected preflight failure in production", async () => {
    vi.stubGlobal("__DEV__", false);
    const deps = dependencies([]);
    deps.preparePage = async () => {
      throw new Error("file:///private/receipt.jpg");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await executeReceiptSubmission({
        pages: receiptPages,
        location: null,
        accessToken: "access",
        existingAttempt: null,
        signal: new AbortController().signal,
        dependencies: deps,
        onUpdate: () => undefined,
      }).catch(() => undefined);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
