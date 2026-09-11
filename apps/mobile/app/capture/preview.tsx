import { MAX_RECEIPT_PAGES } from "@svl/domain";
import { type Href, Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ZoomableReceiptImage } from "@/components/capture/ZoomableReceiptImage";
import { Text, useThemeColor, View } from "@/components/Themed";
import { chooseReceiptPagesFromGallery } from "@/lib/capture/gallery";
import {
  receiptPreparationMessage,
  rotateReceiptPageClockwise,
} from "@/lib/capture/image-preparation";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

export default function ReceiptPreviewScreen() {
  const router = useRouter();
  const { height } = useWindowDimensions();
  const {
    state,
    addPages,
    beginRetake,
    cancelRetake,
    confirmPages,
    replacePage,
    removePage,
    canEditPages,
  } = useReceiptCapture();
  const [activeIndex, setActiveIndex] = useState(state.previewIndex);
  const [galleryBusy, setGalleryBusy] = useState(false);
  const [rotatingIndex, setRotatingIndex] = useState<number | null>(null);
  const [rotationFeedback, setRotationFeedback] = useState<{
    kind: "error" | "success";
    message: string;
  } | null>(null);
  const backgroundColor = useThemeColor({ light: "#f6f7f2", dark: "#080b10" }, "background");
  const selectedPageColor = useThemeColor({ light: "#edf1e5", dark: "#14263d" }, "background");

  useEffect(() => {
    setActiveIndex(Math.min(state.previewIndex, Math.max(0, state.pages.length - 1)));
  }, [state.pages.length, state.previewIndex]);

  if (state.pages.length === 0) {
    return <Redirect href={"/(tabs)" as Href} />;
  }

  const activePage = state.pages[activeIndex] ?? state.pages[0];
  const atPageCap = state.pages.length >= MAX_RECEIPT_PAGES;
  const rotationBusy = rotatingIndex !== null;
  const interactionBusy = galleryBusy || rotationBusy;
  const nextRequiredRetakeIndex = state.requiredRetakeIndexes[0];
  const hasRequiredRetakes = nextRequiredRetakeIndex !== undefined;

  function addAnotherPage() {
    cancelRetake();
    router.push("/capture/camera" as Href);
  }

  function retakeActivePage() {
    beginRetake(activeIndex);
    router.push("/capture/camera" as Href);
  }

  async function addFromGallery() {
    const remaining = MAX_RECEIPT_PAGES - state.pages.length;
    if (remaining < 1) {
      return;
    }

    setGalleryBusy(true);
    try {
      const pages = await chooseReceiptPagesFromGallery(remaining);
      if (pages?.length) {
        addPages(pages);
      }
    } catch (error) {
      Alert.alert("Photo needs another try", receiptPreparationMessage(error));
    } finally {
      setGalleryBusy(false);
    }
  }

  async function rotateActivePage() {
    if (interactionBusy) {
      return;
    }

    const pageIndex = activeIndex;
    const page = activePage;
    setRotatingIndex(pageIndex);
    setRotationFeedback(null);
    try {
      const rotated = await rotateReceiptPageClockwise(page);
      replacePage(pageIndex, rotated);
      setRotationFeedback({
        kind: "success",
        message: `Page ${pageIndex + 1} rotated clockwise. Review it before continuing.`,
      });
    } catch (error) {
      setRotationFeedback({
        kind: "error",
        message: receiptPreparationMessage(error),
      });
    } finally {
      setRotatingIndex(null);
    }
  }

  function usePhotos() {
    if (hasRequiredRetakes) {
      Alert.alert(
        "More retakes are required",
        `Replace ${state.requiredRetakeIndexes.length === 1 ? "the remaining page" : `all ${state.requiredRetakeIndexes.length} remaining pages`} before sending this receipt again.`,
      );
      return;
    }
    confirmPages();
    router.replace("/capture/location" as Href);
  }

  function continueRequiredRetakes() {
    if (nextRequiredRetakeIndex === undefined) {
      return;
    }
    beginRetake(nextRequiredRetakeIndex);
    router.push("/capture/camera" as Href);
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Pressable
            accessibilityLabel="Back to Capture"
            accessibilityRole="button"
            accessibilityState={{ disabled: interactionBusy }}
            disabled={interactionBusy}
            hitSlop={8}
            onPress={() => router.replace("/(tabs)" as Href)}
            style={[styles.backButton, interactionBusy && styles.disabled]}
          >
            <Text style={styles.backButtonText}>‹</Text>
          </Pressable>
          <View style={styles.headerText}>
            <Text accessibilityRole="header" style={styles.title}>
              Review receipt
            </Text>
            <Text style={styles.subtitle}>
              Page {activeIndex + 1} of {state.pages.length}
            </Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        {canEditPages ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove page ${activeIndex + 1}`}
            accessibilityHint="Removes this photo from the receipt before it is sent"
            disabled={interactionBusy}
            onPress={() => {
              setRotationFeedback(null);
              removePage(activeIndex);
            }}
            style={[styles.removePageButton, interactionBusy && styles.disabled]}
          >
            <Text style={styles.removePageText}>× Remove page</Text>
          </Pressable>
        ) : null}

        <View
          style={[styles.previewPanel, { height: Math.max(360, Math.min(520, height * 0.48)) }]}
        >
          <ZoomableReceiptImage
            key={activePage.uri}
            pageNumber={activeIndex + 1}
            uri={activePage.uri}
          />
        </View>

        {hasRequiredRetakes ? (
          <View lightColor="#fff7ed" darkColor="#2b1708" style={styles.requiredRetakeCard}>
            <Text style={styles.qualityTitle}>Cloud retakes still required</Text>
            <Text style={styles.qualityBody}>
              Replace page{state.requiredRetakeIndexes.length === 1 ? "" : "s"}{" "}
              {state.requiredRetakeIndexes.map((index) => index + 1).join(", ")} before sending
              again. Pages that already passed remain unchanged.
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={interactionBusy}
              onPress={continueRequiredRetakes}
              style={[styles.requiredRetakeButton, interactionBusy && styles.disabled]}
            >
              <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.useButtonText}>
                Retake page {nextRequiredRetakeIndex + 1}
              </Text>
            </Pressable>
          </View>
        ) : null}

        <View
          accessibilityLabel={`Local photo check for page ${activeIndex + 1}`}
          lightColor={activePage.quality.hints.length > 0 ? "#fff7ed" : "#ecfdf5"}
          darkColor={activePage.quality.hints.length > 0 ? "#3b2414" : "#123225"}
          style={styles.qualityCard}
        >
          <Text style={styles.qualityTitle}>Local photo check</Text>
          {activePage.quality.status === "unavailable" ? (
            <Text style={styles.qualityBody}>
              Automatic hints were unavailable for this page. You can retake it or continue to the
              cloud readability check.
            </Text>
          ) : activePage.quality.hints.length === 0 ? (
            <Text style={styles.qualityBody}>
              No obvious blur, lighting, glare, framing, or resolution problem was found.
            </Text>
          ) : (
            activePage.quality.hints.map((hint) => (
              <View key={hint.code} style={styles.hintBlock}>
                <Text style={styles.hintTitle}>{hint.title}</Text>
                <Text style={styles.qualityBody}>{hint.guidance}</Text>
              </View>
            ))
          )}
          <Text style={styles.advisoryText}>
            This device check is advisory. You may continue; the cloud check makes the readability
            decision.
          </Text>
        </View>

        <View style={styles.pageStripBlock}>
          <Text style={styles.sectionTitle}>All pages</Text>
          <ScrollView
            accessibilityLabel="Receipt pages"
            contentContainerStyle={styles.pageStrip}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {state.pages.map((page, index) => {
              const selected = index === activeIndex;
              return (
                <Pressable
                  accessibilityLabel={`View receipt page ${index + 1}, ${page.quality.hints.length} local ${page.quality.hints.length === 1 ? "hint" : "hints"}`}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: interactionBusy, selected }}
                  disabled={interactionBusy}
                  key={page.uri}
                  onPress={() => {
                    setRotationFeedback(null);
                    setActiveIndex(index);
                  }}
                  style={[
                    styles.thumbnailButton,
                    selected && styles.thumbnailButtonSelected,
                    selected && { backgroundColor: selectedPageColor },
                    interactionBusy && styles.disabled,
                  ]}
                >
                  <Image resizeMode="cover" source={{ uri: page.uri }} style={styles.thumbnail} />
                  <Text style={styles.thumbnailLabel}>Page {index + 1}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        <View style={styles.actions}>
          <Pressable
            accessibilityHint={`Turns only page ${activeIndex + 1} 90 degrees to the right`}
            accessibilityLabel={`Rotate page ${activeIndex + 1} clockwise`}
            accessibilityRole="button"
            disabled={interactionBusy}
            onPress={() => void rotateActivePage()}
            style={[styles.rotateButton, interactionBusy && styles.disabled]}
          >
            {rotationBusy ? (
              <View style={styles.buttonContent}>
                <ActivityIndicator color="#315b49" />
                <Text accessibilityLiveRegion="polite" style={styles.rotateButtonText}>
                  Rotating page {Number(rotatingIndex) + 1}…
                </Text>
              </View>
            ) : (
              <Text style={styles.rotateButtonText}>Rotate clockwise</Text>
            )}
          </Pressable>

          {rotationFeedback ? (
            <Text
              accessibilityLiveRegion={rotationFeedback.kind === "error" ? "assertive" : "polite"}
              darkColor={rotationFeedback.kind === "error" ? "#fca5a5" : "#86efac"}
              lightColor={rotationFeedback.kind === "error" ? "#dc2626" : "#15803d"}
              style={
                rotationFeedback.kind === "error"
                  ? styles.rotationErrorText
                  : styles.rotationSuccessText
              }
            >
              {rotationFeedback.message}
            </Text>
          ) : null}

          <Pressable
            accessibilityHint={`Replaces only page ${activeIndex + 1}`}
            accessibilityRole="button"
            disabled={interactionBusy}
            onPress={retakeActivePage}
            style={[styles.retakeButton, interactionBusy && styles.disabled]}
          >
            <Text style={styles.retakeButtonText}>Retake this page</Text>
          </Pressable>

          {atPageCap ? (
            <View lightColor="#edf1e5" darkColor="#1f2937" style={styles.capNotice}>
              <Text style={styles.capNoticeText}>
                {MAX_RECEIPT_PAGES}-page limit reached. Retake any page that needs replacing.
              </Text>
            </View>
          ) : (
            <View style={styles.addActions}>
              <Pressable
                accessibilityRole="button"
                disabled={interactionBusy}
                onPress={addAnotherPage}
                style={[styles.addButton, interactionBusy && styles.disabled]}
              >
                <Text style={styles.addButtonText}>Add another page</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={interactionBusy}
                onPress={() => void addFromGallery()}
                style={[styles.galleryButton, interactionBusy && styles.disabled]}
              >
                <Text style={styles.galleryButtonText}>
                  {galleryBusy ? "Opening photos…" : "Add from gallery"}
                </Text>
              </Pressable>
            </View>
          )}

          <Pressable
            accessibilityHint={`Keeps all ${state.pages.length} receipt ${state.pages.length === 1 ? "page" : "pages"}`}
            accessibilityRole="button"
            disabled={interactionBusy || hasRequiredRetakes}
            onPress={usePhotos}
            style={[styles.useButton, (interactionBusy || hasRequiredRetakes) && styles.disabled]}
          >
            <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.useButtonText}>
              Use {state.pages.length === 1 ? "photo" : `${state.pages.length} photos`}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: 18,
    paddingBottom: 32,
    gap: 16,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  backButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 24,
    backgroundColor: "#edf1e5",
  },
  backButtonText: {
    color: "#253c35",
    fontSize: 38,
    lineHeight: 40,
  },
  headerText: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    backgroundColor: "transparent",
  },
  title: {
    fontSize: 24,
    fontWeight: "800",
  },
  subtitle: {
    color: "#737d70",
    fontSize: 14,
  },
  headerSpacer: {
    width: 48,
    backgroundColor: "transparent",
  },
  previewPanel: {
    backgroundColor: "transparent",
  },
  removePageButton: {
    alignSelf: "flex-end",
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 10,
    justifyContent: "center",
    backgroundColor: "#fffefb",
    borderColor: "#ded7ce",
    borderWidth: 1,
    elevation: 3,
  },
  removePageText: { color: "#a43d35", fontSize: 14, fontWeight: "700" },
  qualityCard: {
    gap: 9,
    borderRadius: 14,
    padding: 15,
  },
  requiredRetakeCard: {
    gap: 10,
    borderRadius: 14,
    padding: 15,
  },
  requiredRetakeButton: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    paddingHorizontal: 18,
    backgroundColor: "#ea580c",
  },
  qualityTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  qualityBody: {
    fontSize: 14,
    lineHeight: 20,
    opacity: 0.8,
  },
  hintBlock: {
    gap: 2,
    backgroundColor: "transparent",
  },
  hintTitle: {
    color: "#c2410c",
    fontSize: 15,
    fontWeight: "800",
  },
  advisoryText: {
    marginTop: 2,
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "700",
    opacity: 0.68,
  },
  pageStripBlock: {
    gap: 8,
    backgroundColor: "transparent",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "800",
  },
  pageStrip: {
    gap: 10,
    paddingVertical: 2,
  },
  thumbnailButton: {
    width: 78,
    padding: 4,
    gap: 4,
    borderWidth: 2,
    borderColor: "transparent",
    borderRadius: 12,
    alignItems: "center",
  },
  thumbnailButtonSelected: {
    borderColor: "#315b49",
  },
  thumbnail: {
    width: 66,
    height: 72,
    borderRadius: 8,
    backgroundColor: "#d8dfd1",
  },
  thumbnailLabel: {
    fontSize: 12,
    fontWeight: "700",
  },
  actions: {
    gap: 12,
    backgroundColor: "transparent",
  },
  rotateButton: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#315b49",
    paddingHorizontal: 18,
  },
  buttonContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "transparent",
  },
  rotateButtonText: {
    color: "#315b49",
    fontSize: 16,
    fontWeight: "800",
  },
  rotationErrorText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
  },
  rotationSuccessText: {
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
  },
  retakeButton: {
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#dc2626",
    paddingHorizontal: 18,
  },
  retakeButtonText: {
    color: "#dc2626",
    fontSize: 16,
    fontWeight: "800",
  },
  addActions: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: "transparent",
  },
  addButton: {
    flex: 1,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    backgroundColor: "#edf1e5",
    paddingHorizontal: 12,
  },
  addButtonText: {
    color: "#253c35",
    fontSize: 15,
    fontWeight: "800",
    textAlign: "center",
  },
  galleryButton: {
    flex: 1,
    minHeight: 50,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
    borderWidth: 1.5,
    borderColor: "#a4ae9b",
    paddingHorizontal: 12,
  },
  galleryButtonText: {
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
  },
  capNotice: {
    borderRadius: 12,
    padding: 14,
  },
  capNoticeText: {
    color: "#737d70",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  useButton: {
    minHeight: 58,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingHorizontal: 18,
    backgroundColor: "#315b49",
  },
  useButtonText: {
    fontSize: 18,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.5,
  },
});
