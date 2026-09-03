import { Buffer } from "node:buffer";
import {
  isReadabilityCheckV1,
  READABILITY_REASONS,
  READABILITY_SCHEMA_VERSION,
  type ReadabilityAdapterError,
  type ReadabilityCheckV1,
} from "@svl/domain";

export const GEMINI_READABILITY_PROVIDER = "google_gemini" as const;
export const GEMINI_READABILITY_MODEL = "gemini-3.5-flash-lite" as const;

export type GeminiReadabilityPage = {
  pageIndex: number;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Uint8Array;
};

export type GeminiReadabilityUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
};

export type GeminiReadabilityResult = {
  check: ReadabilityCheckV1;
  provider: typeof GEMINI_READABILITY_PROVIDER;
  model: string;
  usage: GeminiReadabilityUsage;
};

export class GeminiReadabilityError extends Error {
  readonly kind: ReadabilityAdapterError["kind"];
  readonly code: string;

  constructor(kind: ReadabilityAdapterError["kind"], code: string) {
    super(code);
    this.name = "GeminiReadabilityError";
    this.kind = kind;
    this.code = code;
  }
}

export type GeminiReadabilityAdapter = {
  checkReadable(pages: GeminiReadabilityPage[]): Promise<GeminiReadabilityResult>;
};

export function createGeminiReadabilityAdapter(input: {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam; production keeps inline requests safely below Gemini's documented 20 MB limit. */
  inlineByteLimit?: number;
  fetch?: typeof fetch;
}): GeminiReadabilityAdapter {
  const apiKey = input.apiKey.trim();
  const model = input.model?.trim() || GEMINI_READABILITY_MODEL;
  const timeoutMs = input.timeoutMs ?? 45_000;
  const inlineByteLimit = input.inlineByteLimit ?? 19 * 1024 * 1024;
  const request = input.fetch ?? globalThis.fetch;

  return {
    async checkReadable(pages) {
      if (!apiKey) {
        throw new GeminiReadabilityError("permanent", "provider_not_configured");
      }
      if (
        pages.length === 0 ||
        pages.some((page, index) => page.pageIndex !== index || page.bytes.byteLength === 0)
      ) {
        throw new GeminiReadabilityError("permanent", "invalid_page_set");
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const uploadedFiles: GeminiFile[] = [];
      try {
        let body: string;
        if (estimatedInlineRequestBytes(pages) > inlineByteLimit) {
          const outcomes = await Promise.allSettled(
            pages.map(async (page) => {
              const file = await uploadGeminiFile(request, apiKey, page, controller.signal);
              uploadedFiles.push(file);
              return file;
            }),
          );
          const failed = outcomes.find(
            (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
          );
          if (failed) {
            throw failed.reason;
          }
          const files = outcomes.map((outcome) =>
            outcome.status === "fulfilled" ? outcome.value : undefined,
          );
          if (files.some((file) => file === undefined)) {
            throw new GeminiReadabilityError("retryable", "provider_invalid_response");
          }
          body = JSON.stringify(buildGeminiFileRequest(files as GeminiFile[]));
        } else {
          body = JSON.stringify(buildGeminiInlineRequest(pages));
        }

        const response = await request(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-goog-api-key": apiKey,
            },
            body,
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          throw errorForStatus(response.status);
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new GeminiReadabilityError("retryable", "provider_invalid_response");
        }

        const parsed = parseGeminiResponse(payload, pages.length);
        return {
          check: parsed.check,
          provider: GEMINI_READABILITY_PROVIDER,
          model: parsed.model || model,
          usage: parsed.usage,
        };
      } catch (cause) {
        if (cause instanceof GeminiReadabilityError) {
          throw cause;
        }
        throw new GeminiReadabilityError(
          "retryable",
          cause instanceof Error && cause.name === "AbortError"
            ? "provider_timeout"
            : "provider_unavailable",
        );
      } finally {
        clearTimeout(timeout);
        await deleteGeminiFiles(request, apiKey, uploadedFiles);
      }
    },
  };
}

type GeminiFile = {
  name: string;
  uri: string;
  mimeType: GeminiReadabilityPage["mimeType"];
};

type GeminiMediaPart =
  | {
      inlineData: { mimeType: GeminiReadabilityPage["mimeType"]; data: string };
      mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" };
    }
  | {
      fileData: { mimeType: GeminiReadabilityPage["mimeType"]; fileUri: string };
      mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" };
    };

function buildGeminiInlineRequest(pages: GeminiReadabilityPage[]) {
  return buildGeminiRequest(
    pages.map((page) => ({
      inlineData: { mimeType: page.mimeType, data: Buffer.from(page.bytes).toString("base64") },
      mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
    })),
  );
}

function estimatedInlineRequestBytes(pages: GeminiReadabilityPage[]): number {
  const envelope = JSON.stringify(
    buildGeminiInlineRequest(pages.map((page) => ({ ...page, bytes: new Uint8Array() }))),
  );
  return (
    Buffer.byteLength(envelope, "utf8") +
    pages.reduce((total, page) => total + 4 * Math.ceil(page.bytes.byteLength / 3), 0)
  );
}

function buildGeminiFileRequest(files: GeminiFile[]) {
  return buildGeminiRequest(
    files.map((file) => ({
      fileData: { mimeType: file.mimeType, fileUri: file.uri },
      mediaResolution: { level: "MEDIA_RESOLUTION_HIGH" },
    })),
  );
}

function buildGeminiRequest(mediaParts: GeminiMediaPart[]) {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              "Perform only a visual readability gate for these receipt images.",
              "Do not transcribe, extract, or return any receipt text, prices, vendor names, or personal data.",
              "A page fails only when a worker should retake it because it is blurry, too dark, obscured by glare, cropped, rotated beyond practical reading, too low resolution, not a receipt, or otherwise unreadable.",
              "Difficult but readable pages pass. Evaluate every page in the supplied order using zero-based page indexes.",
              "When readable is true, return empty failed_page_indexes and reasons arrays.",
            ].join(" "),
          },
          ...mediaParts,
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 300,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          schema_version: { type: "integer", enum: [READABILITY_SCHEMA_VERSION] },
          readable: { type: "boolean" },
          failed_page_indexes: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
          reasons: {
            type: "array",
            items: { type: "string", enum: READABILITY_REASONS },
          },
        },
        required: ["schema_version", "readable", "failed_page_indexes", "reasons"],
      },
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    },
  };
}

