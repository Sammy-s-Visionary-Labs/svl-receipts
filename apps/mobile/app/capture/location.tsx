import * as Location from "expo-location";
import { type Href, Redirect, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, useThemeColor, View } from "@/components/Themed";
import { locationMetadataFromSnapshot } from "@/lib/capture/location-metadata";
import { useReceiptCapture } from "@/lib/capture/receipt-capture-context";

export default function ReceiptLocationScreen() {
  const router = useRouter();
  const { state, setLocation, skipLocation } = useReceiptCapture();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const backgroundColor = useThemeColor({ light: "#f6f8fb", dark: "#080b10" }, "background");

  if (state.pages.length === 0) {
    return <Redirect href={"/(tabs)" as Href} />;
  }
  if (!state.confirmed) {
    return <Redirect href={"/capture/preview" as Href} />;
  }

  async function addCurrentLocation() {
    setBusy(true);
    setMessage(null);
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== Location.PermissionStatus.GRANTED) {
        setMessage("Location access was not allowed. You can continue without location.");
        return;
      }

      const snapshot = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const metadata = locationMetadataFromSnapshot(snapshot);
      if (metadata.latitude === null || metadata.longitude === null) {
        setMessage("A current location was not available. You can continue without location.");
        return;
      }
      setLocation(metadata);
      router.replace("/capture/ready" as Href);
    } catch {
      setMessage("A current location was not available. You can continue without location.");
    } finally {
      setBusy(false);
    }
  }

  function continueWithoutLocation() {
    skipLocation();
    router.replace("/capture/ready" as Href);
  }

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <View lightColor="#ffffff" darkColor="#121821" style={styles.card}>
          <Text style={styles.eyebrow}>OPTIONAL</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Add this receipt’s location?
          </Text>
          <Text style={styles.body}>
            If you allow it, the app takes one current location sample with its accuracy and time.
            It does not track you continuously.
          </Text>

          {state.locationDecision === "included" ? (
            <View lightColor="#ecfdf5" darkColor="#123225" style={styles.savedNotice}>
              <Text style={styles.savedTitle}>Location already added</Text>
              <Text style={styles.savedBody}>
                {state.location.accuracyMeters === null
                  ? "Accuracy was not reported."
                  : `Accuracy was about ${Math.round(state.location.accuracyMeters)} meters.`}
              </Text>
            </View>
          ) : null}

          {message ? (
            <Text accessibilityLiveRegion="polite" style={styles.message}>
              {message}
            </Text>
          ) : null}

          <Pressable
            accessibilityHint="Requests foreground location access for one current sample"
            accessibilityRole="button"
            disabled={busy}
            onPress={() => void addCurrentLocation()}
            style={[styles.primaryButton, busy && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text lightColor="#ffffff" darkColor="#ffffff" style={styles.primaryButtonText}>
                {state.locationDecision === "included"
                  ? "Update current location"
                  : "Add current location"}
              </Text>
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            disabled={busy}
            onPress={continueWithoutLocation}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Continue without location</Text>
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
    justifyContent: "center",
    padding: 24,
  },
  card: {
    gap: 14,
    borderRadius: 22,
    padding: 22,
    elevation: 3,
  },
  eyebrow: {
    color: "#2563eb",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 1.1,
  },
  title: {
    fontSize: 29,
    lineHeight: 35,
    fontWeight: "800",
  },
  body: {
    fontSize: 16,
    lineHeight: 24,
    opacity: 0.76,
  },
  savedNotice: {
    gap: 3,
    borderRadius: 12,
    padding: 13,
  },
  savedTitle: {
    fontSize: 15,
    fontWeight: "800",
  },
  savedBody: {
    fontSize: 14,
    opacity: 0.75,
  },
  message: {
    color: "#b45309",
    fontSize: 14,
    lineHeight: 20,
    fontWeight: "700",
  },
  primaryButton: {
    minHeight: 58,
    marginTop: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingHorizontal: 18,
    backgroundColor: "#2563eb",
  },
  primaryButtonText: {
    fontSize: 17,
    fontWeight: "800",
  },
  secondaryButton: {
    minHeight: 54,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#94a3b8",
    borderRadius: 15,
    paddingHorizontal: 18,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "800",
  },
  disabled: {
    opacity: 0.55,
  },
});
