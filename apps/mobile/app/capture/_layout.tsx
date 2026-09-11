import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthGate } from "@/components/AuthGate";

export default function CaptureLayout() {
  return (
    <AuthGate allow="tabs">
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="camera" />
        <Stack.Screen name="preview" />
        <Stack.Screen name="location" />
        <Stack.Screen name="ready" />
      </Stack>
    </AuthGate>
  );
}
