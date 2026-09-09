import { MAX_RECEIPT_BYTES } from "@svl/domain";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { renderReceiptThumbnail } from "./thumbnail";

describe("receipt thumbnail", () => {
  it("resizes the page, strips metadata, and emits a small JPEG", async () => {
    const original = await sharp({
      create: { width: 1200, height: 1800, channels: 3, background: "white" },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const preview = await renderReceiptThumbnail(original);
    const metadata = await sharp(preview).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBeLessThanOrEqual(128);
    expect(metadata.height).toBeLessThanOrEqual(160);
    expect(metadata.width).toBeGreaterThan(metadata.height ?? 0);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(preview.length).toBeLessThan(original.length);
  });

  it("rejects empty, oversized, and corrupt inputs", async () => {
    await expect(renderReceiptThumbnail(Buffer.alloc(0))).rejects.toThrow();
    await expect(renderReceiptThumbnail(Buffer.alloc(MAX_RECEIPT_BYTES + 1))).rejects.toThrow();
    await expect(renderReceiptThumbnail(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("accepts raster upload formats and rejects vector documents", async () => {
    const raster = sharp({
      create: { width: 20, height: 30, channels: 4, background: "transparent" },
    });
    for (const input of [
      await raster.clone().png().toBuffer(),
      await raster.clone().webp().toBuffer(),
    ]) {
      expect((await sharp(await renderReceiptThumbnail(input)).metadata()).format).toBe("jpeg");
    }
    await expect(
      renderReceiptThumbnail(
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
      ),
    ).rejects.toThrow("thumbnail_format_invalid");
  });
});
