import { AuthHttpError, authErrorResponse } from "@/lib/auth/guards";
import { LaborApprovalPersistenceError } from "./approval-persistence";

const STREAM_CHARS = 16 * 1024;
const BUFFERED_JSON_CHARS = 64 * 1024;

/** Pull one bounded UTF-8 chunk at a time; leave transport framing to Next/Vercel. */
export function laborStreamResponse(text: string, headers: HeadersInit, status = 200) {
  let offset = 0;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (offset >= text.length) {
          text = "";
          controller.close();
          return;
        }
        let end = Math.min(offset + STREAM_CHARS, text.length);
        // Keep an astral character's surrogate pair together when encoding chunks.
        const previous = text.charCodeAt(end - 1);
        const next = text.charCodeAt(end);
        if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
        controller.enqueue(encoder.encode(text.slice(offset, end)));
        offset = end;
      },
      cancel() {
        text = "";
      },
    },
    { highWaterMark: 0 },
  );
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  return new Response(stream, { status, headers: responseHeaders });
}

export function laborResponse(body: unknown, status = 200, options: { stream?: boolean } = {}) {
  // Serialize before starting the response so invalid values still reach the route's
  // error handler. Large snapshots stream past Vercel's buffered response-size limit.
  const json = JSON.stringify(body);
  if (json === undefined) throw new TypeError("Value is not JSON serializable");
  const headers = { "Content-Type": "application/json", "Cache-Control": "private, no-store" };
  return options.stream || json.length > BUFFERED_JSON_CHARS
    ? laborStreamResponse(json, headers, status)
    : new Response(json, { status, headers });
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
