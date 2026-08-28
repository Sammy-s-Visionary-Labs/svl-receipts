import { describe, expect, it } from "vitest";
import {
  ALLOWED_RECEIPT_CONTENT_TYPES,
  buildReceiptStorageKey,
  declaredContentTypeMatches,
  isReceiptContentType,
  isSha256Checksum,
  MAX_RECEIPT_BYTES,
  MAX_RECEIPT_PAGES,
  normalizeChecksum,
  receiptManifestDigestInput,
} from "./upload";

describe("receipt upload constraints", () => {
  it("caps images at 10 MiB and allows jpeg/png/webp only", () => {
    expect(MAX_RECEIPT_BYTES).toBe(10 * 1024 * 1024);
    expect(MAX_RECEIPT_PAGES).toBe(5);
    expect(ALLOWED_RECEIPT_CONTENT_TYPES).toEqual(["image/jpeg", "image/png", "image/webp"]);
    expect(isReceiptContentType("image/jpeg")).toBe(true);
    expect(isReceiptContentType("application/pdf")).toBe(false);
  });

  it("builds non-guessable keys without original filenames", () => {
    const key = buildReceiptStorageKey({
      ownerUserId: "11111111-1111-1111-1111-111111111111",
      receiptId: "22222222-2222-2222-2222-222222222222",
      objectId: "33333333-3333-3333-3333-333333333333",
      contentType: "image/jpeg",
    });
    expect(key).toBe(
      "11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.jpg",
    );
    expect(key.includes("photo")).toBe(false);
  });

  it("accepts lowercase sha256 hex checksums only", () => {
    const hex = "a".repeat(64);
    expect(isSha256Checksum(hex)).toBe(true);
    expect(isSha256Checksum(hex.toUpperCase())).toBe(true);
    expect(normalizeChecksum(` ${hex.toUpperCase()} `)).toBe(hex);
    expect(isSha256Checksum("not-a-checksum")).toBe(false);
  });

  it("requires declared Content-Type metadata to match the session", () => {
    expect(declaredContentTypeMatches("image/jpeg", "image/jpeg")).toBe(true);
    expect(declaredContentTypeMatches(null, "image/jpeg")).toBe(false);
    expect(declaredContentTypeMatches("image/png", "image/jpeg")).toBe(false);
  });

  it("builds a deterministic ordered page manifest", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect(
      receiptManifestDigestInput([
        { pageIndex: 1, checksum: second, byteSize: 200 },
        { pageIndex: 0, checksum: first, byteSize: 100 },
      ]),
    ).toBe(`0:${first}:100\n1:${second}:200`);
    expect(() =>
      receiptManifestDigestInput([{ pageIndex: 1, checksum: first, byteSize: 100 }]),
    ).toThrow("invalid_receipt_page_manifest");
  });
});
