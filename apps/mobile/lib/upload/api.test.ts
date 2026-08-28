import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({ apiBaseUrl: () => "https://api.invalid" }));

import {
  isAllowedReceiptUploadUrl,
  parseReceiptUploadSession,
  type ReceiptUploadUrlPolicy,
} from "./api";

const localHosts = ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"];

function session(uploadUrl: string) {
  return {
    receiptId: "11111111-1111-4111-8111-111111111111",
    status: "upload_pending",
    expiresAt: "2026-08-21T14:00:00.000Z",
    targets: [
      {
        pageIndex: 0,
        storageKey: "owner/receipt/0.jpg",
        uploadUrl,
        token: "signed-target-token",
        allowedContentType: "image/jpeg",
        maxBytes: 10 * 1024 * 1024,
      },
    ],
  };
}

describe("receipt upload URL policy", () => {
  it("accepts HTTPS in both production and development", () => {
    for (const policy of ["production", "development"] satisfies ReceiptUploadUrlPolicy[]) {
      expect(isAllowedReceiptUploadUrl("https://storage.invalid/signed/path", policy)).toBe(true);
    }
  });

  it("accepts HTTP only for explicit local development hosts", () => {
    for (const host of localHosts) {
      const url = `http://${host}:54321/storage/v1/upload/sign/object`;
      expect(isAllowedReceiptUploadUrl(url, "development")).toBe(true);
      expect(isAllowedReceiptUploadUrl(url, "production")).toBe(false);
    }
  });

  it("rejects broad or deceptive HTTP targets in development", () => {
    for (const url of [
      "http://192.168.1.10:54321/storage",
      "http://10.0.2.3:54321/storage",
      "http://localhost.evil.invalid/storage",
      "http://10.0.2.2.evil.invalid/storage",
      "http://10.0.2.2@evil.invalid/storage",
      "http://user:password@10.0.2.2/storage",
      "ftp://10.0.2.2/storage",
      "not a URL",
    ]) {
      expect(isAllowedReceiptUploadUrl(url, "development")).toBe(false);
    }
  });

  it("applies the explicit policy while parsing signed targets", () => {
    const localSession = session("http://10.0.2.2:54321/storage/v1/upload/sign/object");
    expect(parseReceiptUploadSession(localSession, "development").status).toBe("upload_pending");
    expect(() => parseReceiptUploadSession(localSession, "production")).toThrow(
      "Upload target was incomplete",
    );
  });
});
