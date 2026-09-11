import { HttpError } from "@/lib/http";

export function rpcHttpError(error: { message?: string } | null | undefined): HttpError {
  const message = error?.message ?? "";
  if (message === "test_export_reviewer")
    return new HttpError(
      409,
      "test_export_reviewer",
      "Your manager account is not authorized to approve exports in this test session. Approval was not saved; save your draft and contact the administrator.",
    );
  if (message === "test_export_scope")
    return new HttpError(
      409,
      "test_export_scope",
      "This receipt is outside the active test session, or the session has expired. Approval was not saved; keep your draft and contact the administrator.",
    );
  if (message === "test_export_budget")
    return new HttpError(
      409,
      "test_export_budget",
      "This approval would exceed the test session's receipt, cost, or write limit. Approval was not saved.",
    );
  if (message === "unsupported_quantity_precision")
    return new HttpError(
      400,
      "unsupported_quantity_precision",
      "Review quantities with more than two decimal places. Housecall export cannot preserve them; no approval was saved.",
    );
  if (message.includes("unauthenticated")) {
    return new HttpError(401, "unauthenticated", "Sign in required");
  }
  if (message.includes("forbidden")) {
    return new HttpError(403, "forbidden", "Receipt access denied");
  }
  if (message === "invalid_request_job_unavailable") {
    return new HttpError(
      400,
      "invalid_request",
      "The selected Housecall job is unavailable. Refresh jobs and choose another destination.",
    );
  }
  if (message.includes("invalid_request")) {
    return new HttpError(400, "invalid_request", "Invalid request");
  }
  if (
    message.includes("conflict") ||
    message.includes("approved receipt") ||
    message.includes("unapproved") ||
    message.includes("export work")
  ) {
    return new HttpError(409, "conflict", "Request could not be applied");
  }
  return new HttpError(500, "internal", "Request failed");
}
