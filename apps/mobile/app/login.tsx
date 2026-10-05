import { useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, TextInput } from "react-native";
import { AuthGate } from "@/components/AuthGate";
import { BrandHeader } from "@/components/BrandHeader";
import { Text, View } from "@/components/Themed";
import { Brand } from "@/constants/Brand";
import { apiBaseUrl } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";

export default function LoginScreen() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit() {
    setBusy(true);
    setError(null);
    const message = await signIn(email.trim(), password);
    if (message) {
      setError(message);
    }
    setBusy(false);
  }

  return (
    <AuthGate allow="login">
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.brand}>
          <BrandHeader onPaper />
        </View>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.body}>Use your approved email and password.</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="Email"
          placeholderTextColor={Brand.muted}
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          autoComplete="password"
          placeholder="Password"
          placeholderTextColor={Brand.muted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {error ? <Text>{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          onPress={() => void onSubmit()}
          disabled={busy}
          style={[styles.button, busy && { opacity: 0.5 }]}
        >
          <Text style={styles.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
        </Pressable>
        <View style={styles.signupSection}>
          <Text style={styles.signupTitle}>New to SVL Receipts?</Text>
          <Text style={styles.signupBody}>
            Set up your account. Your manager will approve access before you can send receipts.
          </Text>
          <Pressable
            accessibilityRole="link"
            accessibilityHint="Opens account setup on the SVL Receipts website"
            onPress={() => {
              void Linking.openURL(`${apiBaseUrl()}/request-access`).catch(() =>
                setError(
                  "Could not open signup. Visit the SVL Receipts website to request access.",
                ),
              );
            }}
            style={styles.signup}
          >
            <Text style={styles.signupText}>Create account</Text>
          </Pressable>
        </View>
      </ScrollView>
    </AuthGate>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Brand.paper },
  signupSection: {
    borderTopWidth: 1,
    borderTopColor: Brand.line,
    backgroundColor: "transparent",
    marginTop: 8,
    paddingTop: 20,
    gap: 10,
  },
  signupTitle: { color: Brand.ink, fontSize: 16, fontWeight: "600" },
  signupBody: { color: Brand.ink, fontSize: 14, lineHeight: 20 },
  signup: {
    minHeight: 52,
    width: "100%",
    borderWidth: 1.5,
    borderColor: Brand.green,
    borderRadius: 10,
    backgroundColor: Brand.card,
    justifyContent: "center",
    alignItems: "center",
  },
  signupText: { color: Brand.green, fontWeight: "700", fontSize: 16 },
  brand: { marginBottom: 22, backgroundColor: "transparent" },
  button: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: Brand.green,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonText: { color: Brand.white, fontWeight: "700", fontSize: 16 },
  container: {
    flexGrow: 1,
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
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: Brand.line,
    backgroundColor: Brand.card,
    color: Brand.ink,
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44,
  },
});
