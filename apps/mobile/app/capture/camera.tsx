import { MAX_RECEIPT_PAGES } from "@svl/domain";
import { CameraView, useCameraPermissions } from "expo-camera";
import { type Href, Redirect, useFocusEffect, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { chooseReceiptPagesFromGallery } from "@/lib/capture/gallery";
import { prepareReceiptPage, receiptPreparationMessage } from "@/lib/capture/image-preparation";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

export default function ReceiptCameraScreen() {
  const router = useRouter();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission, refreshPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [requestBusy, setRequestBusy] = useState(false);
  const [captureBusy, setCaptureBusy] = useState(false);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const { state, addPages, cancelRetake, savePage } = useReceiptCapture();

  useFocusEffect(
    useCallback(() => {
      void refreshPermission();
    }, [refreshPermission]),
  );

  const replacementIndex = state.replacementIndex;
  const isRetaking = replacementIndex !== null;
  const canCapture = isRetaking || state.pages.length < MAX_RECEIPT_PAGES;
  const nextPageNumber = replacementIndex !== null ? replacementIndex + 1 : state.pages.length + 1;

  function leaveCamera() {
    cancelRetake();
    router.replace((state.pages.length > 0 ? "/capture/preview" : "/(tabs)") as Href);
  }

  async function askForCamera() {
    setRequestBusy(true);
    try {
      await requestPermission();
    } catch {
      Alert.alert(
        "Camera access did not open",
        "You can try again or choose receipt photos from the gallery.",
      );
    } finally {
      setRequestBusy(false);
    }
  }

  async function openSettings() {
    try {
      await Linking.openSettings();
    } catch {
      Alert.alert(
        "Settings could not open",
        "Open Settings on your phone and allow camera access.",
      );
    }
  }

  async function chooseFromGallery() {
    const remaining = isRetaking ? 1 : MAX_RECEIPT_PAGES - state.pages.length;
    setGalleryBusy(true);
    try {
      const pages = await chooseReceiptPagesFromGallery(remaining);
      if (!pages?.length) {
        return;
      }
      if (isRetaking) {
        savePage(pages[0]);
      } else {
        addPages(pages);
      }
      router.replace("/capture/preview" as Href);
    } catch (error) {
      Alert.alert("Photo needs another try", receiptPreparationMessage(error));
    } finally {
      setGalleryBusy(false);
    }
  }

  async function takePhoto() {
    if (!cameraRef.current || !cameraReady || captureBusy || !canCapture) {
      return;
    }

    setCaptureBusy(true);
    try {
      const picture = await cameraRef.current.takePictureAsync({
        quality: 1,
        skipProcessing: false,
      });
      const page = await prepareReceiptPage({
        uri: picture.uri,
        width: picture.width,
        height: picture.height,
        source: "camera",
      });
      savePage(page);
      router.replace("/capture/preview" as Href);
    } catch (error) {
      Alert.alert("Photo needs another try", receiptPreparationMessage(error));
      setCaptureBusy(false);
    }
  }

  if (!canCapture) {
    return <Redirect href={"/capture/preview" as Href} />;
  }

  if (!permission) {
    return (
      <View accessibilityLabel="Checking camera access" style={styles.loadingScreen}>
        <ActivityIndicator size="large" color="#2563eb" />
        <Text style={styles.loadingText}>Checking camera access…</Text>
      </View>
    );
  }

  if (!permission.granted || cameraError) {
    const firstRequest = permission.status === "undetermined" && !cameraError;
    return (
      <CameraRecovery
        detail={
          cameraError
            ? "The camera could not start on this device. You can try phone settings or choose receipt images instead."
            : firstRequest
              ? "Camera access lets you photograph receipt pages. The app only opens the camera when you choose to take a receipt photo."
              : "Camera access is off. You can allow it in phone settings or choose receipt images from the gallery."
        }
        galleryBusy={galleryBusy}
        onBack={leaveCamera}
        onGallery={() => void chooseFromGallery()}
        onPrimary={
          cameraError
            ? () => {
                setCameraReady(false);
                setCameraError(null);
              }
            : permission.canAskAgain
              ? () => void askForCamera()
              : () => void openSettings()
        }
        primaryBusy={requestBusy}
        primaryLabel={
          cameraError
            ? "Try camera again"
            : permission.canAskAgain
              ? requestBusy
                ? "Requesting access…"
                : firstRequest
                  ? "Allow camera"
                  : "Try camera access again"
              : "Open settings"
        }
        title={
          cameraError
            ? "Camera could not start"
            : firstRequest
              ? "Allow camera access"
              : "Camera access is off"
        }
      />
    );
  }

  return (
    <View style={styles.cameraScreen}>
      <StatusBar hidden />
      <CameraView
        facing="back"
        mode="picture"
        onCameraReady={() => setCameraReady(true)}
        onMountError={(error) => setCameraError(error.message)}
        ratio={Platform.OS === "android" ? "4:3" : undefined}
        ref={cameraRef}
        responsiveOrientationWhenOrientationLocked
        style={StyleSheet.absoluteFill}
      />

      <SafeAreaView pointerEvents="box-none" style={styles.cameraOverlay}>
        <View style={styles.topBar}>
          <Pressable
            accessibilityLabel="Close camera"
            accessibilityRole="button"
            hitSlop={10}
            onPress={leaveCamera}
            style={styles.closeButton}
          >
            <Text style={styles.closeButtonText}>×</Text>
          </Pressable>
          <View style={styles.pageBadge}>
            <Text style={styles.pageBadgeText}>
              {isRetaking
                ? `Retake page ${nextPageNumber}`
                : `Page ${nextPageNumber} of ${MAX_RECEIPT_PAGES}`}
            </Text>
          </View>
          <View style={styles.topSpacer} />
        </View>

        <View pointerEvents="none" style={styles.frameArea}>
          <Text style={styles.frameHint}>Keep the whole receipt inside the frame</Text>
          <View style={styles.receiptFrame} />
        </View>

        <View style={styles.bottomBar}>
          <Pressable
            accessibilityLabel="Choose receipt image from gallery"
            accessibilityRole="button"
            disabled={galleryBusy || captureBusy}
            onPress={() => void chooseFromGallery()}
            style={styles.galleryButton}
          >
            <Text style={styles.galleryButtonText}>{galleryBusy ? "Opening…" : "Gallery"}</Text>
          </Pressable>
          <Pressable
            accessibilityHint={`Takes receipt page ${nextPageNumber}`}
            accessibilityLabel={
              isRetaking ? `Retake page ${nextPageNumber}` : `Take page ${nextPageNumber}`
            }
            accessibilityRole="button"
            disabled={!cameraReady || captureBusy}
            onPress={() => void takePhoto()}
            style={({ pressed }) => [
              styles.shutterOuter,
              pressed && styles.shutterPressed,
              (!cameraReady || captureBusy) && styles.shutterDisabled,
            ]}
          >
            {captureBusy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <View style={styles.shutterInner} />
            )}
          </Pressable>
          <View style={styles.bottomSpacer} />
        </View>
      </SafeAreaView>
    </View>
  );
}

