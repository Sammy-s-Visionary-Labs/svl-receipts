import { Button, StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";

export function AuthStatusScreen({
  kind,
  actionLabel,
  onRetry,
  onSignOut,
}: {
  kind: "booting" | "revoked" | "offline" | "wrong_role" | "inactive";
  actionLabel?: string;
  onRetry?: () => void;
  onSignOut?: () => void;
}) {
  const copy = COPY[kind];
  return (
    <View style={styles.container}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      {onRetry ? <Button title="Try again" onPress={onRetry} /> : null}
      {onSignOut ? <Button title={actionLabel ?? "Sign out"} onPress={onSignOut} /> : null}
    </View>
  );
}

const COPY = {
  booting: {
    title: "Opening SVL Receipts",
    body: "Restoring your session…",
  },
  revoked: {
    title: "Your session ended",
    body: "Sign in again to continue. Receipts queued on this phone have not been deleted.",
  },
  offline: {
    title: "Can't reach the server",
    body: "Check this phone's connection, then try again. If you already signed in, queued receipts stay on this phone.",
  },
  wrong_role: {
    title: "This app is for field workers",
    body: "Managers and admins use the web dashboard. You can sign out of this phone.",
  },
  inactive: {
    title: "This account is not active",
    body: "Ask your manager to restore access, then sign in again.",
  },
} as const;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    gap: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: "600",
  },
  body: {
    fontSize: 16,
    marginBottom: 12,
  },
});
