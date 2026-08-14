import { DOMAIN_PACKAGE } from "@svl/domain";
import { Button, StyleSheet } from "react-native";

import { Text, View } from "@/components/Themed";
import { useAuth } from "@/lib/auth/auth-context";

export default function TabOneScreen() {
  const { role, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <Text style={styles.title}>SVL Receipts</Text>
      <Text>Role: {role ?? "unknown"}</Text>
      <Text>Scaffold check: {DOMAIN_PACKAGE}</Text>
      <View style={styles.separator} lightColor="#eee" darkColor="rgba(255,255,255,0.1)" />
      <Button title="Sign out" onPress={() => void signOut()} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
  },
  separator: {
    marginVertical: 30,
    height: 1,
    width: "80%",
  },
});
