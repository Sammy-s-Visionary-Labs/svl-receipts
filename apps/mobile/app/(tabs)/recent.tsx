import { WORKER_FACING_LABELS, type WorkerFacingStatus } from "@svl/domain";
import { type Href, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
} from "react-native";
import { Text, useThemeColor, View } from "@/components/Themed";
import { fetchRecentReceipts, type RecentReceipt } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { planCloudRetake } from "@/lib/capture/cloud-retake";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";
import type { PendingReceiptQueueItem } from "@/lib/queue/pending";
import { getPendingReceiptQueue } from "@/lib/queue/pending-native";
import {
  appendRecentReceiptPage,
  mergeRecentHistory,
  type RecentHistoryItem,
} from "@/lib/recent/history";

export default function RecentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ receiptId?: string | string[] }>();
  const highlightedReceiptId = Array.isArray(params.receiptId)
    ? params.receiptId[0]
    : params.receiptId;
  const { session } = useAuth();
  const { state, submission, beginRequiredRetakes, startNewReceipt } = useReceiptCapture();
  const [cloudReceipts, setCloudReceipts] = useState<RecentReceipt[]>([]);
  const [deviceReceipts, setDeviceReceipts] = useState<PendingReceiptQueueItem[]>([]);
  const [devicePreviewUris, setDevicePreviewUris] = useState<Map<string, string>>(new Map());
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const previewQueueIdsRef = useRef<Set<string>>(new Set());
  const backgroundColor = useThemeColor({ light: "#f6f7f2", dark: "#080b10" }, "background");
  const receipts = useMemo(
    () => mergeRecentHistory({ cloud: cloudReceipts, device: deviceReceipts, devicePreviewUris }),
    [cloudReceipts, deviceReceipts, devicePreviewUris],
  );

  const loadReceipts = useCallback(
    async (showRefresh: boolean) => {
      const requestGeneration = requestGenerationRef.current + 1;
      requestGenerationRef.current = requestGeneration;
      const accessToken = session?.access_token;
      const ownerUserId = session?.user.id;
      if (!accessToken || !ownerUserId) {
        setLoading(false);
        return;
      }
      if (showRefresh) setRefreshing(true);

      const queue = getPendingReceiptQueue();
      const [cloudResult, deviceResult] = await Promise.allSettled([
        fetchRecentReceipts(accessToken),
        queue.list(ownerUserId),
      ]);
      if (requestGenerationRef.current !== requestGeneration) return;

      if (cloudResult.status === "fulfilled") {
        setCloudReceipts(cloudResult.value.receipts);
        setNextCursor(cloudResult.value.nextCursor);
        setErrorMessage(null);
      } else {
        setErrorMessage(
          "Cloud receipts could not be loaded. Device uploads are still shown below.",
        );
      }

      if (deviceResult.status === "fulfilled") {
        setDeviceReceipts(deviceResult.value);
        const previews = new Map<string, string>();
        const preparedIds = new Set<string>();
        await Promise.all(
          deviceResult.value.map(async (item) => {
            if (!item.filesReady || item.status === "sent" || item.pages.length === 0) return;
            try {
              previews.set(item.id, await queue.preparePreviewPage(item.id));
              preparedIds.add(item.id);
            } catch {
              // The status row is still useful when a protected preview cannot be staged.
            }
          }),
        );
        if (requestGenerationRef.current === requestGeneration) {
          const staleIds = new Set(
            [...previewQueueIdsRef.current].filter((id) => !preparedIds.has(id)),
          );
          await cleanupPreviews(queue, staleIds);
          if (requestGenerationRef.current === requestGeneration) {
            previewQueueIdsRef.current = preparedIds;
            setDevicePreviewUris(previews);
          } else {
            await cleanupPreviews(queue, preparedIds);
          }
        } else {
          await cleanupPreviews(queue, preparedIds);
        }
      } else if (cloudResult.status === "fulfilled") {
        setErrorMessage(
          "Uploads saved on this device could not be read. Cloud receipts are shown.",
        );
      }

      if (requestGenerationRef.current === requestGeneration) {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [session?.access_token, session?.user.id],
  );

  useFocusEffect(
    useCallback(() => {
      void loadReceipts(false);
      return () => {
        requestGenerationRef.current += 1;
        const queue = getPendingReceiptQueue();
        const ids = previewQueueIdsRef.current;
        previewQueueIdsRef.current = new Set();
        void cleanupPreviews(queue, ids);
      };
    }, [loadReceipts]),
  );

  async function loadMore() {
    const accessToken = session?.access_token;
    if (!accessToken || !nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchRecentReceipts(accessToken, nextCursor);
      setCloudReceipts((current) => appendRecentReceiptPage(current, page.receipts));
      setNextCursor(page.nextCursor);
      setErrorMessage(null);
    } catch {
      setErrorMessage("Older receipts could not be loaded. Try again.");
    } finally {
      setLoadingMore(false);
    }
  }

  function startRetake(receipt: RecentHistoryItem) {
    const plan = planCloudRetake({
      receiptId: receipt.id,
      currentReceiptId: submission.confirmation?.id ?? null,
      pageCount: state.pages.length,
      failedPageIndexes: receipt.readability?.failedPageIndexes ?? [],
      hasUnsentDraft: state.pages.length > 0 && submission.phase !== "sent",
    });
    const proceed = () => {
      if (plan.kind === "replace_pages") beginRequiredRetakes(plan.indexes);
      else startNewReceipt();
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
    <FlatList
      contentContainerStyle={styles.content}
      data={loading ? [] : receipts}
      initialNumToRender={8}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      keyExtractor={(receipt) => `${receipt.source}-${receipt.id}`}
      ListEmptyComponent={
        loading ? null : (
          <View lightColor="#ffffff" darkColor="#121821" style={styles.messageCard}>
            <Text style={styles.cardTitle}>No uploads yet</Text>
            <Text style={styles.body}>Receipts you send will appear here.</Text>
          </View>
        )
      }
      ListFooterComponent={
        nextCursor ? (
          <Pressable
            accessibilityRole="button"
            disabled={loadingMore}
            onPress={() => void loadMore()}
            style={[styles.secondaryButton, styles.footerButton]}
          >
            {loadingMore ? (
              <ActivityIndicator color="#315b49" />
            ) : (
              <Text style={styles.secondaryButtonText}>Load older receipts</Text>
            )}
          </Pressable>
        ) : null
      }
      ListHeaderComponent={
        <View lightColor="#f6f7f2" darkColor="#080b10" style={styles.listHeader}>
          <View lightColor="#f6f7f2" darkColor="#080b10" style={styles.headingBlock}>
            <Text accessibilityRole="header" style={styles.title}>
              My recent uploads
            </Text>
            <Text style={styles.body}>
              Uploads from this phone and cloud results appear together, newest first.
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
              <ActivityIndicator color="#315b49" />
              <Text style={styles.body}>Loading recent receipts…</Text>
            </View>
          ) : null}
        </View>
      }
      maxToRenderPerBatch={8}
      removeClippedSubviews
      refreshControl={
        <RefreshControl
          onRefresh={() => void loadReceipts(true)}
          refreshing={refreshing}
          tintColor="#315b49"
        />
      }
      renderItem={({ item: receipt }) => {
        const isHighlighted = receipt.id === highlightedReceiptId;
        const needsRetake = receipt.workerStatus === "needs_retake";
        return (
          <View
            lightColor="#ffffff"
            darkColor="#121821"
            style={[styles.receiptCard, isHighlighted && styles.highlightedCard]}
          >
            <Pressable
              accessibilityHint={
                receipt.source === "cloud" ? "Opens read-only receipt details" : undefined
              }
              accessibilityLabel={isHighlighted ? "Receipt opened from notification" : undefined}
              accessibilityRole={receipt.source === "cloud" ? "button" : undefined}
              disabled={receipt.source !== "cloud"}
              onPress={() => router.push(`/receipts/${receipt.id}` as Href)}
            >
              <View style={styles.cardHeading}>
                {receipt.thumbnailUri ? (
                  <Image
                    accessibilityLabel="First receipt page"
                    source={{ uri: receipt.thumbnailUri }}
                    style={styles.thumbnail}
                  />
                ) : (
                  <View
                    accessibilityLabel="Receipt preview unavailable"
                    lightColor="#e6e8e0"
                    darkColor="#263140"
                    style={styles.thumbnailPlaceholder}
                  >
                    <Text style={styles.thumbnailIcon}>▤</Text>
                  </View>
                )}
                <View style={styles.cardCopy}>
                  <Text style={styles.cardTitle}>Receipt •••{receiptSuffix(receipt.id)}</Text>
                  <Text style={styles.timestamp}>{formatReceiptDate(receipt.submittedAt)}</Text>
                  <Text style={styles.timestamp}>
                    {receipt.pageCount} {receipt.pageCount === 1 ? "page" : "pages"}
                  </Text>
                </View>
                <View style={[styles.statusChip, statusChipStyle(receipt.workerStatus)]}>
                  <Text accessibilityElementsHidden style={styles.statusIcon}>
                    {statusIcon(receipt.workerStatus)}
                  </Text>
                  <Text style={styles.statusText}>
                    {WORKER_FACING_LABELS[receipt.workerStatus]}
                  </Text>
                </View>
              </View>
            </Pressable>

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
                    Retake receipt
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        );
      }}
      style={[styles.container, { backgroundColor }]}
      windowSize={7}
    />
  );
}

