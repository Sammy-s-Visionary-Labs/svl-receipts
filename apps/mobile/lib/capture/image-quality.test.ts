import { describe, expect, it } from "vitest";
import { type RgbaImage, scoreLocalImageQuality } from "./image-quality";

function image(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const index = (y * width + x) * 4;
      data[index] = red;
      data[index + 1] = green;
      data[index + 2] = blue;
      data[index + 3] = 255;
    }
  }
  return { width, height, data };
}

function codes(result: ReturnType<typeof scoreLocalImageQuality>) {
  return result.hints.map((hint) => hint.code);
}

describe("scoreLocalImageQuality", () => {
  it("explains a dark page without calling it unreadable", () => {
    const result = scoreLocalImageQuality(
      image(32, 32, () => [24, 24, 24]),
      {
        width: 1800,
        height: 1200,
      },
    );

    expect(codes(result)).toContain("too_dark");
    expect(codes(result)).not.toContain("blurry");
    expect(result).not.toHaveProperty("readable");
  });

  it("flags smooth, low-detail content as potentially blurry", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x) => {
        const value = 80 + Math.floor((x / 63) * 120);
        return [value, value, value];
      }),
      { width: 1800, height: 1200 },
    );

    expect(codes(result)).toContain("blurry");
  });

  it("detects low directional detail in a mildly softened page", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x) => {
        const value = Math.floor(x / 4) % 2 === 0 ? 135 : 165;
        return [value, value, value];
      }),
      { width: 1800, height: 1200 },
    );

    expect(result.metrics?.laplacianRms).toBeGreaterThanOrEqual(0.055);
    expect(codes(result)).toContain("blurry");
  });

  it("does not flag a high-frequency page as blurry", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x, y) => ((x + y) % 2 === 0 ? [245, 245, 245] : [25, 25, 25])),
      { width: 1800, height: 1200 },
    );

    expect(codes(result)).not.toContain("blurry");
  });

  it("detects a localized clipped highlight as possible glare", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x, y) => {
        if (x >= 16 && x < 40 && y >= 16 && y < 40) {
          return [255, 255, 255];
        }
        const value = (x + y) % 2 === 0 ? 140 : 175;
        return [value, value, value];
      }),
      { width: 1800, height: 1200 },
    );

    expect(codes(result)).toContain("glare");
  });

  it("detects a localized reflection before its pixels are fully clipped", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x, y) => {
        if (x >= 16 && x < 40 && y >= 16 && y < 40) {
          return [235, 235, 230];
        }
        const value = (x + y) % 2 === 0 ? 120 : 170;
        return [value, value, value];
      }),
      { width: 1800, height: 1200 },
    );

    expect(result.metrics?.clippedHighlightRatio).toBe(0);
    expect(codes(result)).toContain("glare");
  });

  it("does not confuse a broadly bright page with localized glare", () => {
    const result = scoreLocalImageQuality(
      image(64, 64, (x, y) => {
        const page = x >= 4 && x < 60 && y >= 4 && y < 60;
        return page ? [235, 235, 230] : [90, 90, 90];
      }),
      { width: 1800, height: 1200 },
    );

    expect(codes(result)).not.toContain("glare");
  });

  it("uses border-to-center contrast for conservative framing guidance", () => {
    const framed = scoreLocalImageQuality(
      image(64, 64, (x, y) => {
        const border = x < 8 || x >= 56 || y < 8 || y >= 56;
        return border ? [30, 30, 30] : [220, 220, 220];
      }),
      { width: 1800, height: 1200 },
    );
    const edgeToEdge = scoreLocalImageQuality(
      image(64, 64, (x, y) => ((x + y) % 8 === 0 ? [110, 110, 110] : [220, 220, 220])),
      { width: 1800, height: 1200 },
    );

    expect(codes(framed)).not.toContain("cropped");
    expect(codes(edgeToEdge)).toContain("cropped");
  });

  it("detects a receipt continuing through one side of the frame", () => {
    const result = scoreLocalImageQuality(
      image(96, 64, (x, y) => {
        const receipt = x >= 20 && y >= 2 && y < 62;
        return receipt ? [220, 220, 220] : [25, 25, 25];
      }),
      { width: 1800, height: 1200 },
    );

    expect(result.metrics?.borderToCenterContrast).toBeGreaterThan(0.045);
    expect(codes(result)).toContain("cropped");
  });

  it("keeps a framed, high-detail page free of quality hints", () => {
    const result = scoreLocalImageQuality(
      image(96, 64, (x, y) => {
        const border = x < 8 || x >= 88 || y < 8 || y >= 56;
        if (border) {
          return [45, 45, 45];
        }
        return x % 17 === 0 || y % 8 === 0 ? [80, 80, 80] : [205, 205, 205];
      }),
      { width: 1800, height: 1200 },
    );

    expect(codes(result)).toEqual([]);
  });

  it("warns when final dimensions are too small for reliable text", () => {
    const result = scoreLocalImageQuality(
      image(32, 32, () => [180, 180, 180]),
      {
        width: 900,
        height: 600,
      },
    );

    expect(codes(result)).toContain("low_resolution");
    expect(codes(result)).not.toContain("blurry");
  });
});
