import type { ReceiptUploadFailureCategory } from "@svl/domain";
import type { ReceiptLocationMetadata, ReceiptPage } from "@/lib/capture/receipt-pages";
import { UploadTransportError } from "./errors";
import type {
  PreparedUploadPage,
  ReceiptSubmissionAcknowledgement,
  ReceiptSubmissionDependencies,
  ReceiptUploadAttempt,
  ReceiptUploadTarget,
  SubmissionUpdate,
} from "./types";

type ReceiptSubmissionStage =
  | "initializing"
  | "preparing_page"
  | "validating_prepared_pages"
  | "creating_attempt"
  | "creating_session"
  | "uploading_page"
  | "confirming";

type ReceiptSubmissionDiagnostic = {
  stage: ReceiptSubmissionStage;
  code: string;
  message: string;
};

export class ReceiptSubmissionError extends Error {
  readonly category: ReceiptUploadFailureCategory;
  readonly attempt: ReceiptUploadAttempt | null;

  constructor(
    category: ReceiptUploadFailureCategory,
    message: string,
    attempt: ReceiptUploadAttempt | null,
  ) {
    super(message);
    this.name = "ReceiptSubmissionError";
    this.category = category;
    this.attempt = attempt;
  }
}

export async function executeReceiptSubmission(input: {
  pages: ReceiptPage[];
  location: ReceiptLocationMetadata | null;
  accessToken: string;
  existingAttempt: ReceiptUploadAttempt | null;
  signal: AbortSignal;
  dependencies: ReceiptSubmissionDependencies;
  onUpdate: (update: SubmissionUpdate) => void;
}): Promise<ReceiptSubmissionAcknowledgement> {
  const { dependencies, signal } = input;
  let attempt = input.existingAttempt;
  let stage: ReceiptSubmissionStage = "initializing";
  const submissionStartedAt = dependencies.now().getTime();
  try {
    assertNotCancelled(signal);
    input.onUpdate({
      phase: "preparing",
      deviceStatus: "sending",
      attempt,
      currentPageIndex: null,
    });
    const pages: PreparedUploadPage[] = [];
    for (let pageIndex = 0; pageIndex < input.pages.length; pageIndex += 1) {
      stage = "preparing_page";
      assertNotCancelled(signal);
      const page = input.pages[pageIndex];
      if (!page) {
        throw new ReceiptSubmissionError("invalid_response", "A receipt page is missing", attempt);
      }
      pages.push(await dependencies.preparePage(page, pageIndex));
    }

    stage = "validating_prepared_pages";
    const checksums = pages.map((page) => page.checksum);
    if (attempt && !sameChecksums(attempt.checksums, checksums)) {
      throw new ReceiptSubmissionError(
        "invalid_response",
        "Receipt photos changed after the upload started",
        null,
      );
    }
    if (!attempt) {
      stage = "creating_attempt";
      const clientSubmissionId = dependencies.createSubmissionId();
      attempt = {
        clientSubmissionId,
        receiptId: clientSubmissionId,
        checksums,
        uploadedPageIndexes: [],
        session: null,
      };
    }

    const remaining = pages.filter(
      (page) => !attempt?.uploadedPageIndexes.includes(page.pageIndex),
    );
    if (
      remaining.length > 0 &&
      (!attempt.session || sessionNeedsRenewal(attempt.session.expiresAt, dependencies.now()))
    ) {
      stage = "creating_session";
      input.onUpdate({
        phase: "creating_session",
        deviceStatus: "sending",
        attempt,
        currentPageIndex: null,
      });
      const sessionStartedAt = dependencies.now().getTime();
      const session = await dependencies.createSession({
        accessToken: input.accessToken,
        clientSubmissionId: attempt.clientSubmissionId,
        pages,
        location: input.location,
      });
      if (session.receiptId !== attempt.receiptId) {
        throw new ReceiptSubmissionError(
          "invalid_response",
          "Upload session returned the wrong receipt",
          attempt,
        );
      }
      if (session.status === "submitted") {
        const confirmation = {
          id: session.receiptId,
          status: "submitted" as const,
          submittedAt: session.submittedAt,
        };
        input.onUpdate({
          phase: "sent",
          deviceStatus: "sent",
          attempt,
          currentPageIndex: null,
          confirmation,
        });
        return confirmation;
      }
      attempt = { ...attempt, session };
      input.onUpdate({
        phase: "creating_session",
        deviceStatus: "sending",
        attempt,
        currentPageIndex: null,
      });
      recordSafely(dependencies, input.accessToken, {
        event: "session_created",
        receiptId: attempt.receiptId,
        pageCount: pages.length,
        occurredAt: dependencies.now().toISOString(),
        durationMs: Math.max(0, dependencies.now().getTime() - sessionStartedAt),
        result: "success",
      });
    }

    for (const page of pages) {
      if (attempt.uploadedPageIndexes.includes(page.pageIndex)) {
        continue;
      }
      assertNotCancelled(signal);
      const target: ReceiptUploadTarget | undefined = attempt.session?.targets[page.pageIndex];
      if (!target || target.pageIndex !== page.pageIndex) {
        throw new ReceiptSubmissionError("invalid_response", "Upload target is missing", attempt);
      }
      stage = "uploading_page";
      input.onUpdate({
        phase: "uploading",
        deviceStatus: "sending",
        attempt,
        currentPageIndex: page.pageIndex,
      });
      const pageStartedAt = dependencies.now().getTime();
      await dependencies.uploadPage(target, page, signal);
      attempt = {
        ...attempt,
        uploadedPageIndexes: [...attempt.uploadedPageIndexes, page.pageIndex].sort(
          (left, right) => left - right,
        ),
      };
      input.onUpdate({
        phase: "uploading",
        deviceStatus: "sending",
        attempt,
        currentPageIndex: page.pageIndex,
      });
      recordSafely(dependencies, input.accessToken, {
        event: "page_upload_completed",
        receiptId: attempt.receiptId,
        pageCount: pages.length,
        pageIndex: page.pageIndex,
        occurredAt: dependencies.now().toISOString(),
        durationMs: Math.max(0, dependencies.now().getTime() - pageStartedAt),
        result: "success",
      });
    }

    assertNotCancelled(signal);
    stage = "confirming";
    input.onUpdate({
      phase: "confirming",
      deviceStatus: "sending",
      attempt,
      currentPageIndex: null,
    });
    const confirmationStartedAt = dependencies.now().getTime();
    const confirmation = await dependencies.confirmReceipt({
      accessToken: input.accessToken,
      receiptId: attempt.receiptId,
      pages,
    });
    if (confirmation.id !== attempt.receiptId || confirmation.status !== "submitted") {
      throw new ReceiptSubmissionError(
        "invalid_response",
        "The server did not acknowledge this receipt",
        attempt,
      );
    }
    recordSafely(dependencies, input.accessToken, {
      event: "confirmation_completed",
      receiptId: attempt.receiptId,
      pageCount: pages.length,
      occurredAt: dependencies.now().toISOString(),
      durationMs: Math.max(0, dependencies.now().getTime() - confirmationStartedAt),
      result: "success",
    });
    input.onUpdate({
      phase: "sent",
      deviceStatus: "sent",
      attempt,
      currentPageIndex: null,
      confirmation,
    });
    return confirmation;
  } catch (error) {
    if (isUnexpectedError(error) && isPreflightStage(stage)) {
      logDevelopmentPreflightFailure(stage, error);
    }
    const wrapped = signal.aborted
      ? new ReceiptSubmissionError("cancelled", "Upload paused", attempt)
      : toSubmissionError(error, attempt);
    if (
      (wrapped.category === "session_expired" || wrapped.category === "storage_rejected") &&
      wrapped.attempt
    ) {
      attempt = { ...wrapped.attempt, session: null };
    } else {
      attempt = wrapped.attempt;
    }
    if (attempt) {
      recordSafely(dependencies, input.accessToken, {
        event: "submission_failed",
        receiptId: attempt.receiptId,
        pageCount: input.pages.length,
        occurredAt: dependencies.now().toISOString(),
        durationMs: Math.max(0, dependencies.now().getTime() - submissionStartedAt),
        result: wrapped.category === "cancelled" ? "cancelled" : "failure",
        failureCategory: wrapped.category,
      });
    }
    throw new ReceiptSubmissionError(wrapped.category, wrapped.message, attempt);
  }
}