async function cleanupPreviews(
  queue: ReturnType<typeof getPendingReceiptQueue>,
  ids: ReadonlySet<string>,
): Promise<void> {
  await Promise.all([...ids].map((id) => queue.removePreviewPages(id).catch(() => undefined)));
}

function receiptSuffix(receiptId: string): string {
  return receiptId.replace(/-/g, "").slice(-6).toUpperCase();
}

function formatReceiptDate(value: string | null): string {
  if (!value) return "Submission time unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function statusIcon(status: WorkerFacingStatus): string {
  switch (status) {
    case "pending":
      return "◷";
    case "sending":
      return "↑";
    case "failed":
      return "!";
    case "sent":
      return "✓";
    case "needs_retake":
      return "↻";
    case "in_review":
      return "◉";
    case "approved":
      return "✓";
    case "declined":
      return "×";
  }
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
  content: { padding: 24, paddingBottom: 40 },
  listHeader: { gap: 16, marginBottom: 16 },
  separator: { height: 16, backgroundColor: "transparent" },
  footerButton: { marginTop: 16 },
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
    padding: 16,
    gap: 14,
    elevation: 2,
    borderWidth: 2,
    borderColor: "transparent",
  },
  highlightedCard: { borderColor: "#315b49" },
  cardHeading: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    backgroundColor: "transparent",
  },
  cardCopy: { flex: 1, gap: 3, backgroundColor: "transparent" },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  timestamp: { fontSize: 13, opacity: 0.65 },
  thumbnail: { width: 64, height: 82, borderRadius: 8, backgroundColor: "#e6e8e0" },
  thumbnailPlaceholder: {
    width: 64,
    height: 82,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  thumbnailIcon: { fontSize: 28, opacity: 0.55 },
  statusChip: {
    maxWidth: 108,
    borderRadius: 14,
    paddingHorizontal: 9,
    paddingVertical: 6,
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
  },
  infoChip: { backgroundColor: "#e3e8ca" },
  warningChip: { backgroundColor: "#ffedd5" },
  successChip: { backgroundColor: "#dcfce7" },
  statusIcon: { color: "#172554", fontSize: 13, fontWeight: "900" },
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
    backgroundColor: "#315b49",
  },
  primaryButtonText: { fontSize: 16, fontWeight: "800" },
  secondaryButton: {
    minHeight: 46,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#a4ae9b",
    borderRadius: 12,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: "700" },
  errorText: { color: "#b91c1c", fontSize: 14, lineHeight: 20, fontWeight: "600" },
});
