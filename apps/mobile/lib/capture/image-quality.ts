export const LOCAL_QUALITY_HINT_CODES = [
  "blurry",
  "too_dark",
  "glare",
  "cropped",
  "low_resolution",
] as const;

export type LocalQualityHintCode = (typeof LOCAL_QUALITY_HINT_CODES)[number];

export type LocalQualityHint = {
  code: LocalQualityHintCode;
  title: string;
  guidance: string;
};

export type LocalQualityMetrics = {
  meanLuma: number;
  darkPixelRatio: number;
  clippedHighlightRatio: number;
  laplacianRms: number;
  borderToCenterContrast: number;
  sampledWidth: number;
  sampledHeight: number;
};

export type LocalImageQuality = {
  status: "analyzed" | "unavailable";
  metrics: LocalQualityMetrics | null;
  hints: LocalQualityHint[];
};

export type RgbaImage = {
  width: number;
  height: number;
  data: Uint8Array;
};

const HINTS: Record<LocalQualityHintCode, LocalQualityHint> = {
  blurry: {
    code: "blurry",
    title: "Photo may be blurry",
    guidance:
      "Hold the phone steady, tap to focus, and retake the page if the small print is soft.",
  },
  too_dark: {
    code: "too_dark",
    title: "Photo may be too dark",
    guidance: "Move to brighter, even light and keep your hand from shading the receipt.",
  },
  glare: {
    code: "glare",
    title: "Glare may hide details",
    guidance: "Tilt the phone or receipt slightly so bright reflections move away from the text.",
  },
  cropped: {
    code: "cropped",
    title: "Receipt edges may be cropped",
    guidance: "Leave a small border around the receipt and make sure every corner is visible.",
  },
  low_resolution: {
    code: "low_resolution",
    title: "Photo resolution is low",
    guidance:
      "Move closer without cutting off the receipt, then retake so the line items stay clear.",
  },
};

