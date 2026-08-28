import * as ImagePicker from "expo-image-picker";
import { prepareReceiptPages } from "./image-preparation";
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

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: limit > 1,
    orderedSelection: true,
    selectionLimit: limit,
    quality: 1,
  });

  if (result.canceled) {
    return null;
  }

  return prepareReceiptPages(result.assets.slice(0, limit).map(pageFromAsset));
}
