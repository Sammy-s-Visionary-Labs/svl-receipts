import {
  isReceiptStatus,
  WORKER_FACING_LABELS,
  workerStatusFromDeviceQueue,
  workerStatusFromReceipt,
} from "@svl/domain";
import { type Href, Redirect, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, useThemeColor, View } from "@/components/Themed";
import { ApiError, fetchReceiptReadability, type ReceiptReadabilityStatus } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ReceiptReadyScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const {
    state,
    submission,
    submitReceipt,
    cancelSubmission,
    startNewReceipt,
    beginRequiredRetakes,
    removePage,
    canEditPages,
  } = useReceiptCapture();
  const backgroundColor = useThemeColor({ light: "#f6f7f2", dark: "#080b10" }, "background");
  const isBusy = ["preparing", "creating_session", "uploading", "confirming"].includes(
    submission.phase,
  );
  const isSent = submission.phase === "sent" && submission.confirmation !== null;
  const [cloudStatus, setCloudStatus] = useState<ReceiptReadabilityStatus | null>(null);
  const [cloudErrorMessage, setCloudErrorMessage] = useState<string | null>(null);
  const needsRetake =
    cloudStatus?.status === "rejected_unreadable" || cloudStatus?.readability?.readable === false;
  const retakePageIndexes = [
    ...new Set(
      cloudStatus?.readability?.failedPageIndexes.filter(
        (index) => index >= 0 && index < state.pages.length,
      ) ?? [],
    ),
  ];
  const workerStatus = needsRetake
    ? "needs_retake"
    : cloudStatus?.status && isReceiptStatus(cloudStatus.status)
      ? workerStatusFromReceipt(cloudStatus.status)
      : workerStatusFromDeviceQueue(submission.deviceStatus);

  useEffect(() => {
    const receiptId = submission.confirmation?.id;
    const accessToken = session?.access_token;
    if (!isSent || !receiptId || !accessToken) {
      setCloudStatus(null);
      setCloudErrorMessage(null);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pollCount = 0;
    const refresh = async () => {
      pollCount += 1;
      let next: ReceiptReadabilityStatus;
      try {
        next = await fetchReceiptReadability(accessToken, receiptId);
      } catch (error) {
        if (!active) {
          return;
        }
        const terminalApiError =
          error instanceof ApiError && [401, 403, 404].includes(error.status);
        if (terminalApiError) {
          setCloudErrorMessage(
            error.status === 401
              ? "Your session ended before the cloud result could be loaded. Sign in again and open Recent."
              : "This receipt result is unavailable. Open Recent after checking your account access.",
          );
          return;
        }
        if (pollCount >= 40) {
          setCloudErrorMessage(
            "The cloud check is taking longer than expected. You can leave this screen and check Recent later.",
          );
          return;
        }
        timer = setTimeout(() => void refresh(), 3_000);
        return;
      }
      if (!active) {
        return;
      }
      setCloudStatus(next);
      setCloudErrorMessage(null);
      const isFinal =
        next.readability !== null
          ? true
          : next.status === "failed" || next.status === "rejected_unreadable";
      if (!isFinal && pollCount < 40) {
        timer = setTimeout(() => void refresh(), 3_000);
      } else if (!isFinal) {
        setCloudErrorMessage(
          "The cloud check is taking longer than expected. You can leave this screen and check Recent later.",
        );
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isSent, session?.access_token, submission.confirmation?.id]);

  if (state.pages.length === 0) {
    return <Redirect href={"/(tabs)" as Href} />;
  }

  if (!state.confirmed) {
    return <Redirect href={"/capture/preview" as Href} />;
  }

  if (state.locationDecision === "undecided") {
    return <Redirect href={"/capture/location" as Href} />;
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={[styles.checkmark, needsRetake && styles.retakeIcon]}>
          <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.checkmarkText}>
            {needsRetake ? "!" : "✓"}
          </Text>
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          {needsRetake
            ? "Receipt needs a retake"
            : isSent
              ? "Receipt sent"
              : "Receipt photos ready"}
        </Text>
        <Text style={styles.body}>
          {needsRetake
            ? "The upload was received safely, but one or more photos cannot be read reliably."
            : isSent && submission.confirmation
              ? `Receipt •••${receiptSuffix(submission.confirmation.id)} was confirmed at ${formatConfirmationTime(submission.confirmation.submittedAt)}.`
              : `${state.pages.length} ${state.pages.length === 1 ? "page is" : "pages are"} ready to send. Sent appears only after the server verifies the full set.`}
        </Text>

        <View lightColor="#ffffff" darkColor="#121821" style={styles.statusCard}>
          <View style={styles.statusHeading}>
            <Text style={styles.cardTitle}>Submission</Text>
            <View style={styles.statusChip}>
              <Text lightColor="#315b49" darkColor="#bfdbfe" style={styles.statusChipText}>
                {WORKER_FACING_LABELS[workerStatus]}
              </Text>
            </View>
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.locationBody}>
            {submissionStatusText(
              submission.phase,
              submission.currentPageIndex,
              state.pages.length,
            )}
          </Text>
          {submission.errorMessage ? (
            <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
              {submission.errorMessage}
            </Text>
          ) : null}
        </View>

        {cloudErrorMessage ? (
          <View lightColor="#fff7ed" darkColor="#2b1708" style={styles.statusCard}>
            <Text accessibilityLiveRegion="polite" style={styles.locationBody}>
              {cloudErrorMessage}
            </Text>
          </View>
        ) : null}

        {needsRetake && cloudStatus.readability ? (
          <View lightColor="#fff7ed" darkColor="#2b1708" style={styles.statusCard}>
            <Text style={styles.cardTitle}>What to fix</Text>
            {cloudStatus.readability.reasons.map((reason) => (
              <Text key={reason.code} style={styles.locationBody}>
                • {reason.guidance}
              </Text>
            ))}
            {cloudStatus.readability.failedPageIndexes.length > 0 ? (
              <Text style={styles.locationBody}>
                Retake{" "}
                {cloudStatus.readability.failedPageIndexes
                  .map((index) => `page ${index + 1}`)
                  .join(", ")}
                .
              </Text>
            ) : null}
          </View>
        ) : null}

        <View lightColor="#ffffff" darkColor="#121821" style={styles.photoCard}>
          <Text style={styles.cardTitle}>Selected pages</Text>
          <ScrollView
            accessibilityLabel="Selected receipt pages"
            contentContainerStyle={styles.thumbnails}
            horizontal
            showsHorizontalScrollIndicator={false}
          >
            {state.pages.map((page, index) => (
              <View key={page.uri} style={styles.thumbnailBlock}>
                <Image
                  accessibilityLabel={`Receipt page ${index + 1}`}
                  resizeMode="cover"
                  source={{ uri: page.uri }}
                  style={styles.thumbnail}
                />
                <Text style={styles.thumbnailLabel}>Page {index + 1}</Text>
                {canEditPages ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove page ${index + 1}`}
                    onPress={() => removePage(index)}
                    style={styles.removePageButton}
                  >
                    <Text style={styles.removePageText}>× Remove</Text>
                  </Pressable>
                ) : null}
                <Text style={styles.metadataText}>
                  {page.imageMetadata.finalWidth} × {page.imageMetadata.finalHeight}
                </Text>
                <Text style={styles.metadataText}>
                  {formatBytes(page.imageMetadata.finalBytes)} JPEG
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>

        <View lightColor="#ffffff" darkColor="#121821" style={styles.locationCard}>
          <Text style={styles.cardTitle}>Location</Text>
          <Text style={styles.locationBody}>
            {state.locationDecision === "included"
              ? state.location.accuracyMeters === null
                ? "One current location sample was added; accuracy was not reported."
                : `One current location sample was added with about ${Math.round(state.location.accuracyMeters)} meter accuracy.`
              : "No location was added. This does not block the receipt."}
          </Text>
        </View>

        {submission.phase === "idle" ? (
          <Pressable
            accessibilityRole="button"
            disabled={isBusy}
            onPress={() => router.replace("/capture/preview" as Href)}
            style={[styles.reviewButton, isBusy && styles.disabled]}
          >
            <Text style={styles.reviewButtonText}>Review photos again</Text>
          </Pressable>
        ) : null}

        {submission.phase === "failed" || submission.phase === "cancelled" ? (
          <Pressable
            accessibilityHint="Leaves the protected receipt in the queue for automatic retry"
            accessibilityRole="button"
            onPress={() => {
              startNewReceipt();
              router.replace("/(tabs)" as Href);
            }}
            style={styles.reviewButton}
          >
            <Text style={styles.reviewButtonText}>Keep queued and finish</Text>
          </Pressable>
        ) : null}

        {isBusy ? (
          <Pressable
            accessibilityHint="Stops the active transfer but keeps every receipt photo"
            accessibilityRole="button"
            onPress={cancelSubmission}
            style={styles.reviewButton}
          >
            <Text style={styles.reviewButtonText}>Pause upload</Text>
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              if (isSent) {
                if (needsRetake) {
                  if (retakePageIndexes.length > 0) {
                    beginRequiredRetakes(retakePageIndexes);
                    router.replace("/capture/camera" as Href);
                    return;
                  }
                  startNewReceipt();
                  router.replace("/capture/camera" as Href);
                  return;
                }
                router.replace("/(tabs)/recent" as Href);
                return;
              }
              if (session?.access_token) {
                void submitReceipt(session.access_token);
              }
            }}
            style={[styles.doneButton, !isSent && !session?.access_token && styles.disabled]}
          >
            <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.doneButtonText}>
              {isSent
                ? needsRetake
                  ? retakePageIndexes.length === 1
                    ? `Retake page ${Number(retakePageIndexes[0]) + 1}`
                    : retakePageIndexes.length > 1
                      ? `Retake ${retakePageIndexes.length} pages`
                      : "Retake receipt"
                  : "Done"
                : submission.phase === "failed" || submission.phase === "cancelled"
                  ? "Retry sending"
                  : "Send receipt"}
            </Text>
          </Pressable>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  removePageButton: {
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ded7ce",
    borderRadius: 8,
  },
  removePageText: { color: "#a43d35", fontSize: 13, fontWeight: "700" },
  safeArea: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    padding: 24,
    gap: 16,
  },
  checkmark: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: "#16a34a",
  },
  checkmarkText: {
    fontSize: 40,
    lineHeight: 44,
    fontWeight: "800",
  },
  retakeIcon: {
    backgroundColor: "#ea580c",
  },
  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "800",
    textAlign: "center",
  },
  body: {
    color: "#737d70",
    fontSize: 16,
    lineHeight: 24,
    textAlign: "center",
  },
  photoCard: {
    marginVertical: 8,
    padding: 18,
    gap: 12,
    borderRadius: 18,
    elevation: 3,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: "800",
  },
  thumbnails: {
    gap: 12,
  },
  thumbnailBlock: {
    gap: 5,
    alignItems: "center",
    backgroundColor: "transparent",
    width: 112,
  },
  thumbnail: {
    width: 90,
    height: 112,
    borderRadius: 10,
    backgroundColor: "#d8dfd1",
  },
  thumbnailLabel: {
    fontSize: 13,
    fontWeight: "700",
  },
  metadataText: {
    fontSize: 11,
    textAlign: "center",
    opacity: 0.68,
  },
  locationCard: {
    padding: 18,
    gap: 6,
    borderRadius: 18,
    elevation: 2,
  },
  statusCard: {
    padding: 18,
    gap: 8,
    borderRadius: 18,
    elevation: 2,
  },
  statusHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: "transparent",
  },
  statusChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "#e3e8ca",
  },
  statusChipText: {
    fontSize: 13,
    fontWeight: "800",
  },
  errorText: {
    color: "#b91c1c",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
  },
  locationBody: {
    fontSize: 14,
    lineHeight: 20,
    opacity: 0.76,
  },
  reviewButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#a4ae9b",
    borderRadius: 14,
    paddingHorizontal: 18,
  },
  reviewButtonText: {
    fontSize: 16,
    fontWeight: "700",
  },
  doneButton: {
    minHeight: 56,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingHorizontal: 18,
    backgroundColor: "#315b49",
  },
  doneButtonText: {
    fontSize: 18,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.5,
  },
});

function receiptSuffix(receiptId: string): string {
  return receiptId.replace(/-/g, "").slice(-6).toUpperCase();
}

function formatConfirmationTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function submissionStatusText(
  phase: ReturnType<typeof useReceiptCapture>["submission"]["phase"],
  currentPageIndex: number | null,
  pageCount: number,
): string {
  switch (phase) {
    case "idle":
      return "Pending on this device. Tap Send receipt when ready.";
    case "preparing":
      return "Calculating a secure checksum for every page before transfer.";
    case "creating_session":
      return "Creating constrained signed upload targets.";
    case "uploading":
      return currentPageIndex === null
        ? "Uploading receipt pages."
        : `Uploading page ${currentPageIndex + 1} of ${pageCount}.`;
    case "confirming":
      return "Waiting for the server to verify every page and checksum.";
    case "cancelled":
      return "Upload paused. The protected receipt remains queued for automatic retry.";
    case "failed":
      return "Not Sent yet. The receipt is queued for automatic retry, or you can retry now.";
    case "sent":
      return "The server durably confirmed the complete receipt page set.";
  }
}
