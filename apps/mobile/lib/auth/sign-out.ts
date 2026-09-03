import { Alert } from "react-native";
import { countQueuedReceipts, shouldWarnOnSignOut } from "@/lib/queue/pending";

export async function confirmAndSignOut(
  signOut: () => Promise<void>,
  countQueued: () => Promise<number> = countQueuedReceipts,
): Promise<void> {
  let queued: number;
  try {
    queued = await countQueued();
  } catch {
    showSignOutWarning(
      signOut,
      "Queued receipt status is unavailable",
      "Signing out will not delete receipt photos. Sign back in as the same person to retry them.",
    );
    return;
  }
  if (!shouldWarnOnSignOut(queued)) {
    await signOut();
    return;
  }
  showSignOutWarning(
    signOut,
    "Queued receipts stay on this phone",
    "They will upload only after you sign back in as the same person. They will not be deleted.",
  );
}

function showSignOutWarning(signOut: () => Promise<void>, title: string, message: string): void {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: "Sign out", style: "destructive", onPress: () => void signOut() },
  ]);
}
