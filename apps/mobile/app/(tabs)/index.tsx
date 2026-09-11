import { MAX_RECEIPT_PAGES } from "@svl/domain";
import { type Href, useRouter } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet } from "react-native";
import { Text, useThemeColor, View } from "@/components/Themed";
import { chooseReceiptPagesFromGallery } from "@/lib/capture/gallery";
import { receiptPreparationMessage } from "@/lib/capture/image-preparation";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

export default function CaptureScreen() {
  const router = useRouter();
  const { state, startNewReceipt, addPages } = useReceiptCapture();
  const [galleryBusy, setGalleryBusy] = useState(false);
  const backgroundColor = useThemeColor({ light: "#f6f7f2", dark: "#080b10" }, "background");

  function startCamera() {
    startNewReceipt();
    router.push("/capture/camera" as Href);
  }

  async function chooseFromGallery() {
    setGalleryBusy(true);
    try {
      const pages = await chooseReceiptPagesFromGallery(MAX_RECEIPT_PAGES);
      if (!pages?.length) {
        return;
      }
      startNewReceipt();
      addPages(pages);
      router.push("/capture/preview" as Href);
    } catch (error) {
      Alert.alert("Photo needs another try", receiptPreparationMessage(error));
    } finally {
      setGalleryBusy(false);
    }
  }

  const hasReceipt = state.pages.length > 0;

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={[styles.container, { backgroundColor }]}
    >
      <View lightColor="#f6f7f2" darkColor="#080b10" style={styles.headingBlock}>
        <Text style={styles.eyebrow}>NEW RECEIPT</Text>
        <Text accessibilityRole="header" style={styles.title}>
          Take receipt photo
        </Text>
        <Text style={styles.body}>
          Place the full receipt in the frame. You can add up to {MAX_RECEIPT_PAGES} pages and
          review each one before continuing.
        </Text>
      </View>

      {hasReceipt ? (
        <View lightColor="#edf1e5" darkColor="#14263d" style={styles.resumeCard}>
          <Text style={styles.resumeTitle}>
            {state.confirmed ? "Receipt photos ready" : "Receipt in progress"}
          </Text>
          <Text style={styles.resumeBody}>
            {state.pages.length} {state.pages.length === 1 ? "page" : "pages"} selected
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push((state.confirmed ? "/capture/ready" : "/capture/preview") as Href)
            }
            style={styles.resumeButton}
          >
            <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.resumeButtonText}>
              {state.confirmed ? "View selected photos" : "Continue reviewing"}
            </Text>
          </Pressable>
        </View>
      ) : null}

      <View lightColor="#ffffff" darkColor="#121821" style={styles.actionCard}>
        <Text style={styles.guidanceTitle}>Before you take the photo</Text>
        <Text style={styles.guidance}>• Lay the receipt flat in good light.</Text>
        <Text style={styles.guidance}>• Keep every edge and all printed details visible.</Text>
        <Text style={styles.guidance}>• Use Add another page for long or multi-page receipts.</Text>

        <Pressable
          accessibilityHint="Opens the camera after explaining camera access"
          accessibilityRole="button"
          onPress={startCamera}
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
        >
          <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.primaryButtonText}>
            Take receipt photo
          </Text>
        </Pressable>

        <Pressable
          accessibilityHint={`Choose up to ${MAX_RECEIPT_PAGES} receipt images`}
          accessibilityRole="button"
          disabled={galleryBusy}
          onPress={() => void chooseFromGallery()}
          style={({ pressed }) => [
            styles.secondaryButton,
            pressed && styles.pressed,
            galleryBusy && styles.disabled,
          ]}
        >
          <Text style={styles.secondaryButtonText}>
            {galleryBusy ? "Opening photos…" : "Choose from gallery"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 24,
    paddingBottom: 40,
    gap: 20,
  },
  headingBlock: {
    gap: 8,
  },
  eyebrow: {
    color: "#315b49",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.2,
  },
  title: {
    fontSize: 32,
    lineHeight: 38,
    fontWeight: "800",
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    opacity: 0.72,
  },
  resumeCard: {
    borderRadius: 16,
    padding: 18,
    gap: 6,
  },
  resumeTitle: {
    fontSize: 18,
    fontWeight: "800",
  },
  resumeBody: {
    fontSize: 15,
    opacity: 0.72,
  },
  resumeButton: {
    alignSelf: "flex-start",
    marginTop: 8,
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 18,
    borderRadius: 12,
    backgroundColor: "#315b49",
  },
  resumeButtonText: {
    fontSize: 15,
    fontWeight: "800",
  },
  actionCard: {
    borderRadius: 20,
    padding: 20,
    gap: 12,
    elevation: 3,
  },
  guidanceTitle: {
    fontSize: 18,
    fontWeight: "800",
    marginBottom: 2,
  },
  guidance: {
    fontSize: 15,
    lineHeight: 21,
    opacity: 0.72,
  },
  primaryButton: {
    minHeight: 60,
    marginTop: 10,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
    backgroundColor: "#315b49",
  },
  primaryButtonText: {
    fontSize: 18,
    fontWeight: "800",
  },
  secondaryButton: {
    minHeight: 52,
    borderWidth: 1.5,
    borderColor: "#a4ae9b",
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "700",
  },
  pressed: {
    opacity: 0.78,
  },
  disabled: {
    opacity: 0.5,
  },
});
