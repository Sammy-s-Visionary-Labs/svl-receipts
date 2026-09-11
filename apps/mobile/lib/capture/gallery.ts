import * as ImagePicker from "expo-image-picker";
import { Platform } from "react-native";
import { prepareReceiptPages, ReceiptImagePreparationError } from "./image-preparation";
import type { CapturedReceiptPage, ReceiptPage } from "./receipt-pages";

function pageFromAsset(asset: ImagePicker.ImagePickerAsset): CapturedReceiptPage {
  return {
    uri: asset.uri,
    width: asset.width,
    height: asset.height,
    source: "gallery",
    fileName: asset.fileName,
    fileSize: asset.fileSize,
    mimeType: asset.mimeType,
  };
}

export async function chooseReceiptPagesFromGallery(limit: number): Promise<ReceiptPage[] | null> {
  if (limit < 1) {
    return [];
  }

  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ["images"],
    allowsMultipleSelection: limit > 1,
    orderedSelection: true,
    selectionLimit: limit,
    quality: 1,
  };
  let result: ImagePicker.ImagePickerResult;
  try {
    result = await ImagePicker.launchImageLibraryAsync(options);
  } catch (error) {
    // Some Android photo-picker implementations fail before opening. Fall back
    // to the system document picker; it grants access only to selected photos.
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
    console.warn(
      "[receipt-gallery] system_picker_failed",
      /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : "unknown",
    );
    if (Platform.OS !== "android") throw new ReceiptImagePreparationError("gallery_unavailable");
    try {
      result = await ImagePicker.launchImageLibraryAsync({ ...options, legacy: true });
    } catch {
      throw new ReceiptImagePreparationError("gallery_unavailable");
    }
  }

  if (result.canceled) {
    return null;
  }

  return prepareReceiptPages(result.assets.slice(0, limit).map(pageFromAsset));
}
