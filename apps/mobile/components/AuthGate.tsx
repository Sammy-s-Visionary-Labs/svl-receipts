import { type Href, Redirect } from "expo-router";
import type { ReactNode } from "react";
import { AuthStatusScreen } from "@/components/AuthStatusScreen";
import { useAuth } from "@/lib/auth/auth-context";
import { type AuthDestination, destinationForPhase } from "@/lib/auth/phase";

const HREFS: Record<Exclude<AuthDestination, "booting">, Href> = {
  login: "/login" as Href,
  offline: "/offline" as Href,
  blocked: "/blocked" as Href,
  tabs: "/(tabs)",
};

export function AuthGate({
  allow,
  children,
}: {
  allow: Exclude<AuthDestination, "booting">;
  children: ReactNode;
}) {
  const { phase } = useAuth();
  const dest = destinationForPhase(phase);
  if (dest === "booting") {
    return <AuthStatusScreen kind="booting" />;
  }
  if (dest !== allow) {
    return <Redirect href={HREFS[dest]} />;
  }
  return children;
}
