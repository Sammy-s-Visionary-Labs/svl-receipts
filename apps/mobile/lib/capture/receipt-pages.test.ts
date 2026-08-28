import { MAX_RECEIPT_PAGES } from "@svl/domain";
import { describe, expect, it } from "vitest";
import {
  appendReceiptPages,
  createInitialReceiptCaptureState,
  type ReceiptPage,
  receiptCaptureReducer,
} from "./receipt-pages";

function page(number: number, source: ReceiptPage["source"] = "camera"): ReceiptPage {
  return {
    uri: `file:///receipt-${number}.jpg`,
    width: 1200,
    height: 1800,
    source,
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
}

describe("receipt capture page set", () => {
  it("accepts pages in capture order up to the shared pilot cap", () => {
    const pages = appendReceiptPages(
      [],
      Array.from({ length: 7 }, (_, index) => page(index)),
    );

    expect(pages).toHaveLength(MAX_RECEIPT_PAGES);
    expect(pages.map((item) => item.uri)).toEqual([
      "file:///receipt-0.jpg",
      "file:///receipt-1.jpg",
      "file:///receipt-2.jpg",
      "file:///receipt-3.jpg",
      "file:///receipt-4.jpg",
    ]);
  });

  it("adds gallery pages only in the remaining slots", () => {
    const current = [page(1), page(2), page(3), page(4)];
    const pages = appendReceiptPages(current, [page(5, "gallery"), page(6, "gallery")]);

    expect(pages).toHaveLength(MAX_RECEIPT_PAGES);
    expect(pages.at(-1)).toMatchObject({ uri: "file:///receipt-5.jpg", source: "gallery" });
  });

  it("retakes one page without changing the rest of the receipt", () => {
    const withPages = receiptCaptureReducer(createInitialReceiptCaptureState(), {
      type: "add-pages",
      pages: [page(1), page(2), page(3)],
    });
    const retaking = receiptCaptureReducer(withPages, { type: "begin-retake", index: 1 });
    const replaced = receiptCaptureReducer(retaking, {
      type: "save-page",
      page: page(20),
    });

    expect(replaced.pages.map((item) => item.uri)).toEqual([
      "file:///receipt-1.jpg",
      "file:///receipt-20.jpg",
      "file:///receipt-3.jpg",
    ]);
    expect(replaced.replacementIndex).toBeNull();
    expect(replaced.previewIndex).toBe(1);
  });

  it("replaces only a rotated page and clears confirmation and location", () => {
    const withPages = receiptCaptureReducer(createInitialReceiptCaptureState(), {
      type: "add-pages",
      pages: [page(1), page(2), page(3)],
    });
    const confirmed = receiptCaptureReducer(withPages, { type: "confirm" });
    const located = receiptCaptureReducer(confirmed, {
      type: "set-location",
      location: {
        latitude: 40.7128,
        longitude: -74.006,
        accuracyMeters: 20,
        capturedAt: "2026-08-21T12:30:00.000Z",
      },
    });
    const rotated = page(20);
    rotated.width = 1800;
    rotated.height = 1200;

    const replaced = receiptCaptureReducer(located, {
      type: "replace-page",
      index: 1,
      page: rotated,
    });

    expect(replaced.pages[0]).toBe(located.pages[0]);
    expect(replaced.pages[1]).toBe(rotated);
    expect(replaced.pages[2]).toBe(located.pages[2]);
    expect(replaced.previewIndex).toBe(1);
    expect(replaced.replacementIndex).toBeNull();
    expect(replaced.confirmed).toBe(false);
    expect(replaced.locationDecision).toBe("undecided");
    expect(replaced.location).toEqual({
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      capturedAt: null,
    });
  });

  it("ignores an invalid retake target", () => {
    const state = receiptCaptureReducer(createInitialReceiptCaptureState(), {
      type: "add-pages",
      pages: [page(1)],
    });

    expect(receiptCaptureReducer(state, { type: "begin-retake", index: 2 })).toBe(state);
  });

  it("confirms only a non-empty page set and clears confirmation when edited", () => {
    const empty = createInitialReceiptCaptureState();
    expect(receiptCaptureReducer(empty, { type: "confirm" }).confirmed).toBe(false);

    const withPage = receiptCaptureReducer(empty, { type: "save-page", page: page(1) });
    const confirmed = receiptCaptureReducer(withPage, { type: "confirm" });
    expect(confirmed.confirmed).toBe(true);

    const edited = receiptCaptureReducer(confirmed, { type: "save-page", page: page(2) });
    expect(edited.confirmed).toBe(false);
  });

  it("stores a one-time location decision only after photos are confirmed", () => {
    const withPage = receiptCaptureReducer(createInitialReceiptCaptureState(), {
      type: "save-page",
      page: page(1),
    });
    const location = {
      latitude: 40.7128,
      longitude: -74.006,
      accuracyMeters: 20,
      capturedAt: "2026-08-21T12:30:00.000Z",
    };

    expect(receiptCaptureReducer(withPage, { type: "set-location", location })).toBe(withPage);

    const confirmed = receiptCaptureReducer(withPage, { type: "confirm" });
    const located = receiptCaptureReducer(confirmed, { type: "set-location", location });
    expect(located.locationDecision).toBe("included");
    expect(located.location).toEqual(location);
  });

  it("keeps all location fields nullable when the worker continues without it", () => {
    const withPage = receiptCaptureReducer(createInitialReceiptCaptureState(), {
      type: "save-page",
      page: page(1),
    });
    const confirmed = receiptCaptureReducer(withPage, { type: "confirm" });
    const skipped = receiptCaptureReducer(confirmed, { type: "skip-location" });

    expect(skipped.locationDecision).toBe("skipped");
    expect(skipped.location).toEqual({
      latitude: null,
      longitude: null,
      accuracyMeters: null,
      capturedAt: null,
    });
  });
});
