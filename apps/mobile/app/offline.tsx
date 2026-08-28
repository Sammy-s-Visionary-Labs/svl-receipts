import { AuthGate } from "@/components/AuthGate";
import { AuthStatusScreen } from "@/components/AuthStatusScreen";
import { useAuth } from "@/lib/auth/auth-context";

export default function OfflineScreen() {
  const { retryIdentity } = useAuth();
  return (
    <AuthGate allow="offline">
      <AuthStatusScreen kind="offline" onRetry={() => void retryIdentity()} />
    </AuthGate>
  );
}
