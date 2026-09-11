import { useState } from "react";
import { Pressable, StyleSheet, TextInput } from "react-native";
import { AuthGate } from "@/components/AuthGate";
import { BrandHeader } from "@/components/BrandHeader";
import { Text, View } from "@/components/Themed";
import { Brand } from "@/constants/Brand";
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
        <Text style={styles.body}>Use the email and password your manager set up.</Text>
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
      </View>
    </AuthGate>
  );
}

const styles = StyleSheet.create({
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
