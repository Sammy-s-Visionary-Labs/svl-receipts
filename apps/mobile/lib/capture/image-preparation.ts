import { MAX_RECEIPT_BYTES } from "@svl/domain";
import { File } from "expo-file-system";
import { ImageManipulator, type ImageRef, SaveFormat } from "expo-image-manipulator";
import { decode } from "jpeg-js";
import { Platform } from "react-native";
import { createUnavailableImageQuality, scoreLocalImageQuality } from "./image-quality";
import {
  getBoundedImageDimensions,
  RECEIPT_ANALYSIS_LONG_EDGE,
  RECEIPT_FINAL_LONG_EDGE,
  validateSourceImage,
} from "./image-sizing";
import type { CapturedReceiptPage, ReceiptPage } from "./receipt-pages";

export type ReceiptImagePreparationErrorCode =
  | "invalid_dimensions"
  | "source_too_large"
  | "final_too_large"
  | "processing_failed"
  | "gallery_unavailable"
  | "rotation_failed";

const ERROR_MESSAGES: Record<ReceiptImagePreparationErrorCode, string> = {
  invalid_dimensions: "This photo has invalid dimensions. Choose another image or retake the page.",
  source_too_large:
    "This photo is too large for safe on-device processing. Choose a smaller image or retake the page.",
  final_too_large:
    "The prepared photo is still too large to upload. Retake the page closer to the receipt.",
  processing_failed:
    "This photo could not be prepared. Choose a different image or take another photo.",
  gallery_unavailable:
    "Your phone could not open the photo library. Close any other photo picker and try again, or use Take receipt photo.",
  rotation_failed: "This photo could not be rotated. Try again or retake the page.",
};

export class ReceiptImagePreparationError extends Error {
  readonly code: ReceiptImagePreparationErrorCode;
  readonly recoverable = true;

  constructor(code: ReceiptImagePreparationErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "ReceiptImagePreparationError";
    this.code = code;
  }
}

async function readUriBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === "web") {
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Could not read prepared image (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  return new File(uri).bytes();
}

async function getUriByteLength(uri: string): Promise<number> {
  if (Platform.OS !== "web") {
    const size = new File(uri).size;
    if (size > 0) {
      return size;
    }
  }
  return (await readUriBytes(uri)).byteLength;
}

function jpegFileName(fileName?: string | null): string | null {
  if (!fileName) {
    return null;
  }
  return `${fileName.replace(/\.[^./]+$/, "")}.jpg`;
}

async function analyzePreparedImage(uri: string, width: number, height: number) {
  try {
    const analysisDimensions = getBoundedImageDimensions(width, height, RECEIPT_ANALYSIS_LONG_EDGE);
    const analysisContext = ImageManipulator.manipulate(uri);
    analysisContext.resize(analysisDimensions);
    const analysisRef = await analysisContext.renderAsync();
    const analysisImage = await analysisRef.saveAsync({
      compress: 0.82,
      format: SaveFormat.JPEG,
    });
    const encodedBytes = await readUriBytes(analysisImage.uri);
    const decoded = decode(encodedBytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: 1,
      maxMemoryUsageInMB: 16,
    });
    return scoreLocalImageQuality(decoded, { width, height });
  } catch {
    return createUnavailableImageQuality(width, height);
  }
}

async function savePreparedJpeg(rendered: ImageRef) {
  let result = await rendered.saveAsync({ compress: 0.86, format: SaveFormat.JPEG });
  let finalBytes = await getUriByteLength(result.uri);

  if (finalBytes > MAX_RECEIPT_BYTES) {
    result = await rendered.saveAsync({ compress: 0.68, format: SaveFormat.JPEG });
    finalBytes = await getUriByteLength(result.uri);
  }
  if (finalBytes < 1 || finalBytes > MAX_RECEIPT_BYTES) {
    throw new ReceiptImagePreparationError("final_too_large");
  }

  return { finalBytes, result };
}

export async function prepareReceiptPage(page: CapturedReceiptPage): Promise<ReceiptPage> {
  const validationError = validateSourceImage(page);
  if (validationError) {
    throw new ReceiptImagePreparationError(validationError);
  }

  try {
    const finalDimensions = getBoundedImageDimensions(
      page.width,
      page.height,
      RECEIPT_FINAL_LONG_EDGE,
    );
    const context = ImageManipulator.manipulate(page.uri);
    if (finalDimensions.width !== page.width || finalDimensions.height !== page.height) {
      context.resize(finalDimensions);
    }
    // Native decode + re-save converts EXIF orientation into the output pixels.
    const rendered = await context.renderAsync();
    const { finalBytes, result } = await savePreparedJpeg(rendered);

    const quality = await analyzePreparedImage(result.uri, result.width, result.height);
    return {
      ...page,
      uri: result.uri,
      width: result.width,
      height: result.height,
      fileName: jpegFileName(page.fileName),
      fileSize: finalBytes,
      mimeType: "image/jpeg",
      imageMetadata: {
        originalWidth: page.width,
        originalHeight: page.height,
        finalWidth: result.width,
        finalHeight: result.height,
        finalBytes,
        mimeType: "image/jpeg",
        preparedAt: new Date().toISOString(),
      },
      quality,
    };
  } catch (error) {
    if (error instanceof ReceiptImagePreparationError) {
      throw error;
    }
    throw new ReceiptImagePreparationError("processing_failed");
  }
}

export async function rotateReceiptPageClockwise(page: ReceiptPage): Promise<ReceiptPage> {
  try {
    // Prepared pages already have EXIF orientation baked into their pixels. This
    // explicit transform rotates those normalized pixels without guessing intent.
    const context = ImageManipulator.manipulate(page.uri);
    context.rotate(90);
    const rendered = await context.renderAsync();
    const { finalBytes, result } = await savePreparedJpeg(rendered);
    if (validateSourceImage({ width: result.width, height: result.height })) {
      throw new ReceiptImagePreparationError("rotation_failed");
    }

    const quality = await analyzePreparedImage(result.uri, result.width, result.height);
    return {
      ...page,
      uri: result.uri,
      width: result.width,
      height: result.height,
      fileName: jpegFileName(page.fileName),
      fileSize: finalBytes,
      mimeType: "image/jpeg",
      imageMetadata: {
        ...page.imageMetadata,
        finalWidth: result.width,
        finalHeight: result.height,
        finalBytes,
        mimeType: "image/jpeg",
        preparedAt: new Date().toISOString(),
      },
      quality,
    };
  } catch (error) {
    if (error instanceof ReceiptImagePreparationError && error.code === "final_too_large") {
      throw error;
    }
    throw new ReceiptImagePreparationError("rotation_failed");
  }
}

export async function prepareReceiptPages(
  pages: readonly CapturedReceiptPage[],
): Promise<ReceiptPage[]> {
  const prepared: ReceiptPage[] = [];
  for (const page of pages) {
    prepared.push(await prepareReceiptPage(page));
  }
  return prepared;
}

export function receiptPreparationMessage(error: unknown): string {
  return error instanceof ReceiptImagePreparationError
    ? error.message
    : ERROR_MESSAGES.processing_failed;
}
