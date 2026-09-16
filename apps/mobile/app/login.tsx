import { useState } from "react";
import { Linking, Pressable, StyleSheet, TextInput } from "react-native";
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
      <View style={styles.container}>
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
        <Pressable
          accessibilityRole="link"
          onPress={() => {
            void Linking.openURL(`${apiBaseUrl()}/request-access`).catch(() =>
              setError("Could not open signup. Visit the SVL Receipts website to request access."),
            );
          }}
          style={styles.signup}
        >
          <Text style={styles.signupText}>First time here? Request worker access</Text>
        </Pressable>
      </View>
    </AuthGate>
  );
}

const styles = StyleSheet.create({
  signup: { minHeight: 48, justifyContent: "center", alignItems: "center" },
  signupText: { color: Brand.green, textDecorationLine: "underline" },
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