function isUnexpectedError(error: unknown): boolean {
  return !(error instanceof ReceiptSubmissionError) && !(error instanceof UploadTransportError);
}

function isPreflightStage(stage: ReceiptSubmissionStage): boolean {
  return (
    stage === "initializing" ||
    stage === "preparing_page" ||
    stage === "validating_prepared_pages" ||
    stage === "creating_attempt"
  );
}

function logDevelopmentPreflightFailure(stage: ReceiptSubmissionStage, error: unknown): void {
  if (typeof __DEV__ === "undefined" || !__DEV__) {
    return;
  }
  console.warn("[receipt-upload] unexpected preflight failure", preflightDiagnostic(stage, error));
}

function preflightDiagnostic(
  stage: ReceiptSubmissionStage,
  error: unknown,
): ReceiptSubmissionDiagnostic {
  const code = sanitizedErrorCode(error);
  return { stage, code, message: diagnosticMessage(code) };
}

function sanitizedErrorCode(error: unknown): string {
  if (error instanceof Error && error.message === "prepared_page_changed") {
    return "prepared_page_changed";
  }
  if (error && typeof error === "object") {
    const rawCode = (error as { code?: unknown }).code;
    if (typeof rawCode === "string" && /^(?:ERR|E)_[A-Z0-9_]{1,48}$/i.test(rawCode)) {
      return rawCode.toLowerCase();
    }
  }
  if (error instanceof TypeError) {
    return "type_error";
  }
  if (error instanceof RangeError) {
    return "range_error";
  }
  return "unexpected_error";
}

