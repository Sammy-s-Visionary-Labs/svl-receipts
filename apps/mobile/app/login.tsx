import { useState } from "react";
import { Button, StyleSheet, TextInput } from "react-native";
import { AuthGate } from "@/components/AuthGate";
import { Text, View } from "@/components/Themed";
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
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.body}>Use the email and password your manager set up.</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="Email"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          autoComplete="password"
          placeholder="Password"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        {error ? <Text>{error}</Text> : null}
        <Button
          title={busy ? "Signing in…" : "Sign in"}
          onPress={() => void onSubmit()}
          disabled={busy}
        />
      </View>
    </AuthGate>
  );
}

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
    marginBottom: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 8,
    paddingHorizontal: 12,
    height: 44,
  },
});
