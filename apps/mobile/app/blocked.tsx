import { AuthGate } from "@/components/AuthGate";
import { AuthStatusScreen } from "@/components/AuthStatusScreen";
import { useAuth } from "@/lib/auth/auth-context";
import { confirmAndSignOut } from "@/lib/auth/sign-out";

export default function BlockedScreen() {
  const { phase, signOut } = useAuth();
  return (
    <AuthGate allow="blocked">
      <AuthStatusScreen
        kind={phase === "inactive" ? "inactive" : "wrong_role"}
        onSignOut={() => void confirmAndSignOut(() => signOut())}
      />
    </AuthGate>
  );
}