function diagnosticMessage(code: string): string {
  if (code === "prepared_page_changed") {
    return "Prepared receipt bytes changed before upload.";
  }
  if (code.includes("crypto") || code.includes("digest")) {
    return "Receipt checksum preparation failed.";
  }
  if (code.includes("file")) {
    return "Receipt file preparation failed.";
  }
  if (code === "type_error") {
    return "Receipt preflight received an unsupported value.";
  }
  if (code === "range_error") {
    return "Receipt preflight received an invalid byte range.";
  }
  return "Unexpected receipt upload preflight failure.";
}

function assertNotCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new ReceiptSubmissionError("cancelled", "Upload paused", null);
  }
}

function sameChecksums(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sessionNeedsRenewal(expiresAt: string, now: Date): boolean {
  return Date.parse(expiresAt) <= now.getTime() + 30_000;
}

function toSubmissionError(
  error: unknown,
  attempt: ReceiptUploadAttempt | null,
): ReceiptSubmissionError {
  if (error instanceof ReceiptSubmissionError) {
    return new ReceiptSubmissionError(error.category, error.message, error.attempt);
  }
  if (error instanceof UploadTransportError) {
    return new ReceiptSubmissionError(error.category, error.message, attempt);
  }
  return new ReceiptSubmissionError("unknown", "Receipt upload needs another try", attempt);
}

function recordSafely(
  dependencies: ReceiptSubmissionDependencies,
  accessToken: string,
  event: Parameters<ReceiptSubmissionDependencies["recordEvent"]>[1],
): void {
  try {
    void dependencies.recordEvent(accessToken, event).catch(() => undefined);
  } catch {
    // Telemetry cannot affect submission truth or success, including a
    // dependency that throws before returning its promise.
  }
}
