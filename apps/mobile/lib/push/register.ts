import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { type Href, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { postPushToken } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { consumeReceiptNotificationResponse } from "./navigation";
import { isExpoPushToken } from "./token";

function configureForegroundHandler() {
  if (Platform.OS === "web") {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerWorkerPushToken(accessToken: string): Promise<void> {
  try {
    if (Platform.OS === "web") {
      return;
    }

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Receipts",
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    const finalStatus =
      existing.status === "granted"
        ? existing.status
        : (await Notifications.requestPermissionsAsync()).status;
    if (finalStatus !== "granted") {
      return;
    }

    const projectId =
      process.env.EXPO_PUBLIC_PROJECT_ID ??
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId;
    const tokenResponse = projectId
      ? await Notifications.getExpoPushTokenAsync({ projectId })
      : await Notifications.getExpoPushTokenAsync();
    const token = tokenResponse.data;
    if (!isExpoPushToken(token)) {
      return;
    }

    const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
    await postPushToken(accessToken, token, platform);
  } catch {
    // Missing project id, simulator, or API failure must not block Capture.
  }
}

export function PushRegistrar() {
  const router = useRouter();
  const { phase, session } = useAuth();

  useEffect(() => {
    configureForegroundHandler();
  }, []);

  useEffect(() => {
    if (phase !== "ready" || !session?.access_token) {
      return;
    }
    void registerWorkerPushToken(session.access_token);
  }, [phase, session?.access_token]);

  useEffect(() => {
    if (Platform.OS === "web" || phase !== "ready") {
      return;
    }

    const openReceipt = (response: Notifications.NotificationResponse) => {
      consumeReceiptNotificationResponse({
        response,
        defaultActionIdentifier: Notifications.DEFAULT_ACTION_IDENTIFIER,
        openRoute: (route) => router.replace(route as Href),
        clearLastResponse: Notifications.clearLastNotificationResponse,
      });
    };

    try {
      const initialResponse = Notifications.getLastNotificationResponse();
      if (initialResponse) {
        openReceipt(initialResponse);
      }
      const subscription = Notifications.addNotificationResponseReceivedListener(openReceipt);
      return () => subscription.remove();
    } catch {
      // Notification navigation is best-effort; Recent remains the durable fallback.
    }
  }, [phase, router]);

  return null;
}
