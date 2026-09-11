import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  prepare: vi.fn(),
  platform: { OS: "android" },
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mocks.launch }));
vi.mock("react-native", () => ({ Platform: mocks.platform }));
vi.mock("./image-preparation", () => ({
  prepareReceiptPages: mocks.prepare,
  ReceiptImagePreparationError: class extends Error {
    constructor(readonly code: string) {
      super(code);
    }
  },
}));

import { chooseReceiptPagesFromGallery } from "./gallery";

const asset = (n: number) => ({
  uri: `file:///selected-${n}.jpg`,
  width: 1200,
  height: 1800,
  mimeType: "image/jpeg",
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.OS = "android";
  mocks.prepare.mockImplementation(async (pages) => pages);
});
describe("receipt gallery", () => {
  it("falls back to Android's document picker when the photo picker cannot open, retaining selection order and the cap", async () => {
    mocks.launch
      .mockRejectedValueOnce({ code: "ERR_PICKER_UNAVAILABLE" })
      .mockResolvedValueOnce({ canceled: false, assets: [asset(3), asset(1), asset(2)] });
    const result = await chooseReceiptPagesFromGallery(2);
    expect(mocks.launch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ legacy: true, mediaTypes: ["images"], selectionLimit: 2 }),
    );
    expect(result?.map((page) => page.uri)).toEqual([asset(3).uri, asset(1).uri]);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
  });
  it("does not reopen a picker after the worker cancels", async () => {
    mocks.launch.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await chooseReceiptPagesFromGallery(5)).toBeNull();
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("uses single selection for the last slot and never opens when all slots are full", async () => {
    expect(await chooseReceiptPagesFromGallery(0)).toEqual([]);
    expect(mocks.launch).not.toHaveBeenCalled();
    mocks.launch.mockResolvedValueOnce({ canceled: false, assets: [asset(1)] });
    await chooseReceiptPagesFromGallery(1);
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({ allowsMultipleSelection: false, selectionLimit: 1 }),
    );
  });
  it("does not confuse an unreadable selected image with a picker launch failure", async () => {
    mocks.launch.mockResolvedValueOnce({ canceled: false, assets: [asset(1)] });
    mocks.prepare.mockRejectedValueOnce(new Error("invalid_dimensions"));
    await expect(chooseReceiptPagesFromGallery(5)).rejects.toThrow("invalid_dimensions");
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable photo access when both Android pickers fail", async () => {
    mocks.launch.mockRejectedValue(new Error("native launch failed"));
    await expect(chooseReceiptPagesFromGallery(5)).rejects.toMatchObject({
      code: "gallery_unavailable",
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("does not invoke the Android fallback on iOS", async () => {
    mocks.platform.OS = "ios";
    mocks.launch.mockRejectedValueOnce(new Error("native launch failed"));
    await expect(chooseReceiptPagesFromGallery(5)).rejects.toMatchObject({
      code: "gallery_unavailable",
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });
});
