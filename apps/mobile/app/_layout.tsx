import { useFonts } from "expo-font";
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import "react-native-reanimated";

import { useColorScheme } from "@/components/useColorScheme";
import { AuthProvider, useAuth } from "@/lib/auth/auth-context";
import { ReceiptCaptureProvider } from "@/lib/capture/receipt-capture-context";
import { PushRegistrar } from "@/lib/push/register";

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from "expo-router";

export const unstable_settings = {
  initialRouteName: "(tabs)",
};

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono: require("../assets/fonts/SpaceMono-Regular.ttf"),
  });

  useEffect(() => {
    if (error) throw error;
  }, [error]);

  if (!loaded) {
    return null;
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <RootLayoutNav />
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();
  const { phase, session } = useAuth();

  useEffect(() => {
    if (phase !== "booting") {
      void SplashScreen.hideAsync();
    }
  }, [phase]);

  return (
    <ReceiptCaptureProvider key={session?.user.id ?? "signed-out"}>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <PushRegistrar />
        <Stack>
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="session-ended" options={{ headerShown: false }} />
          <Stack.Screen name="offline" options={{ headerShown: false }} />
          <Stack.Screen name="blocked" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen
            name="capture"
            options={{ headerShown: false, presentation: "fullScreenModal" }}
          />
        </Stack>
      </ThemeProvider>
    </ReceiptCaptureProvider>
  );
}
