import { AuthGate } from "@/components/AuthGate";
import { AuthStatusScreen } from "@/components/AuthStatusScreen";
import { useAuth } from "@/lib/auth/auth-context";

export default function SessionEndedScreen() {
  const { signOut } = useAuth();
  return (
    <AuthGate allow="revoked">
      <AuthStatusScreen
        kind="revoked"
        actionLabel="Sign in again"
        onSignOut={() => void signOut()}
      />
    </AuthGate>
  );
}
