export const RECEIPT_FINAL_LONG_EDGE = 1800;
export const RECEIPT_ANALYSIS_LONG_EDGE = 256;
export const MAX_SOURCE_IMAGE_EDGE = 16_000;
export const MAX_SOURCE_IMAGE_PIXELS = 80_000_000;
export const MAX_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;

export type ImageDimensions = {
  width: number;
  height: number;
};

export type SourceImageValidationError = "invalid_dimensions" | "source_too_large";

export function getBoundedImageDimensions(
  width: number,
  height: number,
  maxLongEdge: number,
): ImageDimensions {
  if (width <= 0 || height <= 0 || maxLongEdge <= 0) {
    return { width: 0, height: 0 };
  }

  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function validateSourceImage(input: {
  width: number;
  height: number;
  fileSize?: number;
}): SourceImageValidationError | null {
  const { width, height, fileSize } = input;
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  ) {
    return "invalid_dimensions";
  }

  if (
    Math.max(width, height) > MAX_SOURCE_IMAGE_EDGE ||
    width * height > MAX_SOURCE_IMAGE_PIXELS ||
    (fileSize !== undefined && fileSize > MAX_SOURCE_IMAGE_BYTES)
  ) {
    return "source_too_large";
  }

  return null;
}
