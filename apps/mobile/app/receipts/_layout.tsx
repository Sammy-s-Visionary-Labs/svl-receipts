import { Stack } from "expo-router";
import { AuthGate } from "@/components/AuthGate";

export default function ReceiptDetailLayout() {
  return (
    <AuthGate allow="tabs">
      <Stack>
        <Stack.Screen name="[id]" options={{ title: "Receipt details" }} />
      </Stack>
    </AuthGate>
  );
}
