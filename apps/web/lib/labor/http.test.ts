import { describe, expect, it, vi } from "vitest";
import { boundedJson } from "./http";

vi.mock("@/lib/auth/guards", () => ({
  AuthHttpError: class extends Error {},
  authErrorResponse: vi.fn(),
}));

describe("labor request bounds", () => {
  it("cancels chunked input once it exceeds the limit without reading the rest", async () => {
    let delivered = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        delivered++;
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://127.0.0.1:3145/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await expect(boundedJson(request, 15)).rejects.toThrow("too large");
    expect(cancelled).toBe(true);
    expect(delivered).toBeLessThanOrEqual(3);
  });
  it("accepts a small object and rejects arrays", async () => {
    const request = (body: string) =>
      new Request("http://127.0.0.1:3145/test", { method: "POST", body });
    expect(await boundedJson(request('{"action":"pause"}'))).toEqual({ action: "pause" });
    await expect(boundedJson(request("[]"))).rejects.toThrow("must be an object");
  });
});
