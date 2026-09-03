import { describe, expect, it, vi } from "vitest";
import {
  createGeminiReadabilityAdapter,
  GEMINI_READABILITY_MODEL,
  type GeminiReadabilityError,
} from "./gemini-readability";

const page = {
  pageIndex: 0,
  mimeType: "image/jpeg" as const,
  bytes: new TextEncoder().encode("abc"),
};

describe("Gemini readability adapter", () => {
  it("requests high-resolution minimal-thinking structured output without OCR", async () => {
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const prompt = body.contents[0].parts[0].text as string;
      expect(prompt).toContain("Do not transcribe, extract, or return any receipt text");
      expect(body.contents[0].parts[1]).toMatchObject({
        inlineData: { mimeType: "image/jpeg", data: "YWJj" },
        mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
      });
      expect(body.generationConfig).toMatchObject({
        responseMimeType: "application/json",
        thinkingConfig: { thinkingLevel: "MINIMAL" },
      });
      return Response.json({
        modelVersion: GEMINI_READABILITY_MODEL,
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    schema_version: 1,
                    readable: true,
                    failed_page_indexes: [],
                    reasons: [],
                  }),
                },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 1120,
          candidatesTokenCount: 20,
          totalTokenCount: 1140,
        },
      });
    });
    const result = await createGeminiReadabilityAdapter({
      apiKey: "test-key",
      fetch: request,
    }).checkReadable([page]);

    expect(result.check).toEqual({ schema_version: 1, readable: true });
    expect(result.usage).toMatchObject({ inputTokens: 1120, outputTokens: 20 });
    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("gemini-3.5-flash-lite:generateContent"),
      expect.objectContaining({
        headers: expect.objectContaining({ "x-goog-api-key": "test-key" }),
      }),
    );
  });

  it("normalizes unreadable reasons and page indexes", async () => {
    const result = await createGeminiReadabilityAdapter({
      apiKey: "test-key",
      fetch: async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      schema_version: 1,
                      readable: false,
                      failed_page_indexes: [1, 0, 1],
                      reasons: ["cropped", "blurry", "cropped"],
                    }),
                  },
                ],
              },
            },
          ],
        }),
    }).checkReadable([page, { ...page, pageIndex: 1 }]);

    expect(result.check).toEqual({
      schema_version: 1,
      readable: false,
      failed_page_indexes: [0, 1],
      reasons: ["cropped", "blurry"],
    });
  });

  it("uses the Files API and deletes uploads when inline content would exceed the safe limit", async () => {
    const request = vi.fn(async (rawUrl: string | URL | Request, init?: RequestInit) => {
      const url = String(rawUrl);
      if (url.endsWith("/upload/v1beta/files")) {
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({
            "x-goog-upload-protocol": "resumable",
            "x-goog-upload-header-content-type": "image/jpeg",
          }),
        });
        return new Response(null, {
          headers: { "x-goog-upload-url": "https://upload.example.test/file-1" },
        });
      }
      if (url === "https://upload.example.test/file-1") {
        expect(init).toMatchObject({
          method: "POST",
          headers: expect.objectContaining({ "x-goog-upload-command": "upload, finalize" }),
        });
        return Response.json({
          file: {
            name: "files/file-1",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
            mimeType: "image/jpeg",
          },
        });
      }
      if (url.includes(":generateContent")) {
        const body = JSON.parse(String(init?.body));
        expect(body.contents[0].parts[1]).toMatchObject({
          fileData: {
            mimeType: "image/jpeg",
            fileUri: "https://generativelanguage.googleapis.com/v1beta/files/file-1",
          },
        });
        expect(JSON.stringify(body)).not.toContain("YWJj");
        return Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      schema_version: 1,
                      readable: true,
                      failed_page_indexes: [],
                      reasons: [],
                    }),
                  },
                ],
              },
            },
          ],
        });
      }
      if (url.endsWith("/v1beta/files/file-1")) {
        expect(init?.method).toBe("DELETE");
        return Response.json({});
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const result = await createGeminiReadabilityAdapter({
      apiKey: "test-key",
      inlineByteLimit: 1,
      fetch: request,
    }).checkReadable([page]);

    expect(result.check).toEqual({ schema_version: 1, readable: true });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("treats provider outages as retryable and auth failures as permanent", async () => {
    for (const [status, kind, code] of [
      [429, "retryable", "provider_rate_limited"],
      [503, "retryable", "provider_unavailable"],
      [403, "permanent", "provider_authentication_failed"],
    ] as const) {
      await expect(
        createGeminiReadabilityAdapter({
          apiKey: "test-key",
          fetch: async () => new Response(null, { status }),
        }).checkReadable([page]),
      ).rejects.toMatchObject({ kind, code } satisfies Partial<GeminiReadabilityError>);
    }
  });

  it("does not accept an unreadable result without a valid failed page", async () => {
    await expect(
      createGeminiReadabilityAdapter({
        apiKey: "test-key",
        fetch: async () =>
          Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        schema_version: 1,
                        readable: false,
                        failed_page_indexes: [],
                        reasons: ["unreadable"],
                      }),
                    },
                  ],
                },
              },
            ],
          }),
      }).checkReadable([page]),
    ).rejects.toMatchObject({ kind: "retryable", code: "provider_invalid_response" });
  });
});
