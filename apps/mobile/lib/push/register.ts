import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Platform } from "react-native";
import { postPushToken } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/auth-context";
import { isExpoPushToken } from "./token";

function configureForegroundHandler() {
  if (Platform.OS === "web") {
    return;
  }
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export async function registerWorkerPushToken(accessToken: string): Promise<void> {
  try {
    if (Platform.OS === "web" || !Device.isDevice) {
      return;
    }

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Receipts",
        importance: Notifications.AndroidImportance.DEFAULT,
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

  return null;
}
