import { MAX_RECEIPT_BYTES } from "@svl/domain";
import type { DraftPage } from "./drafts";

export async function preparePhoto(file: Blob, rotation = 0): Promise<DraftPage> {
  if (file.size < 1 || file.size > 50 * 1024 * 1024) {
    throw new Error("Choose a photo smaller than 50 MB.");
  }
  const url = URL.createObjectURL(file);
  try {
    const source = new Image();
    source.src = url;
    try {
      await source.decode();
    } catch {
      throw new Error(
        "This photo could not be opened. Take a new photo, or choose a JPEG, PNG, or WebP image.",
      );
    }
    if (
      source.naturalWidth * source.naturalHeight > 80_000_000 ||
      Math.max(source.naturalWidth, source.naturalHeight) > 16_000
    ) {
      throw new Error(
        "This photo is too large to process. Take a new photo or choose a smaller image.",
      );
    }
    const scale = Math.min(1, 1800 / Math.max(source.naturalWidth, source.naturalHeight));
    const width = Math.max(1, Math.round(source.naturalWidth * scale));
    const height = Math.max(1, Math.round(source.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = rotation ? height : width;
    canvas.height = rotation ? width : height;
    const context = canvas.getContext("2d");
    if (!context)
      throw new Error("Photo preparation is unavailable. Reopen the app and try again.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (rotation) {
      context.translate(canvas.width, 0);
      context.rotate(Math.PI / 2);
    }
    context.drawImage(source, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("Photo could not be prepared."))),
        "image/jpeg",
        0.86,
      ),
    );
    if (blob.size > MAX_RECEIPT_BYTES)
      throw new Error("This photo is too large to send. Retake it closer to the receipt.");
    if (!crypto.subtle)
      throw new Error("Open the secure HTTPS app link to prepare receipt photos.");
    const bytes = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return {
      id: crypto.randomUUID(),
      blob,
      bytes,
      width: canvas.width,
      height: canvas.height,
      checksum: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
