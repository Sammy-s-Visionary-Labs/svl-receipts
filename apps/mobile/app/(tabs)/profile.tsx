import * as Linking from "expo-linking";
import { Alert, Button, StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";
import { useAuth } from "@/lib/auth/auth-context";
import { confirmAndSignOut } from "@/lib/auth/sign-out";

export default function ProfileScreen() {
  const { session, signOut } = useAuth();
  const supportEmail = process.env.EXPO_PUBLIC_SUPPORT_EMAIL?.trim();

  function onHelp() {
    if (supportEmail) {
      void Linking.openURL(`mailto:${supportEmail}`);
      return;
    }
    Alert.alert(
      "Ask your manager",
      "Your manager can help if you cannot sign in or capture receipts.",
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      {session?.user.email ? <Text>{session.user.email}</Text> : null}
      <Button title={supportEmail ? "Email support" : "Get help"} onPress={onHelp} />
      <Button title="Sign out" onPress={() => void confirmAndSignOut(() => signOut())} />
    </View>
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
});
