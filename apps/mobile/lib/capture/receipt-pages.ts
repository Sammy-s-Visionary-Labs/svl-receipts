import { MAX_RECEIPT_PAGES } from "@svl/domain";
import type { LocalImageQuality } from "./image-quality";

export type ReceiptPageSource = "camera" | "gallery";

export type CapturedReceiptPage = {
  uri: string;
  width: number;
  height: number;
  source: ReceiptPageSource;
  fileName?: string | null;
  fileSize?: number;
  mimeType?: string | null;
};

export type PreparedImageMetadata = {
  originalWidth: number;
  originalHeight: number;
  finalWidth: number;
  finalHeight: number;
  finalBytes: number;
  mimeType: "image/jpeg";
  preparedAt: string;
};

export type ReceiptPage = CapturedReceiptPage & {
  imageMetadata: PreparedImageMetadata;
  quality: LocalImageQuality;
};

export type ReceiptLocationMetadata = {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  capturedAt: string | null;
};

export type ReceiptLocationDecision = "undecided" | "included" | "skipped";

export type ReceiptCaptureState = {
  pages: ReceiptPage[];
  replacementIndex: number | null;
  requiredRetakeIndexes: number[];
  previewIndex: number;
  confirmed: boolean;
  location: ReceiptLocationMetadata;
  locationDecision: ReceiptLocationDecision;
};

export type ReceiptCaptureAction =
  | { type: "start-new" }
  | { type: "add-pages"; pages: ReceiptPage[] }
  | { type: "begin-retake"; index: number }
  | { type: "begin-required-retakes"; indexes: number[] }
  | { type: "cancel-retake" }
  | { type: "save-page"; page: ReceiptPage }
  | { type: "replace-page"; index: number; page: ReceiptPage }
  | { type: "remove-page"; index: number }
  | { type: "confirm" }
  | { type: "set-location"; location: ReceiptLocationMetadata }
  | { type: "skip-location" };

export function createEmptyReceiptLocation(): ReceiptLocationMetadata {
  return {
    latitude: null,
    longitude: null,
    accuracyMeters: null,
    capturedAt: null,
  };
}

export function createInitialReceiptCaptureState(): ReceiptCaptureState {
  return {
    pages: [],
    replacementIndex: null,
    requiredRetakeIndexes: [],
    previewIndex: 0,
    confirmed: false,
    location: createEmptyReceiptLocation(),
    locationDecision: "undecided",
  };
}

export function appendReceiptPages(
  current: readonly ReceiptPage[],
  incoming: readonly ReceiptPage[],
): ReceiptPage[] {
  const remaining = Math.max(0, MAX_RECEIPT_PAGES - current.length);
  return [...current, ...incoming.slice(0, remaining)];
}

export function replaceReceiptPage(
  current: readonly ReceiptPage[],
  index: number,
  replacement: ReceiptPage,
): ReceiptPage[] {
  if (!Number.isInteger(index) || index < 0 || index >= current.length) {
    return [...current];
  }

  return current.map((page, pageIndex) => (pageIndex === index ? replacement : page));
}

export function receiptCaptureReducer(
  state: ReceiptCaptureState,
  action: ReceiptCaptureAction,
): ReceiptCaptureState {
  switch (action.type) {
    case "remove-page": {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.pages.length)
        return state;
      const pages = state.pages.filter((_, index) => index !== action.index);
      if (!pages.length) return createInitialReceiptCaptureState();
      return {
        ...state,
        pages,
        replacementIndex: null,
        requiredRetakeIndexes: state.requiredRetakeIndexes
          .filter((index) => index !== action.index)
          .map((index) => (index > action.index ? index - 1 : index)),
        previewIndex: Math.min(action.index, pages.length - 1),
        confirmed: false,
        location: createEmptyReceiptLocation(),
        locationDecision: "undecided",
      };
    }
    case "start-new":
      return createInitialReceiptCaptureState();
    case "add-pages": {
      const pages = appendReceiptPages(state.pages, action.pages);
      const firstAddedIndex = Math.min(state.pages.length, Math.max(0, pages.length - 1));
      return {
        pages,
        replacementIndex: null,
        requiredRetakeIndexes: state.requiredRetakeIndexes.filter((index) => index < pages.length),
        previewIndex: firstAddedIndex,
        confirmed: false,
        location: createEmptyReceiptLocation(),
        locationDecision: "undecided",
      };
    }
    case "begin-retake":
      if (action.index < 0 || action.index >= state.pages.length) {
        return state;
      }
      return { ...state, replacementIndex: action.index, confirmed: false };
    case "begin-required-retakes": {
      const indexes = [...new Set(action.indexes)]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < state.pages.length)
        .sort((left, right) => left - right);
      const firstIndex = indexes[0];
      if (firstIndex === undefined) {
        return state;
      }
      return {
        ...state,
        replacementIndex: firstIndex,
        requiredRetakeIndexes: indexes,
        previewIndex: firstIndex,
        confirmed: false,
      };
    }
    case "cancel-retake":
      return { ...state, replacementIndex: null };
    case "save-page":
      if (state.replacementIndex !== null) {
        const replacedIndex = state.replacementIndex;
        return {
          pages: replaceReceiptPage(state.pages, replacedIndex, action.page),
          replacementIndex: null,
          requiredRetakeIndexes: state.requiredRetakeIndexes.filter(
            (index) => index !== replacedIndex,
          ),
          previewIndex: replacedIndex,
          confirmed: false,
          location: createEmptyReceiptLocation(),
          locationDecision: "undecided",
        };
      }
      return {
        pages: appendReceiptPages(state.pages, [action.page]),
        replacementIndex: null,
        requiredRetakeIndexes: state.requiredRetakeIndexes,
        previewIndex: Math.min(state.pages.length, MAX_RECEIPT_PAGES - 1),
        confirmed: false,
        location: createEmptyReceiptLocation(),
        locationDecision: "undecided",
      };
    case "replace-page":
      if (
        !Number.isInteger(action.index) ||
        action.index < 0 ||
        action.index >= state.pages.length
      ) {
        return state;
      }
      return {
        pages: replaceReceiptPage(state.pages, action.index, action.page),
        replacementIndex: null,
        requiredRetakeIndexes: state.requiredRetakeIndexes.filter(
          (index) => index !== action.index,
        ),
        previewIndex: action.index,
        confirmed: false,
        location: createEmptyReceiptLocation(),
        locationDecision: "undecided",
      };
    case "confirm":
      if (
        state.pages.length === 0 ||
        state.pages.length > MAX_RECEIPT_PAGES ||
        state.requiredRetakeIndexes.length > 0
      ) {
        return state;
      }
      return { ...state, replacementIndex: null, confirmed: true };
    case "set-location":
      if (!state.confirmed) {
        return state;
      }
      return { ...state, location: action.location, locationDecision: "included" };
    case "skip-location":
      if (!state.confirmed) {
        return state;
      }
      return {
        ...state,
        location: createEmptyReceiptLocation(),
        locationDecision: "skipped",
      };
  }
}
