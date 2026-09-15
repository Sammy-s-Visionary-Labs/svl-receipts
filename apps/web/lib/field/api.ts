export class FieldApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export async function fieldApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...init.headers },
      signal: init.signal ?? AbortSignal.timeout(60_000),
    });
  } catch {
    throw new FieldApiError(
      "Could not connect. Check your connection and try again.",
      0,
      "network",
    );
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body?.error?.code ?? "unknown";
    const message =
      code === "account_inactive"
        ? "Your account is inactive. Contact your manager."
        : response.status === 401
          ? "Your session ended. Sign in again to continue."
          : response.status === 403
            ? "You do not have access to this receipt."
            : (body?.error?.message ?? "Request could not be completed. Try again.");
    throw new FieldApiError(message, response.status, code);
  }
  if (!body)
    throw new FieldApiError(
      "The service returned an incomplete response. Try again.",
      502,
      "invalid_response",
    );
  return body as T;
}
