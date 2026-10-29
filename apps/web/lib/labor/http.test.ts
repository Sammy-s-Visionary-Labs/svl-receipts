import { describe, expect, it, vi } from "vitest";
import { boundedJson, laborResponse, laborStreamResponse } from "./http";

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

describe("large private responses", () => {
  it("streams a JSON snapshot above the hosting limit in bounded chunks without data loss", async () => {
    const body = { entries: [{ note: "TEST ".repeat(1_000_000) }], hours: 123.45 };
    const response = laborResponse(body);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("content-length")).toBe(false);
    expect(response.headers.has("transfer-encoding")).toBe(false);
    expect(response.headers.has("content-encoding")).toBe(false);
    if (!response.body) throw new Error("Missing response stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let decoded = "";
    let chunks = 0;
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      expect(value.byteLength).toBeLessThanOrEqual(64 * 1024);
      total += value.byteLength;
      decoded += decoder.decode(value, { stream: true });
      chunks++;
    }
    decoded += decoder.decode();
    expect(total).toBeGreaterThan(4.5 * 1024 * 1024);
    expect(chunks).toBeGreaterThan(1);
    expect(JSON.parse(decoded)).toEqual(body);
  });

  it("preserves multibyte characters across stream boundaries and ordinary response.json consumers", async () => {
    const text = `${"x".repeat(16 * 1024 - 1)}🛠️é${"木".repeat(30_000)}`;
    const response = laborStreamResponse(text, { "Content-Type": "text/csv; charset=utf-8" });
    expect(await response.text()).toBe(text);
    expect(await laborResponse({ text }, 201, { stream: true }).json()).toEqual({ text });
  });

  it("keeps status and serialization semantics, and supports cancellation", async () => {
    const response = laborResponse({ createdAt: new Date("2026-10-29T00:00:00Z") }, 201);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ createdAt: "2026-10-29T00:00:00.000Z" });
    expect(() => laborResponse({ unsupported: BigInt(1) }, 200, { stream: true })).toThrow(
      TypeError,
    );
    expect(() => laborResponse(undefined, 200, { stream: true })).toThrow(TypeError);
    const stream = laborResponse({ text: "TEST".repeat(50_000) }).body;
    if (!stream) throw new Error("Missing response stream");
    const reader = stream.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    expect((await reader.read()).done).toBe(true);
  });
});
