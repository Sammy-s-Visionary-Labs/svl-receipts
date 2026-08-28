import { Stack } from "expo-router";
import { AuthGate } from "@/components/AuthGate";

export default function CaptureLayout() {
  return (
    <AuthGate allow="tabs">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="camera" />
        <Stack.Screen name="preview" />
        <Stack.Screen name="location" />
        <Stack.Screen name="ready" />
      </Stack>
    </AuthGate>
  );
}