function hint(code: LocalQualityHintCode): LocalQualityHint {
  return HINTS[code];
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function lowResolutionHints(width: number, height: number): LocalQualityHint[] {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  return longEdge < 1200 || shortEdge < 700 ? [hint("low_resolution")] : [];
}

export function createUnavailableImageQuality(width: number, height: number): LocalImageQuality {
  return {
    status: "unavailable",
    metrics: null,
    hints: lowResolutionHints(width, height),
  };
}

export function scoreLocalImageQuality(
  image: RgbaImage,
  finalDimensions: { width: number; height: number },
): LocalImageQuality {
  const { width, height, data } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 3 ||
    height < 3 ||
    data.length < width * height * 4
  ) {
    return createUnavailableImageQuality(finalDimensions.width, finalDimensions.height);
  }

  const pixelCount = width * height;
  const luma = new Float32Array(pixelCount);
  const borderBand = Math.max(1, Math.floor(Math.min(width, height) * 0.06));
  const centerLeft = Math.floor(width * 0.2);
  const centerRight = Math.ceil(width * 0.8);
  const centerTop = Math.floor(height * 0.2);
  const centerBottom = Math.ceil(height * 0.8);
  const tileColumns = 8;
  const tileRows = 8;
  const clippedPerTile = new Uint32Array(tileColumns * tileRows);
  const nearHighlightPerTile = new Uint32Array(tileColumns * tileRows);
  const pixelsPerTile = new Uint32Array(tileColumns * tileRows);

  let lumaSum = 0;
  let lumaSquaredSum = 0;
  let darkPixels = 0;
  let clippedPixels = 0;
  let nearHighlightPixels = 0;
  let borderSum = 0;
  let borderPixels = 0;
  let centerSum = 0;
  let centerPixels = 0;
  let leftBorderSum = 0;
  let leftBorderPixels = 0;
  let rightBorderSum = 0;
  let rightBorderPixels = 0;
  let topBorderSum = 0;
  let topBorderPixels = 0;
  let bottomBorderSum = 0;
  let bottomBorderPixels = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = y * width + x;
      const dataIndex = pixelIndex * 4;
      const red = data[dataIndex] / 255;
      const green = data[dataIndex + 1] / 255;
      const blue = data[dataIndex + 2] / 255;
      const pixelLuma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      luma[pixelIndex] = pixelLuma;
      lumaSum += pixelLuma;
      lumaSquaredSum += pixelLuma * pixelLuma;

      if (pixelLuma < 0.25) {
        darkPixels += 1;
      }

      const tileX = Math.min(tileColumns - 1, Math.floor((x * tileColumns) / width));
      const tileY = Math.min(tileRows - 1, Math.floor((y * tileRows) / height));
      const tileIndex = tileY * tileColumns + tileX;
      pixelsPerTile[tileIndex] += 1;
      const channelSpread = Math.max(red, green, blue) - Math.min(red, green, blue);
      if (pixelLuma > 0.985 && channelSpread < 0.04) {
        clippedPixels += 1;
        clippedPerTile[tileIndex] += 1;
      }
      if (pixelLuma > 0.88 && channelSpread < 0.08) {
        nearHighlightPixels += 1;
        nearHighlightPerTile[tileIndex] += 1;
      }

      if (x < borderBand || x >= width - borderBand || y < borderBand || y >= height - borderBand) {
        borderSum += pixelLuma;
        borderPixels += 1;
      }
      if (x < borderBand) {
        leftBorderSum += pixelLuma;
        leftBorderPixels += 1;
      }
      if (x >= width - borderBand) {
        rightBorderSum += pixelLuma;
        rightBorderPixels += 1;
      }
      if (y < borderBand) {
        topBorderSum += pixelLuma;
        topBorderPixels += 1;
      }
      if (y >= height - borderBand) {
        bottomBorderSum += pixelLuma;
        bottomBorderPixels += 1;
      }
      if (x >= centerLeft && x < centerRight && y >= centerTop && y < centerBottom) {
        centerSum += pixelLuma;
        centerPixels += 1;
      }
    }
  }

  let laplacianSum = 0;
  let laplacianSquaredSum = 0;
  let horizontalDeltaSquaredSum = 0;
  let verticalDeltaSquaredSum = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const value =
        luma[index] * 4 -
        luma[index - 1] -
        luma[index + 1] -
        luma[index - width] -
        luma[index + width];
      laplacianSum += value;
      laplacianSquaredSum += value * value;
      horizontalDeltaSquaredSum += (luma[index + 1] - luma[index - 1]) ** 2;
      verticalDeltaSquaredSum += (luma[index + width] - luma[index - width]) ** 2;
      laplacianCount += 1;
    }
  }

  const meanLuma = lumaSum / pixelCount;
  const lumaVariance = Math.max(0, lumaSquaredSum / pixelCount - meanLuma * meanLuma);
  const laplacianMean = laplacianSum / laplacianCount;
  const laplacianVariance = Math.max(
    0,
    laplacianSquaredSum / laplacianCount - laplacianMean * laplacianMean,
  );
  const darkPixelRatio = darkPixels / pixelCount;
  const clippedHighlightRatio = clippedPixels / pixelCount;
  const borderMean = borderPixels > 0 ? borderSum / borderPixels : meanLuma;
  const centerMean = centerPixels > 0 ? centerSum / centerPixels : meanLuma;
  const borderToCenterContrast = Math.abs(centerMean - borderMean);
  const laplacianRms = Math.sqrt(laplacianVariance);
  const directionalDetailRms = Math.min(
    Math.sqrt(horizontalDeltaSquaredSum / laplacianCount),
    Math.sqrt(verticalDeltaSquaredSum / laplacianCount),
  );
  const sideMeans = [
    leftBorderPixels > 0 ? leftBorderSum / leftBorderPixels : meanLuma,
    rightBorderPixels > 0 ? rightBorderSum / rightBorderPixels : meanLuma,
    topBorderPixels > 0 ? topBorderSum / topBorderPixels : meanLuma,
    bottomBorderPixels > 0 ? bottomBorderSum / bottomBorderPixels : meanLuma,
  ];

  let brightTileCount = 0;
  let nearBrightTileCount = 0;
  for (let index = 0; index < pixelsPerTile.length; index += 1) {
    if (pixelsPerTile[index] > 0 && clippedPerTile[index] / pixelsPerTile[index] >= 0.65) {
      brightTileCount += 1;
    }
    if (pixelsPerTile[index] > 0 && nearHighlightPerTile[index] / pixelsPerTile[index] >= 0.65) {
      nearBrightTileCount += 1;
    }
  }

  const clippedGlareDetected =
    clippedHighlightRatio >= 0.035 &&
    clippedHighlightRatio <= 0.33 &&
    brightTileCount >= 1 &&
    brightTileCount <= 12;
  const nearHighlightRatio = nearHighlightPixels / pixelCount;
  const softGlareDetected =
    nearHighlightRatio >= 0.025 &&
    nearHighlightRatio <= 0.2 &&
    nearBrightTileCount >= 2 &&
    nearBrightTileCount <= 12;
  const glareDetected = clippedGlareDetected || softGlareDetected;
  const edgeContinuesThroughFrame =
    centerMean > 0.55 &&
    sideMeans.some((sideMean) => sideMean > 0.6 && Math.abs(sideMean - centerMean) < 0.07) &&
    sideMeans.some((sideMean) => Math.abs(sideMean - centerMean) > 0.18);
  const croppedDetected =
    (meanLuma > 0.42 && borderToCenterContrast < 0.045) || edgeContinuesThroughFrame;
  const blurryDetected =
    meanLuma > 0.38 &&
    darkPixelRatio < 0.45 &&
    lumaVariance > 0.0006 &&
    !glareDetected &&
    (laplacianRms < 0.055 || (laplacianRms < 0.09 && directionalDetailRms < 0.07));

  const hints: LocalQualityHint[] = [];
  if (meanLuma < 0.32 || darkPixelRatio > 0.55) {
    hints.push(hint("too_dark"));
  }
  if (blurryDetected) {
    hints.push(hint("blurry"));
  }
  if (glareDetected) {
    hints.push(hint("glare"));
  }
  if (croppedDetected) {
    hints.push(hint("cropped"));
  }
  hints.push(...lowResolutionHints(finalDimensions.width, finalDimensions.height));

  return {
    status: "analyzed",
    metrics: {
      meanLuma: roundMetric(meanLuma),
      darkPixelRatio: roundMetric(darkPixelRatio),
      clippedHighlightRatio: roundMetric(clippedHighlightRatio),
      laplacianRms: roundMetric(laplacianRms),
      borderToCenterContrast: roundMetric(borderToCenterContrast),
      sampledWidth: width,
      sampledHeight: height,
    },
    hints,
  };
}
