import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";

const runtimeMocks = vi.hoisted(() => ({
  digest: vi.fn(),
  fileBytes: vi.fn(),
  fileConstructor: vi.fn(),
  platform: { OS: "android" },
}));

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: runtimeMocks.digest,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(uri: string) {
      runtimeMocks.fileConstructor(uri);
    }

    bytes() {
      return runtimeMocks.fileBytes();
    }
  },
}));
vi.mock("react-native", () => ({ Platform: runtimeMocks.platform }));

import { bytesToHex, prepareReceiptPageForUpload } from "./checksum";

const page: ReceiptPage = {
  uri: "file:///receipt.jpg",
  width: 800,
  height: 1200,
  source: "camera",
  fileName: "receipt.jpg",
  imageMetadata: {
    originalWidth: 800,
    originalHeight: 1200,
    finalWidth: 800,
    finalHeight: 1200,
    finalBytes: 3,
    mimeType: "image/jpeg",
    preparedAt: "2026-08-21T12:00:00.000Z",
  },
  quality: { status: "unavailable", metrics: null, hints: [] },
};

describe("receipt upload checksum", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    runtimeMocks.platform.OS = "android";
    runtimeMocks.fileBytes.mockResolvedValue(new Uint8Array([1, 2, 3]));
    runtimeMocks.digest.mockResolvedValue(new Uint8Array([0, 15, 255]).buffer);
  });

  it("records exact page bytes and a lowercase SHA-256 before upload", async () => {
    const prepared = await prepareReceiptPageForUpload(page, 0, {
      readBytes: async () => new Uint8Array([1, 2, 3]),
      digestSha256: async () => new Uint8Array([0, 15, 255]).buffer,
    });
    expect(prepared).toMatchObject({
      pageIndex: 0,
      byteSize: 3,
      checksum: "000fff",
      contentType: "image/jpeg",
    });
    expect(bytesToHex(new Uint8Array([10, 255]).buffer)).toBe("0aff");
  });

  it("reads native files and passes a copied Uint8Array to Expo Crypto", async () => {
    const fileBytes = new Uint8Array([1, 2, 3]);
    runtimeMocks.fileBytes.mockResolvedValue(fileBytes);

    const prepared = await prepareReceiptPageForUpload(page, 0);

    expect(runtimeMocks.fileConstructor).toHaveBeenCalledWith(page.uri);
    expect(runtimeMocks.fileBytes).toHaveBeenCalledOnce();
    expect(runtimeMocks.digest).toHaveBeenCalledOnce();
    const digestInput = runtimeMocks.digest.mock.calls[0]?.[1];
    expect(digestInput).toBeInstanceOf(Uint8Array);
    expect(digestInput).not.toBeInstanceOf(ArrayBuffer);
    expect(digestInput).not.toBe(fileBytes);
    expect(Array.from(digestInput as Uint8Array)).toEqual([1, 2, 3]);
    expect(prepared.checksum).toBe("000fff");
  });

  it("reads prepared pages with fetch on web instead of the native File API", async () => {
    runtimeMocks.platform.OS = "web";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareReceiptPageForUpload(page, 0);

    expect(fetchMock).toHaveBeenCalledWith(page.uri);
    expect(runtimeMocks.fileConstructor).not.toHaveBeenCalled();
    expect(runtimeMocks.fileBytes).not.toHaveBeenCalled();
    expect(runtimeMocks.digest.mock.calls[0]?.[1]).toBeInstanceOf(Uint8Array);
    expect(prepared.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("refuses a file that changed after image preparation", async () => {
    await expect(
      prepareReceiptPageForUpload(page, 0, {
        readBytes: async () => new Uint8Array([1, 2]),
        digestSha256: async () => new ArrayBuffer(32),
      }),
    ).rejects.toThrow("prepared_page_changed");
  });
});