async function uploadGeminiFile(
  request: typeof fetch,
  apiKey: string,
  page: GeminiReadabilityPage,
  signal: AbortSignal,
): Promise<GeminiFile> {
  const start = await request("https://generativelanguage.googleapis.com/upload/v1beta/files", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(page.bytes.byteLength),
      "x-goog-upload-header-content-type": page.mimeType,
    },
    body: JSON.stringify({ file: { displayName: `svl-readability-page-${page.pageIndex}` } }),
    signal,
  });
  if (!start.ok) {
    throw errorForStatus(start.status);
  }
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }

  const upload = await request(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": page.mimeType,
      "content-length": String(page.bytes.byteLength),
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: Uint8Array.from(page.bytes),
    signal,
  });
  if (!upload.ok) {
    throw errorForStatus(upload.status);
  }

  let payload: unknown;
  try {
    payload = await upload.json();
  } catch {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }
  const rawFile = (payload as { file?: Record<string, unknown> } | null)?.file;
  if (
    !rawFile ||
    typeof rawFile.name !== "string" ||
    !rawFile.name.startsWith("files/") ||
    typeof rawFile.uri !== "string" ||
    rawFile.uri.length === 0
  ) {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }
  return {
    name: rawFile.name,
    uri: rawFile.uri,
    mimeType:
      rawFile.mimeType === "image/jpeg" ||
      rawFile.mimeType === "image/png" ||
      rawFile.mimeType === "image/webp"
        ? rawFile.mimeType
        : page.mimeType,
  };
}

async function deleteGeminiFiles(
  request: typeof fetch,
  apiKey: string,
  files: GeminiFile[],
): Promise<void> {
  if (files.length === 0) {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    await Promise.allSettled(
      files.map((file) =>
        request(`https://generativelanguage.googleapis.com/v1beta/${file.name}`, {
          method: "DELETE",
          headers: { "x-goog-api-key": apiKey },
          signal: controller.signal,
        }),
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
}

function errorForStatus(status: number): GeminiReadabilityError {
  if (status === 408) {
    return new GeminiReadabilityError("retryable", "provider_timeout");
  }
  if (status === 429) {
    return new GeminiReadabilityError("retryable", "provider_rate_limited");
  }
  if (status >= 500) {
    return new GeminiReadabilityError("retryable", "provider_unavailable");
  }
  if (status === 401 || status === 403) {
    return new GeminiReadabilityError("permanent", "provider_authentication_failed");
  }
  return new GeminiReadabilityError("permanent", "provider_request_rejected");
}

function parseGeminiResponse(
  value: unknown,
  pageCount: number,
): { check: ReadabilityCheckV1; model: string | null; usage: GeminiReadabilityUsage } {
  if (!value || typeof value !== "object") {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }
  const response = value as {
    candidates?: Array<{
      finishReason?: unknown;
      content?: { parts?: Array<{ text?: unknown }> };
    }>;
    modelVersion?: unknown;
    usageMetadata?: Record<string, unknown>;
  };
  const text = response.candidates?.[0]?.content?.parts
    ?.map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
  if (!text) {
    throw new GeminiReadabilityError("retryable", "provider_empty_response");
  }

  let check: unknown;
  try {
    check = JSON.parse(text);
  } catch {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }
  if (!isReadabilityCheckV1(check)) {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }

  const normalized: ReadabilityCheckV1 = check.readable
    ? { schema_version: READABILITY_SCHEMA_VERSION, readable: true }
    : {
        schema_version: READABILITY_SCHEMA_VERSION,
        readable: false,
        failed_page_indexes: [...new Set(check.failed_page_indexes)].sort((a, b) => a - b),
        reasons: [...new Set(check.reasons)],
      };
  if (
    !normalized.readable &&
    (normalized.failed_page_indexes.length === 0 ||
      normalized.failed_page_indexes.some((index) => index >= pageCount))
  ) {
    throw new GeminiReadabilityError("retryable", "provider_invalid_response");
  }

  return {
    check: normalized,
    model: typeof response.modelVersion === "string" ? response.modelVersion : null,
    usage: parseUsage(response.usageMetadata),
  };
}

function parseUsage(value: Record<string, unknown> | undefined): GeminiReadabilityUsage {
  return {
    inputTokens: nonNegativeInteger(value?.promptTokenCount),
    outputTokens: nonNegativeInteger(value?.candidatesTokenCount),
    thinkingTokens: nonNegativeInteger(value?.thoughtsTokenCount),
    totalTokens: nonNegativeInteger(value?.totalTokenCount),
  };
}

function nonNegativeInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}
