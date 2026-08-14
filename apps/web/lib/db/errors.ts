import { HttpError } from "@/lib/http";

export function rpcHttpError(error: { message?: string } | null | undefined): HttpError {
  const message = error?.message ?? "";
  if (message.includes("unauthenticated")) {
    return new HttpError(401, "unauthenticated", "Sign in required");
  }
  if (message.includes("forbidden")) {
    return new HttpError(403, "forbidden", "Receipt access denied");
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
