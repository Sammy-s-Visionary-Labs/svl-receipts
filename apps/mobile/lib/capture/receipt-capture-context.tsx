import { randomUUID } from "expo-crypto";
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
  cancelRetake: () => void;
  savePage: (page: ReceiptPage) => void;
  replacePage: (index: number, page: ReceiptPage) => void;
  confirmPages: () => void;
  setLocation: (location: ReceiptLocationMetadata) => void;
  skipLocation: () => void;
  submission: ReceiptSubmissionState;
  submitReceipt: (accessToken: string) => Promise<void>;
  cancelSubmission: () => void;
};

const ReceiptCaptureContext = createContext<ReceiptCaptureContextValue | null>(null);

export function ReceiptCaptureProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(
    receiptCaptureReducer,
    undefined,
    createInitialReceiptCaptureState,
  );
  const [submission, setSubmission] = useState(createInitialReceiptSubmissionState);
  const abortRef = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const attemptRef = useRef<ReceiptUploadAttempt | null>(null);
  const submissionGenerationRef = useRef(0);

  const resetSubmission = useCallback(() => {
    submissionGenerationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    busyRef.current = false;
    attemptRef.current = null;
    setSubmission(createInitialReceiptSubmissionState());
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const submitReceipt = useCallback(
    async (accessToken: string) => {
      if (
        busyRef.current ||
        state.pages.length === 0 ||
        !state.confirmed ||
        state.locationDecision === "undecided" ||
        submission.phase === "sent"
      ) {
        return;
      }

      busyRef.current = true;
      const controller = new AbortController();
      const submissionGeneration = submissionGenerationRef.current;
      abortRef.current = controller;
      const dependencies: ReceiptSubmissionDependencies = {
        createSubmissionId: randomUUID,
        preparePage: prepareReceiptPageForUpload,
        createSession: postReceiptUploadSession,
        uploadPage: putReceiptPage,
        confirmReceipt: postReceiptConfirmation,
        recordEvent: postReceiptUploadEvent,
        now: () => new Date(),
      };

      try {
        await executeReceiptSubmission({
          pages: state.pages,
          location: state.locationDecision === "included" ? state.location : null,
          accessToken,
          existingAttempt: attemptRef.current,
          signal: controller.signal,
          dependencies,
          onUpdate(update) {
            if (submissionGenerationRef.current !== submissionGeneration) {
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
      } catch (error) {
        if (submissionGenerationRef.current !== submissionGeneration) {
          return;
        }
        const failure =
          error instanceof ReceiptSubmissionError
            ? error
            : new ReceiptSubmissionError(
                "unknown",
                "Receipt upload needs another try",
                attemptRef.current,
              );
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
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (submissionGenerationRef.current === submissionGeneration) {
          busyRef.current = false;
        }
      }
    },
    [state, submission.phase],
  );

  const cancelSubmission = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const value = useMemo<ReceiptCaptureContextValue>(
    () => ({
      state,
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
