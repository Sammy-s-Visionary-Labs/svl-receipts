import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReceiptPage } from "./receipt-pages";

const runtimeMocks = vi.hoisted(() => ({
  analysisRender: vi.fn(),
  analysisResize: vi.fn(),
  analysisSave: vi.fn(),
  createUnavailableQuality: vi.fn(),
  decode: vi.fn(),
  fileBytes: vi.fn(),
  fileSize: vi.fn(),
  manipulate: vi.fn(),
  platform: { OS: "android" },
  rotate: vi.fn(),
  rotationRender: vi.fn(),
  rotationSave: vi.fn(),
  scoreQuality: vi.fn(),
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get size() {
      return runtimeMocks.fileSize(this.uri);
    }

    bytes() {
      return runtimeMocks.fileBytes(this.uri);
    }
  },
}));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: runtimeMocks.manipulate },
  SaveFormat: { JPEG: "jpeg" },
}));
vi.mock("jpeg-js", () => ({ decode: runtimeMocks.decode }));
vi.mock("react-native", () => ({ Platform: runtimeMocks.platform }));
vi.mock("./image-quality", () => ({
  createUnavailableImageQuality: runtimeMocks.createUnavailableQuality,
  scoreLocalImageQuality: runtimeMocks.scoreQuality,
}));

import { ReceiptImagePreparationError, rotateReceiptPageClockwise } from "./image-preparation";

const page: ReceiptPage = {
  uri: "file:///prepared-receipt.jpg",
  width: 1200,
  height: 1800,
  source: "gallery",
  fileName: "receipt.jpg",
  fileSize: 450_000,
  mimeType: "image/jpeg",
  imageMetadata: {
    originalWidth: 2400,
    originalHeight: 3600,
    finalWidth: 1200,
    finalHeight: 1800,
    finalBytes: 450_000,
    mimeType: "image/jpeg",
    preparedAt: "2026-08-21T12:00:00.000Z",
  },
  quality: { status: "analyzed", metrics: null, hints: [] },
};

const rotatedQuality = {
  status: "analyzed" as const,
  metrics: null,
  hints: [
    {
      code: "glare" as const,
      title: "Glare may hide details",
      guidance: "Move the reflection away from the receipt text.",
    },
  ],
};

describe("prepared receipt rotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T16:30:00.000Z"));
    runtimeMocks.platform.OS = "android";
    runtimeMocks.rotationRender.mockResolvedValue({ saveAsync: runtimeMocks.rotationSave });
    runtimeMocks.rotationSave.mockResolvedValue({
      uri: "file:///rotated-receipt.jpg",
      width: 1800,
      height: 1200,
    });
    runtimeMocks.analysisRender.mockResolvedValue({ saveAsync: runtimeMocks.analysisSave });
    runtimeMocks.analysisSave.mockResolvedValue({
      uri: "file:///rotated-analysis.jpg",
      width: 256,
      height: 171,
    });
    runtimeMocks.fileSize.mockImplementation((uri: string) =>
      uri === "file:///rotated-receipt.jpg" ? 321_000 : 0,
    );
    runtimeMocks.fileBytes.mockResolvedValue(new Uint8Array([255, 216, 255, 217]));
    const decoded = { width: 2, height: 2, data: new Uint8Array(16) };
    runtimeMocks.decode.mockReturnValue(decoded);
    runtimeMocks.scoreQuality.mockReturnValue(rotatedQuality);
    runtimeMocks.manipulate.mockImplementation((uri: string) => {
      if (uri === page.uri) {
        return {
          rotate: runtimeMocks.rotate,
          renderAsync: runtimeMocks.rotationRender,
        };
      }
      if (uri === "file:///rotated-receipt.jpg") {
        return {
          resize: runtimeMocks.analysisResize,
          renderAsync: runtimeMocks.analysisRender,
        };
      }
      throw new Error(`Unexpected image URI: ${uri}`);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rotates normalized pixels clockwise and refreshes upload metadata and quality", async () => {
    const rotated = await rotateReceiptPageClockwise(page);

    expect(runtimeMocks.manipulate).toHaveBeenNthCalledWith(1, page.uri);
    expect(runtimeMocks.rotate).toHaveBeenCalledWith(90);
    expect(runtimeMocks.rotationSave).toHaveBeenCalledWith({ compress: 0.86, format: "jpeg" });
    expect(runtimeMocks.analysisResize).toHaveBeenCalledWith({ width: 256, height: 171 });
    expect(runtimeMocks.scoreQuality).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2, height: 2 }),
      { width: 1800, height: 1200 },
    );
    expect(rotated).toMatchObject({
      uri: "file:///rotated-receipt.jpg",
      width: 1800,
      height: 1200,
      source: "gallery",
      fileName: "receipt.jpg",
      fileSize: 321_000,
      mimeType: "image/jpeg",
      imageMetadata: {
        originalWidth: 2400,
        originalHeight: 3600,
        finalWidth: 1800,
        finalHeight: 1200,
        finalBytes: 321_000,
        mimeType: "image/jpeg",
        preparedAt: "2026-08-25T16:30:00.000Z",
      },
      quality: rotatedQuality,
    });
  });

  it("returns a rotation-specific recoverable error when the transform fails", async () => {
    runtimeMocks.rotationRender.mockRejectedValue(new Error("native transform failed"));

    const error = await rotateReceiptPageClockwise(page).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ReceiptImagePreparationError);
    expect((error as ReceiptImagePreparationError).code).toBe("rotation_failed");
    expect((error as ReceiptImagePreparationError).message).toContain("could not be rotated");
  });
});
