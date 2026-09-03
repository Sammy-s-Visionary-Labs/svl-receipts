import { WORKER_FACING_LABELS } from "@svl/domain";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet } from "react-native";
import { Text, useThemeColor, View } from "@/components/Themed";
import { fetchWorkerReceiptDetail, type WorkerReceiptDetail } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";

export default function ReceiptDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const receiptId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { session } = useAuth();
  const [detail, setDetail] = useState<WorkerReceiptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const backgroundColor = useThemeColor({ light: "#f6f8fb", dark: "#080b10" }, "background");

  const loadDetail = useCallback(async () => {
    const accessToken = session?.access_token;
    if (!accessToken || !receiptId) {
      setLoading(false);
      setErrorMessage("This receipt link is invalid.");
      return;
    }
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    setLoading(true);
    try {
      const next = await fetchWorkerReceiptDetail(accessToken, receiptId);
      if (requestGenerationRef.current !== generation) return;
      setDetail(next);
      setErrorMessage(null);
    } catch {
      if (requestGenerationRef.current !== generation) return;
      setErrorMessage("Receipt details could not be loaded. Check the connection and try again.");
    } finally {
      if (requestGenerationRef.current === generation) setLoading(false);
    }
  }, [receiptId, session?.access_token]);

  useFocusEffect(
    useCallback(() => {
      void loadDetail();
      return () => {
        requestGenerationRef.current += 1;
      };
    }, [loadDetail]),
  );

  return (
    <ScrollView
      contentContainerStyle={styles.content}
      style={[styles.container, { backgroundColor }]}
    >
      {loading ? (
        <View
          accessibilityLabel="Loading receipt details"
          lightColor="#ffffff"
          darkColor="#121821"
          style={styles.centerCard}
        >
          <ActivityIndicator color="#2563eb" />
          <Text style={styles.body}>Loading receipt details…</Text>
        </View>
      ) : errorMessage || !detail ? (
        <View lightColor="#fef2f2" darkColor="#351313" style={styles.centerCard}>
          <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
            {errorMessage ?? "Receipt details are unavailable."}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void loadDetail()}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <>
          <View lightColor="#ffffff" darkColor="#121821" style={styles.summaryCard}>
            <Text accessibilityRole="header" style={styles.title}>
              Receipt •••{receiptSuffix(detail.id)}
            </Text>
            <Text style={styles.timestamp}>{formatReceiptDate(detail.submittedAt)}</Text>
            <View lightColor="#dbeafe" darkColor="#172554" style={styles.statusChip}>
              <Text style={styles.statusText}>{WORKER_FACING_LABELS[detail.workerStatus]}</Text>
            </View>
            <Text style={styles.readOnlyNote}>Read-only submission record</Text>
          </View>

          {detail.readability?.readable === false ? (
            <View lightColor="#fff7ed" darkColor="#2b1708" style={styles.guidanceCard}>
              <Text style={styles.cardTitle}>Needs retake</Text>
              {detail.readability.reasons.map((reason) => (
                <Text key={reason.code} style={styles.body}>
                  • {reason.guidance}
                </Text>
              ))}
              <Text style={styles.body}>
                Affected pages:{" "}
                {detail.readability.failedPageIndexes.map((index) => index + 1).join(", ")}
              </Text>
            </View>
          ) : null}

          <Text accessibilityRole="header" style={styles.sectionTitle}>
            {detail.pages.length} {detail.pages.length === 1 ? "page" : "pages"}
          </Text>
          {detail.pages.map((page) => (
            <View
              key={page.pageIndex}
              lightColor="#ffffff"
              darkColor="#121821"
              style={styles.pageCard}
            >
              <Text style={styles.cardTitle}>Page {page.pageIndex + 1}</Text>
              <Image
                accessibilityLabel={`Receipt page ${page.pageIndex + 1}`}
                resizeMode="contain"
                source={{ uri: page.image.url }}
                style={styles.pageImage}
              />
            </View>
          ))}
        </>
      )}
    </ScrollView>
  );
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

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 40, gap: 16 },
  centerCard: {
    minHeight: 180,
    borderRadius: 18,
    padding: 18,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  summaryCard: { borderRadius: 18, padding: 18, gap: 8 },
  guidanceCard: { borderRadius: 18, padding: 18, gap: 8 },
  pageCard: { borderRadius: 18, padding: 14, gap: 10 },
  title: { fontSize: 27, lineHeight: 34, fontWeight: "800" },
  sectionTitle: { fontSize: 22, lineHeight: 28, fontWeight: "800" },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  body: { fontSize: 15, lineHeight: 22, opacity: 0.78 },
  timestamp: { fontSize: 14, opacity: 0.68 },
  readOnlyNote: { fontSize: 13, opacity: 0.62 },
  statusChip: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  statusText: { color: "#172554", fontSize: 13, fontWeight: "800" },
  pageImage: { width: "100%", height: 430, borderRadius: 10, backgroundColor: "#e2e8f0" },
  secondaryButton: {
    minHeight: 46,
    minWidth: 150,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#94a3b8",
    borderRadius: 12,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: "700" },
  errorText: {
    color: "#b91c1c",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "600",
    textAlign: "center",
  },
});
