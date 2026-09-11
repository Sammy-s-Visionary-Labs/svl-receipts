import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AppState } from "react-native";
import { useAuth } from "@/lib/auth/auth-context";
import type { PendingReceiptQueueItem } from "@/lib/queue/pending";
import { getPendingReceiptQueue } from "@/lib/queue/pending-native";
import {
  postReceiptConfirmation,
  postReceiptUploadEvent,
  postReceiptUploadSession,
  putReceiptPage,
} from "@/lib/upload/api";
import { prepareReceiptPageForUpload } from "@/lib/upload/checksum";
import { executeReceiptSubmission, ReceiptSubmissionError } from "@/lib/upload/submission";
import {
  createInitialReceiptSubmissionState,
  type ReceiptSubmissionDependencies,
  type ReceiptSubmissionState,
  type ReceiptUploadAttempt,
} from "@/lib/upload/types";
import {
  createInitialReceiptCaptureState,
  type ReceiptCaptureState,
  type ReceiptLocationMetadata,
  type ReceiptPage,
  receiptCaptureReducer,
} from "./receipt-pages";

type ReceiptCaptureContextValue = {
  state: ReceiptCaptureState;
  startNewReceipt: () => void;
  addPages: (pages: ReceiptPage[]) => void;
  beginRetake: (index: number) => void;
  beginRequiredRetakes: (indexes: number[]) => void;
  cancelRetake: () => void;
  savePage: (page: ReceiptPage) => void;
  replacePage: (index: number, page: ReceiptPage) => void;
  removePage: (index: number) => void;
  canEditPages: boolean;
  confirmPages: () => void;
  setLocation: (location: ReceiptLocationMetadata) => void;
  skipLocation: () => void;
  submission: ReceiptSubmissionState;
  submitReceipt: (accessToken: string) => Promise<void>;
  cancelSubmission: () => void;
};

const ReceiptCaptureContext = createContext<ReceiptCaptureContextValue | null>(null);

