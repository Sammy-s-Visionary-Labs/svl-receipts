import { describe, expect, it } from "vitest";
import {
  getBoundedImageDimensions,
  MAX_SOURCE_IMAGE_BYTES,
  RECEIPT_FINAL_LONG_EDGE,
  validateSourceImage,
} from "./image-sizing";

describe("receipt image sizing", () => {
  it("reduces the long edge to 1800px without changing aspect ratio", () => {
    expect(getBoundedImageDimensions(4000, 3000, RECEIPT_FINAL_LONG_EDGE)).toEqual({
      width: 1800,
      height: 1350,
    });
    expect(getBoundedImageDimensions(3000, 4000, RECEIPT_FINAL_LONG_EDGE)).toEqual({
      width: 1350,
      height: 1800,
    });
  });

  it("does not upscale a smaller receipt image", () => {
    expect(getBoundedImageDimensions(1200, 800, RECEIPT_FINAL_LONG_EDGE)).toEqual({
      width: 1200,
      height: 800,
    });
  });

  it("rejects invalid or absurd source metadata before native decoding", () => {
    expect(validateSourceImage({ width: 0, height: 1200 })).toBe("invalid_dimensions");
    expect(validateSourceImage({ width: 20_000, height: 1000 })).toBe("source_too_large");
    expect(
      validateSourceImage({ width: 4000, height: 3000, fileSize: MAX_SOURCE_IMAGE_BYTES + 1 }),
    ).toBe("source_too_large");
  });

  it("accepts a normal phone-camera image", () => {
    expect(validateSourceImage({ width: 4032, height: 3024, fileSize: 6_000_000 })).toBeNull();
  });
});
