import { MAX_RECEIPT_BYTES } from "@svl/domain";
import sharp from "sharp";

export const THUMBNAIL_WIDTH = 128;
export const THUMBNAIL_HEIGHT = 160;

/** Decode a bounded first page into a small, metadata-free preview. */
export async function renderReceiptThumbnail(bytes: Buffer): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > MAX_RECEIPT_BYTES) {
    throw new Error("thumbnail_input_invalid");
  }
  // Match the upload contract before invoking a decoder. In particular, never
  // process a vector document merely because it was uploaded with an image MIME.
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!jpeg && !png && !webp) throw new Error("thumbnail_format_invalid");
  return sharp(bytes, { limitInputPixels: 40_000_000, failOn: "error", pages: 1 })
    .autoOrient()
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 72 })
    .timeout({ seconds: 5 })
    .toBuffer();
}
