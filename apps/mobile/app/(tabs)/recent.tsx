import { StyleSheet } from "react-native";
import { Text, View } from "@/components/Themed";

export default function RecentScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>My recent uploads</Text>
      <Text style={styles.body}>Receipts you send will show up here.</Text>
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
  body: {
    fontSize: 16,
  },
});
