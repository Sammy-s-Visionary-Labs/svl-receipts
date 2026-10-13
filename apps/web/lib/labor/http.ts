import { AuthHttpError, authErrorResponse } from "@/lib/auth/guards";

export function laborResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function laborError(error: unknown) {
  if (error instanceof AuthHttpError) return authErrorResponse(error);
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
