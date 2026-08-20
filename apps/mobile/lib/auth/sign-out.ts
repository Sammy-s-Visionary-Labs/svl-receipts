import { Alert } from "react-native";
import { countQueuedReceipts, shouldWarnOnSignOut } from "@/lib/queue/pending";

export async function confirmAndSignOut(signOut: () => Promise<void>): Promise<void> {
  const queued = await countQueuedReceipts();
  if (!shouldWarnOnSignOut(queued)) {
    await signOut();
    return;
  }
  Alert.alert(
    "Queued receipts stay on this phone",
    "They will upload only after you sign back in as the same person. They will not be deleted.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ],
  );
}
