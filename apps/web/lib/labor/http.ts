import { AuthHttpError, authErrorResponse } from "@/lib/auth/guards";
import { LaborApprovalPersistenceError } from "./approval-persistence";

export function laborResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function laborError(error: unknown) {
  if (error instanceof AuthHttpError) return authErrorResponse(error);
  if (error instanceof LaborApprovalPersistenceError) {
    const messages: Record<string, string> = {
      labor_approval_stale: "Hours changed during review. Refresh and approve the current version.",
      labor_approval_duplicate_interval:
        "These clock intervals overlap an existing approval or submission. Review the history; never submit the same time twice.",
      labor_approval_dispatch_uncertain:
        "A previous send needs Housecall verification. It cannot be sent again.",
      labor_approval_invalid_status:
        "This approval cannot perform that action. Refresh its history.",
      labor_approval_invalid_lease: "The send reservation expired. Refresh the approval history.",
      labor_approval_not_found: "Approval not found.",
      forbidden: "An active manager account is required.",
      unauthenticated: "Sign in with an active manager account.",
    };
    const status =
      error.code === "forbidden"
        ? 403
        : error.code === "unauthenticated"
          ? 401
          : error.code === "labor_approval_not_found"
            ? 404
            : [
                  "labor_approval_stale",
                  "labor_approval_duplicate_interval",
                  "labor_approval_dispatch_uncertain",
                  "labor_approval_invalid_status",
                  "labor_approval_invalid_lease",
                ].includes(error.code)
              ? 409
              : 503;
    return laborResponse(
      {
        error: {
          code: error.code,
          message:
            messages[error.code] ??
            "Approval storage could not confirm the action. Refresh before retrying.",
        },
      },
      status,
    );
  }
  const message = error instanceof Error ? error.message : "Labor request failed";
  return laborResponse(
    { error: { code: "invalid_request", message } },
    /already pending|busy|Stale/.test(message) ? 409 : 400,
  );
}

export async function boundedJson(request: Request, max = 8192): Promise<Record<string, unknown>> {
  const length = request.headers.get("content-length");
  if (length && Number(length) > max) throw new Error("Request is too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Request body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new Error("Request is too large");
    }
    chunks.push(value);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Request must be an object");
  return value as Record<string, unknown>;
}