function CameraRecovery({
  title,
  detail,
  primaryLabel,
  primaryBusy,
  galleryBusy,
  onPrimary,
  onGallery,
  onBack,
}: {
  title: string;
  detail: string;
  primaryLabel: string;
  primaryBusy: boolean;
  galleryBusy: boolean;
  onPrimary: () => void;
  onGallery: () => void;
  onBack: () => void;
}) {
  return (
    <SafeAreaView style={styles.recoveryScreen}>
      <View style={styles.recoveryCard}>
        <Text accessibilityRole="header" style={styles.recoveryTitle}>
          {title}
        </Text>
        <Text style={styles.recoveryDetail}>{detail}</Text>
        <Pressable
          accessibilityRole="button"
          disabled={primaryBusy}
          onPress={onPrimary}
          style={styles.recoveryPrimary}
        >
          <Text style={styles.recoveryPrimaryText}>{primaryLabel}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={galleryBusy}
          onPress={onGallery}
          style={styles.recoverySecondary}
        >
          <Text style={styles.recoverySecondaryText}>
            {galleryBusy ? "Opening photos…" : "Choose from gallery"}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onBack} style={styles.backLink}>
          <Text style={styles.backLinkText}>Back to Capture</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingScreen: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    backgroundColor: "#ffffff",
  },
  loadingText: {
    color: "#334155",
    fontSize: 16,
  },
  cameraScreen: {
    flex: 1,
    backgroundColor: "#000000",
  },
  cameraOverlay: {
    flex: 1,
    justifyContent: "space-between",
    backgroundColor: "transparent",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingTop: 8,
  },
  closeButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  closeButtonText: {
    color: "#ffffff",
    fontSize: 34,
    lineHeight: 36,
    fontWeight: "400",
  },
  pageBadge: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 20,
    paddingHorizontal: 16,
    backgroundColor: "rgba(0, 0, 0, 0.62)",
  },
  pageBadgeText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
  topSpacer: {
    width: 48,
  },
  frameArea: {
    flex: 1,
    paddingHorizontal: 28,
    paddingVertical: 24,
    justifyContent: "center",
    gap: 14,
  },
  frameHint: {
    alignSelf: "center",
    color: "#ffffff",
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  receiptFrame: {
    alignSelf: "center",
    width: "88%",
    maxWidth: 420,
    aspectRatio: 0.68,
    borderWidth: 3,
    borderColor: "rgba(255, 255, 255, 0.92)",
    borderRadius: 18,
    backgroundColor: "transparent",
  },
  bottomBar: {
    minHeight: 132,
    paddingHorizontal: 22,
    paddingBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(0, 0, 0, 0.52)",
  },
  galleryButton: {
    width: 84,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 12,
    backgroundColor: "rgba(255, 255, 255, 0.16)",
  },
  galleryButtonText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
  },
  shutterOuter: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 5,
    borderColor: "#ffffff",
    backgroundColor: "rgba(0, 0, 0, 0.3)",
  },
  shutterInner: {
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: "#ffffff",
  },
  shutterPressed: {
    transform: [{ scale: 0.94 }],
  },
  shutterDisabled: {
    opacity: 0.55,
  },
  bottomSpacer: {
    width: 84,
  },
  recoveryScreen: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: "#f6f8fb",
  },
  recoveryCard: {
    padding: 24,
    borderRadius: 20,
    gap: 14,
    backgroundColor: "#ffffff",
    elevation: 3,
  },
  recoveryTitle: {
    color: "#0f172a",
    fontSize: 28,
    lineHeight: 34,
    fontWeight: "800",
  },
  recoveryDetail: {
    color: "#475569",
    fontSize: 16,
    lineHeight: 24,
    marginBottom: 4,
  },
  recoveryPrimary: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    paddingHorizontal: 18,
    backgroundColor: "#2563eb",
  },
  recoveryPrimaryText: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "800",
  },
  recoverySecondary: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#94a3b8",
    paddingHorizontal: 18,
  },
  recoverySecondaryText: {
    color: "#0f172a",
    fontSize: 16,
    fontWeight: "700",
  },
  backLink: {
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  backLinkText: {
    color: "#475569",
    fontSize: 15,
    fontWeight: "700",
  },
});
