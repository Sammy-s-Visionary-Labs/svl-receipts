const EXPO_PUSH_TOKEN_PREFIXES = ["ExponentPushToken[", "ExpoPushToken["] as const;
const EXPO_UUID_TOKEN = /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i;

/** Match every token form accepted by Expo's server SDK. */
export function isExpoPushToken(value: string): boolean {
  const token = value.trim();
  return (
    (EXPO_PUSH_TOKEN_PREFIXES.some((prefix) => token.startsWith(prefix)) && token.endsWith("]")) ||
    EXPO_UUID_TOKEN.test(token)
  );
}
