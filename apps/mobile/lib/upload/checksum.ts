import { MAX_RECEIPT_BYTES } from "@svl/domain";
import { CryptoDigestAlgorithm, digest } from "expo-crypto";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import type { ReceiptPage } from "@/lib/capture/receipt-pages";
import type { PreparedUploadPage } from "./types";

type ChecksumDependencies = {
  readBytes: (uri: string) => Promise<Uint8Array>;
  digestSha256: (bytes: Uint8Array) => Promise<ArrayBuffer>;
};

async function readBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === "web") {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Could not read prepared receipt page (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  return new File(uri).bytes();
}

const defaultDependencies: ChecksumDependencies = {
  readBytes,
  digestSha256: (bytes) => {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return digest(CryptoDigestAlgorithm.SHA256, copy);
  },
};

export function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function prepareReceiptPageForUpload(
  page: ReceiptPage,
  pageIndex: number,
  dependencies: ChecksumDependencies = defaultDependencies,
): Promise<PreparedUploadPage> {
  const bytes = await dependencies.readBytes(page.uri);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_RECEIPT_BYTES ||
    bytes.byteLength !== page.imageMetadata.finalBytes
  ) {
    throw new Error("prepared_page_changed");
  }
  return {
    pageIndex,
    bytes,
    checksum: bytesToHex(await dependencies.digestSha256(bytes)),
    byteSize: bytes.byteLength,
    contentType: "image/jpeg",
    originalFilename: page.fileName?.slice(0, 255) ?? null,
  };
}