export function ReceiptCaptureProvider({ children }: { children: ReactNode }) {
  const { session, userId } = useAuth();
  const [state, dispatch] = useReducer(
    receiptCaptureReducer,
    undefined,
    createInitialReceiptCaptureState,
  );
  const [submission, setSubmission] = useState(createInitialReceiptSubmissionState);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const attemptRef = useRef<ReceiptUploadAttempt | null>(null);
  const queueItemIdRef = useRef<string | null>(null);
  const processingQueueIdsRef = useRef(new Set<string>());
  const queueControllersRef = useRef(new Map<string, AbortController>());
  const submissionGenerationRef = useRef(0);

  const resetSubmission = useCallback(() => {
    submissionGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    attemptRef.current = null;
    queueItemIdRef.current = null;
    setSubmission(createInitialReceiptSubmissionState());
  }, []);

  useEffect(
    () => () => {
      for (const controller of queueControllersRef.current.values()) {
        controller.abort();
      }
      queueControllersRef.current.clear();
    },
    [],
  );

  const runQueuedReceipt = useCallback(
    async (queued: PendingReceiptQueueItem, accessToken: string, showOnCurrentScreen: boolean) => {
      if (processingQueueIdsRef.current.has(queued.id)) {
        return;
      }
      processingQueueIdsRef.current.add(queued.id);
      const queue = getPendingReceiptQueue();
      const controller = new AbortController();
      queueControllersRef.current.set(queued.id, controller);
      const submissionGeneration = submissionGenerationRef.current;
      let latestAttempt = queued.attempt;
      const showsCurrent = () => showOnCurrentScreen || queueItemIdRef.current === queued.id;
      if (showsCurrent()) {
        busyRef.current = true;
        abortRef.current = controller;
      }
      const dependencies: ReceiptSubmissionDependencies = {
        createSubmissionId: () => queued.id,
        preparePage: prepareReceiptPageForUpload,
        createSession: postReceiptUploadSession,
        uploadPage: putReceiptPage,
        confirmReceipt: postReceiptConfirmation,
        recordEvent: postReceiptUploadEvent,
        now: () => new Date(),
      };

      try {
        await queue.markSending(queued.id);
        const uploadPages = await queue.prepareUploadPages(queued.id);
        const confirmation = await executeReceiptSubmission({
          pages: uploadPages,
          location: queued.location,
          accessToken,
          existingAttempt: queued.attempt,
          signal: controller.signal,
          dependencies,
          async onUpdate(update) {
            latestAttempt = update.attempt;
            await queue.saveAttempt(queued.id, update.attempt);
            if (!showsCurrent() || submissionGenerationRef.current !== submissionGeneration) {
              return;
            }
            attemptRef.current = update.attempt;
            setSubmission({
              phase: update.phase,
              deviceStatus: update.deviceStatus,
              attempt: update.attempt,
              currentPageIndex: update.currentPageIndex,
              failureCategory: null,
              errorMessage: null,
              confirmation: update.confirmation ?? null,
            });
          },
        });
        await queue.markConfirmed(queued.id, confirmation);
      } catch (error) {
        const failure =
          error instanceof ReceiptSubmissionError
            ? error
            : new ReceiptSubmissionError(
                "unknown",
                "Receipt upload needs another try",
                latestAttempt,
              );
        await queue
          .markFailed({
            id: queued.id,
            category: failure.category,
            attempt: failure.attempt,
          })
          .catch(() => undefined);
        if (showsCurrent() && submissionGenerationRef.current === submissionGeneration) {
          attemptRef.current = failure.attempt;
          const cancelled = failure.category === "cancelled";
          setSubmission({
            phase: cancelled ? "cancelled" : "failed",
            deviceStatus: cancelled ? "pending" : "failed",
            attempt: failure.attempt,
            currentPageIndex: null,
            failureCategory: failure.category,
            errorMessage: submissionMessage(failure.category),
            confirmation: null,
          });
        }
      } finally {
        await queue.removeUploadPages(queued.id).catch(() => undefined);
        queueControllersRef.current.delete(queued.id);
        processingQueueIdsRef.current.delete(queued.id);
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (showsCurrent() && submissionGenerationRef.current === submissionGeneration) {
          busyRef.current = false;
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (!session?.access_token || !userId) {
      return;
    }
    let active = true;
    const runDue = async () => {
      const queue = getPendingReceiptQueue();
      await queue.recoverInterrupted(userId, processingQueueIdsRef.current);
      const items = await queue.due(userId);
      for (const item of items) {
        if (!active) {
          return;
        }
        await runQueuedReceipt(item, session.access_token, false);
      }
    };
    const safelyRunDue = () => void runDue().catch(() => undefined);
    safelyRunDue();
    const timer = setInterval(safelyRunDue, 30_000);
    const appState = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        safelyRunDue();
      }
    });
    return () => {
      active = false;
      clearInterval(timer);
      appState.remove();
      for (const controller of queueControllersRef.current.values()) {
        controller.abort();
      }
    };
  }, [runQueuedReceipt, session?.access_token, userId]);

  const submitReceipt = useCallback(
    async (accessToken: string) => {
      if (
        busyRef.current ||
        !userId ||
        state.pages.length === 0 ||
        !state.confirmed ||
        state.locationDecision === "undecided" ||
        submission.phase === "sent"
      ) {
        return;
      }

      const queue = getPendingReceiptQueue();
      try {
        let queued = queueItemIdRef.current ? await queue.get(queueItemIdRef.current) : null;
        if (!queued) {
          setSubmission((current) => ({
            ...current,
            phase: "preparing",
            deviceStatus: "pending",
            errorMessage: null,
          }));
          queued = await queue.enqueue({
            ownerUserId: userId,
            pages: state.pages,
            location: state.locationDecision === "included" ? state.location : null,
          });
          queueItemIdRef.current = queued.id;
        } else if (queued.status === "failed") {
          queued = await queue.requestManualRetry(queued.id);
        }
        attemptRef.current = queued.attempt;
        await runQueuedReceipt(queued, accessToken, true);
      } catch {
        setSubmission((current) => ({
          ...current,
          phase: "failed",
          deviceStatus: "failed",
          failureCategory: "unknown",
          errorMessage:
            "This receipt could not be saved to the protected offline queue. Try again.",
        }));
      }
    },
    [runQueuedReceipt, state, submission.phase, userId],
  );

  const cancelSubmission = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const value = useMemo<ReceiptCaptureContextValue>(
    () => ({
      state,
      canEditPages: submission.phase === "idle" && !queueItemIdRef.current && !busyRef.current,
      removePage: (index) => {
        if (submission.phase !== "idle" || queueItemIdRef.current || busyRef.current) return;
        resetSubmission();
        dispatch({ type: "remove-page", index });
      },
      startNewReceipt: () => {
        resetSubmission();
        dispatch({ type: "start-new" });
      },
      addPages: (pages) => {
        resetSubmission();
        dispatch({ type: "add-pages", pages });
      },
      beginRetake: (index) => {
        resetSubmission();
        dispatch({ type: "begin-retake", index });
      },
      beginRequiredRetakes: (indexes) => {
        resetSubmission();
        dispatch({ type: "begin-required-retakes", indexes });
      },
      cancelRetake: () => dispatch({ type: "cancel-retake" }),
      savePage: (page) => {
        resetSubmission();
        dispatch({ type: "save-page", page });
      },
      replacePage: (index, page) => {
        resetSubmission();
        dispatch({ type: "replace-page", index, page });
      },
      confirmPages: () => dispatch({ type: "confirm" }),
      setLocation: (location) => {
        resetSubmission();
        dispatch({ type: "set-location", location });
      },
      skipLocation: () => {
        resetSubmission();
        dispatch({ type: "skip-location" });
      },
      submission,
      submitReceipt,
      cancelSubmission,
    }),
    [cancelSubmission, resetSubmission, state, submission, submitReceipt],
  );

  return <ReceiptCaptureContext.Provider value={value}>{children}</ReceiptCaptureContext.Provider>;
}

function submissionMessage(category: ReceiptSubmissionError["category"]): string {
  switch (category) {
    case "cancelled":
      return "Upload paused. Your receipt photos are still here.";
    case "network":
      return "The connection was interrupted. Try sending this receipt again.";
    case "session_expired":
      return "The signed upload session expired. Retry to renew it safely.";
    case "unauthorized":
      return "Your sign-in is no longer authorized. Sign in again before retrying.";
    case "storage_rejected":
      return "One page was not accepted by storage. Your photos are still available to retry.";
    case "confirmation_rejected":
      return "The server could not verify the full page set. No Sent status was recorded.";
    case "invalid_response":
      return "The server response was incomplete. No Sent status was recorded.";
    case "unknown":
      return "Receipt upload needs another try. Your photos are still here.";
  }
}

export function useReceiptCapture(): ReceiptCaptureContextValue {
  const value = useContext(ReceiptCaptureContext);
  if (!value) {
    throw new Error("useReceiptCapture must be used inside ReceiptCaptureProvider");
  }
  return value;
}
