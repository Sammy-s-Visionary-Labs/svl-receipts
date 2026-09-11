import { Stack, useRouter } from "expo-router";
import { Pressable, Text } from "react-native";
import { AuthGate } from "@/components/AuthGate";

export default function ReceiptDetailLayout() {
  const router = useRouter();
  return (
    <AuthGate allow="tabs">
      <Stack>
        <Stack.Screen
          name="[id]"
          options={{
            title: "Receipt details",
            headerLeft: () => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Back to recent uploads"
                onPress={() => router.replace("/(tabs)/recent")}
                style={{ minHeight: 44, justifyContent: "center", paddingRight: 12 }}
              >
                <Text style={{ color: "#315b49", fontSize: 16 }}>‹ Recent</Text>
              </Pressable>
            ),
          }}
        />
      </Stack>
    </AuthGate>
  );
}
