import { Image, StyleSheet, Text, View } from "react-native";
import { Brand } from "@/constants/Brand";

export function BrandHeader({ onPaper = false }: { onPaper?: boolean }) {
  return (
    <View accessible accessibilityLabel="SVL Receipts" style={styles.brand}>
      <Image source={require("../assets/images/svl-mark.png")} style={styles.mark} />
      <View>
        <Text style={[styles.name, onPaper && { color: Brand.ink }]}>Receipts</Text>
        <Text style={[styles.caption, onPaper && { color: Brand.muted }]}>SVL WORKSPACE</Text>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  brand: { flexDirection: "row", gap: 12, alignItems: "center" },
  mark: { width: 40, height: 40, borderRadius: 7 },
  name: { fontSize: 21, fontWeight: "600", letterSpacing: -0.5, color: Brand.white },
  caption: { fontSize: 9, letterSpacing: 1.7, color: "#afc1b2", marginTop: 2 },
});
