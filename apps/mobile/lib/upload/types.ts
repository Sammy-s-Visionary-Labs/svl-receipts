import type {
  DeviceQueueStatus,
  ReceiptUploadFailureCategory,
  ReceiptUploadTelemetryEvent,
} from "@svl/domain";
import type { ReceiptLocationMetadata, ReceiptPage } from "@/lib/capture/receipt-pages";

export type PreparedUploadPage = {
  pageIndex: number;
  bytes: Uint8Array;
  checksum: string;
  byteSize: number;
  contentType: "image/jpeg";
  originalFilename: string | null;
};

export type ReceiptUploadTarget = {
  pageIndex: number;
  storageKey: string;
  uploadUrl: string;
  token: string;
  allowedContentType: "image/jpeg";
  maxBytes: number;
};

export type PendingReceiptUploadSession = {
  receiptId: string;
  status: "upload_pending";
  expiresAt: string;
  targets: ReceiptUploadTarget[];
};

export type SubmittedReceiptUploadSession = {
  receiptId: string;
  status: "submitted";
  submittedAt: string;
  targets: [];
};

export type ReceiptUploadSession = PendingReceiptUploadSession | SubmittedReceiptUploadSession;

export type ReceiptUploadAttempt = {
  clientSubmissionId: string;
  receiptId: string;
  checksums: string[];
  uploadedPageIndexes: number[];
  session: PendingReceiptUploadSession | null;
};

export type ReceiptSubmissionAcknowledgement = {
  id: string;
  status: "submitted";
  submittedAt: string;
};

export type ReceiptSubmissionPhase =
  | "idle"
  | "preparing"
  | "creating_session"
  | "uploading"
  | "confirming"
  | "cancelled"
  | "failed"
  | "sent";

export type ReceiptSubmissionState = {
  phase: ReceiptSubmissionPhase;
  deviceStatus: DeviceQueueStatus;
  attempt: ReceiptUploadAttempt | null;
  currentPageIndex: number | null;
  failureCategory: ReceiptUploadFailureCategory | null;
  errorMessage: string | null;
  confirmation: ReceiptSubmissionAcknowledgement | null;
};

export function createInitialReceiptSubmissionState(): ReceiptSubmissionState {
  return {
    phase: "idle",
    deviceStatus: "pending",
    attempt: null,
    currentPageIndex: null,
    failureCategory: null,
    errorMessage: null,
    confirmation: null,
  };
}

export type SubmissionUpdate = {
  phase: Exclude<ReceiptSubmissionPhase, "idle" | "failed" | "cancelled">;
  deviceStatus: DeviceQueueStatus;
  attempt: ReceiptUploadAttempt | null;
  currentPageIndex: number | null;
  confirmation?: ReceiptSubmissionAcknowledgement;
};

export type ReceiptSubmissionDependencies = {
  createSubmissionId: () => string;
  preparePage: (page: ReceiptPage, pageIndex: number) => Promise<PreparedUploadPage>;
  createSession: (input: {
    accessToken: string;
    clientSubmissionId: string;
    pages: PreparedUploadPage[];
    location: ReceiptLocationMetadata | null;
  }) => Promise<ReceiptUploadSession>;
  uploadPage: (
    target: ReceiptUploadTarget,
    page: PreparedUploadPage,
    signal: AbortSignal,
  ) => Promise<void>;
  confirmReceipt: (input: {
    accessToken: string;
    receiptId: string;
    pages: PreparedUploadPage[];
  }) => Promise<ReceiptSubmissionAcknowledgement>;
  recordEvent: (accessToken: string, event: ReceiptUploadTelemetryEvent) => Promise<void>;
  now: () => Date;
};
