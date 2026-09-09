/** Narrow projection of the official Housecall API; no customer billing operations. */
export type HousecallAttachment = {
  id: string;
  fileName: string;
  fileType: string | null;
  url: string | null;
};
export type HousecallMaterial = {
  /** Existing provider rows may omit fields; unknowns never become invented zero values. */
  id: string | null;
  name: string;
  description: string;
  partNumber: string;
  quantity: number | null;
  unitCostCents: number | null;
};
export type HousecallJob = {
  id: string;
  invoiceNumber: string | null;
  description: string;
  customerId: string | null;
  customerName: string;
  customerNotificationsEnabled: boolean | null;
  address: string | null;
  workStatus: string;
  active: boolean;
  canceled: boolean;
  deleted: boolean;
  locked: boolean;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  assignedEmployeeIds: string[];
  updatedAt: string | null;
  attachments: HousecallAttachment[] | null;
};
export type HousecallJobsQuery = {
  page?: number;
  pageSize?: number;
  scheduledStartMin?: string;
  scheduledStartMax?: string;
  customerId?: string;
  workStatus?: Array<"unscheduled" | "scheduled" | "in_progress" | "completed" | "canceled">;
  sortBy?: "created_at" | "updated_at" | "invoice_number" | "id" | "description" | "work_status";
  sortDirection?: "asc" | "desc";
};
export type HousecallJobsPage = {
  jobs: HousecallJob[];
  page: number;
  pageSize: number;
  totalPages: number;
  totalItems: number;
};
export type HousecallMaterialBody = {
  job_input_materials: Array<{
    name: string;
    description: string;
    part_number: string;
    quantity: number;
    unit_cost: number;
  }>;
};
export type PreparedMaterialWrite = {
  kind: "job_cost";
  jobId: string;
  method: "PUT";
  path: string;
  reference: string;
  body: HousecallMaterialBody;
  requestHash: string;
};
export type PreparedAttachmentWrite = {
  kind: "attachment";
  jobId: string;
  method: "POST";
  path: string;
  reference: string;
  fileName: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
  contentSha256: string;
  requestHash: string;
};
export type PreparedHousecallWrite = PreparedMaterialWrite | PreparedAttachmentWrite;
/** This is trusted server input created from a separately recorded human approval, never receipt/OCR/browser input. */
export type HousecallWritePermit = {
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  jobId: string;
  requestHash: string;
};
export type HousecallReconciliation =
  | { status: "found"; providerId: string }
  | { status: "absent" }
  | { status: "conflict"; reason: "duplicate_reference" | "payload_mismatch" };
export type HousecallWriteResult = { status: "accepted"; httpStatus: number };
