export function isExpoPushToken(value: string): boolean {
  return /^ExponentPushToken\[.+\]$/.test(value.trim());
}
