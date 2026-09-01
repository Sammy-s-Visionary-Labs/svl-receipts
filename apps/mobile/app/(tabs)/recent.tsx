import {
  isReceiptStatus,
  WORKER_FACING_LABELS,
  type WorkerFacingStatus,
  workerStatusFromReceipt,
} from "@svl/domain";
import { type Href, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
} from "react-native";
import { Text, useThemeColor, View } from "@/components/Themed";
import { fetchRecentReceipts, type RecentReceipt } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { planCloudRetake } from "@/lib/capture/cloud-retake";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

export default function RecentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ receiptId?: string | string[] }>();
  const highlightedReceiptId = Array.isArray(params.receiptId)
    ? params.receiptId[0]
    : params.receiptId;
  const { session } = useAuth();
  const { state, submission, beginRequiredRetakes, startNewReceipt } = useReceiptCapture();
  const [receipts, setReceipts] = useState<RecentReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const backgroundColor = useThemeColor({ light: "#f6f8fb", dark: "#080b10" }, "background");

  const loadReceipts = useCallback(
    async (showRefresh: boolean) => {
      const requestGeneration = requestGenerationRef.current + 1;
      requestGenerationRef.current = requestGeneration;
      const accessToken = session?.access_token;
      if (!accessToken) {
        setLoading(false);
        return;
      }
      if (showRefresh) {
        setRefreshing(true);
      }
      try {
        const nextReceipts = await fetchRecentReceipts(accessToken);
        if (requestGenerationRef.current !== requestGeneration) {
          return;
        }
        setReceipts(nextReceipts);
        setErrorMessage(null);
      } catch {
        if (requestGenerationRef.current !== requestGeneration) {
          return;
        }
        setErrorMessage("Recent receipts could not be loaded. Check the connection and try again.");
      } finally {
        if (requestGenerationRef.current === requestGeneration) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [session?.access_token],
  );

  useFocusEffect(
    useCallback(() => {
      void loadReceipts(false);
      return () => {
        requestGenerationRef.current += 1;
      };
    }, [loadReceipts]),
  );

  function startRetake(receipt: RecentReceipt) {
    const plan = planCloudRetake({
      receiptId: receipt.id,
      currentReceiptId: submission.confirmation?.id ?? null,
      pageCount: state.pages.length,
      failedPageIndexes: receipt.readability?.failedPageIndexes ?? [],
      hasUnsentDraft: state.pages.length > 0 && submission.phase !== "sent",
    });
    const proceed = () => {
      if (plan.kind === "replace_pages") {
        beginRequiredRetakes(plan.indexes);
      } else {
        startNewReceipt();
      }
      router.push("/capture/camera" as Href);
    };
    if (!plan.warnBeforeReplacingDraft) {
      proceed();
      return;
    }
    Alert.alert(
      "Replace the receipt in progress?",
      "Starting this older retake will close the receipt currently on screen. A receipt already in the protected retry queue will stay queued.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Start retake", style: "destructive", onPress: proceed },
      ],
    );
  }

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          onRefresh={() => void loadReceipts(true)}
          refreshing={refreshing}
          tintColor="#2563eb"
        />
      }
      style={[styles.container, { backgroundColor }]}
    >
      <View lightColor="#f6f8fb" darkColor="#080b10" style={styles.headingBlock}>
        <Text accessibilityRole="header" style={styles.title}>
          My recent uploads
        </Text>
        <Text style={styles.body}>
          Cloud results stay here even if the app was closed when a receipt finished checking.
        </Text>
      </View>

      {errorMessage ? (
        <View lightColor="#fef2f2" darkColor="#351313" style={styles.messageCard}>
          <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
            {errorMessage}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadReceipts(true)}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : null}

      {loading ? (
        <View
          accessibilityLabel="Loading recent receipts"
          lightColor="#ffffff"
          darkColor="#121821"
          style={styles.loadingCard}
        >
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.body}>Loading recent receipts…</Text>
        </View>
      ) : receipts.length === 0 && !errorMessage ? (
        <View lightColor="#ffffff" darkColor="#121821" style={styles.messageCard}>
          <Text style={styles.cardTitle}>No uploads yet</Text>
          <Text style={styles.body}>Receipts you send will appear here.</Text>
        </View>
      ) : (
        receipts.map((receipt) => {
          const workerStatus = receiptStatusForDisplay(receipt);
          const isHighlighted = receipt.id === highlightedReceiptId;
          const needsRetake = workerStatus === "needs_retake";
          const currentFailedPages = receipt.readability?.failedPageIndexes.filter(
            (index) =>
              submission.confirmation?.id === receipt.id &&
              index >= 0 &&
              index < state.pages.length,
          );
          return (
            <View
              accessibilityLabel={isHighlighted ? "Receipt opened from notification" : undefined}
              key={receipt.id}
              lightColor="#ffffff"
              darkColor="#121821"
              style={[styles.receiptCard, isHighlighted && styles.highlightedCard]}
            >
              <View style={styles.cardHeading}>
                <View style={styles.transparent}>
                  <Text style={styles.cardTitle}>Receipt •••{receiptSuffix(receipt.id)}</Text>
                  <Text style={styles.timestamp}>{formatReceiptDate(receipt.submittedAt)}</Text>
                </View>
                <View style={[styles.statusChip, statusChipStyle(workerStatus)]}>
                  <Text style={styles.statusText}>{WORKER_FACING_LABELS[workerStatus]}</Text>
                </View>
              </View>

              {receipt.readability?.readable === true ? (
                <Text style={styles.detail}>Photo readability check passed.</Text>
              ) : null}

              {needsRetake && receipt.readability ? (
                <View lightColor="#fff7ed" darkColor="#2b1708" style={styles.retakeBlock}>
                  <Text style={styles.cardTitle}>What to fix</Text>
                  {receipt.readability.reasons.map((reason) => (
                    <Text key={reason.code} style={styles.detail}>
                      • {reason.guidance}
                    </Text>
                  ))}
                  <Text style={styles.detail}>
                    Retake pages{" "}
                    {receipt.readability.failedPageIndexes.map((index) => index + 1).join(", ")}.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => startRetake(receipt)}
                    style={styles.primaryButton}
                  >
                    <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.primaryButtonText}>
                      {!currentFailedPages?.length
                        ? "Retake receipt"
                        : currentFailedPages.length === 1
                          ? `Retake page ${Number(currentFailedPages[0]) + 1}`
                          : `Retake ${currentFailedPages.length} pages`}
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

function receiptStatusForDisplay(receipt: RecentReceipt): WorkerFacingStatus {
  if (receipt.readability?.readable === false) {
    return "needs_retake";
  }
  return receipt.status && isReceiptStatus(receipt.status)
    ? workerStatusFromReceipt(receipt.status)
    : "sent";
}

function receiptSuffix(receiptId: string): string {
  return receiptId.replace(/-/g, "").slice(-6).toUpperCase();
}

function formatReceiptDate(value: string | null): string {
  if (!value) {
    return "Submission time unavailable";
  }
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function statusChipStyle(status: WorkerFacingStatus) {
  switch (status) {
    case "needs_retake":
    case "failed":
    case "declined":
      return styles.warningChip;
    case "approved":
      return styles.successChip;
    default:
      return styles.infoChip;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, paddingBottom: 40, gap: 16 },
  headingBlock: { gap: 8 },
  title: { fontSize: 30, lineHeight: 36, fontWeight: "800" },
  body: { fontSize: 15, lineHeight: 22, opacity: 0.72 },
  loadingCard: {
    minHeight: 120,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  messageCard: { borderRadius: 18, padding: 18, gap: 12 },
  receiptCard: {
    borderRadius: 18,
    padding: 18,
    gap: 14,
    elevation: 2,
    borderWidth: 2,
    borderColor: "transparent",
  },
  highlightedCard: { borderColor: "#2563eb" },
  cardHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "transparent",
  },
  transparent: { flex: 1, gap: 3, backgroundColor: "transparent" },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  timestamp: { fontSize: 13, opacity: 0.65 },
  statusChip: { borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  infoChip: { backgroundColor: "#dbeafe" },
  warningChip: { backgroundColor: "#ffedd5" },
  successChip: { backgroundColor: "#dcfce7" },
  statusText: { color: "#172554", fontSize: 12, fontWeight: "800" },
  detail: { fontSize: 14, lineHeight: 20, opacity: 0.78 },
  retakeBlock: { borderRadius: 14, padding: 14, gap: 8 },
  primaryButton: {
    minHeight: 48,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 13,
    paddingHorizontal: 16,
    backgroundColor: "#2563eb",
  },
  primaryButtonText: { fontSize: 16, fontWeight: "800" },
  secondaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#94a3b8",
    borderRadius: 12,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: "700" },
  errorText: { color: "#b91c1c", fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
