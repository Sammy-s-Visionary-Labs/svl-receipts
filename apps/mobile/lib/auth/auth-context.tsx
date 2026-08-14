import type { Session } from "@supabase/supabase-js";
import { parseUserRole, type UserRole } from "@svl/domain";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { getMobileSupabaseClient } from "./supabase";

type AuthState = {
  session: Session | null;
  role: UserRole | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: (everywhere?: boolean) => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function loadRole(userId: string): Promise<UserRole | null> {
  const supabase = getMobileSupabaseClient();
  const { data } = await supabase
    .from("profiles")
    .select("role, disabled")
    .eq("id", userId)
    .maybeSingle();
  const profile = data as { role: string; disabled: boolean } | null;
  if (!profile || profile.disabled) {
    return null;
  }
  return parseUserRole(profile.role);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<UserRole | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = getMobileSupabaseClient();

      void supabase.auth.getSession().then(async ({ data }) => {
        if (cancelled) {
          return;
        }
        setSession(data.session);
        setRole(data.session ? await loadRole(data.session.user.id) : null);
        setLoading(false);
      });

      const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
        setSession(next);
        if (!next) {
          setRole(null);
          return;
        }
        void loadRole(next.user.id).then(setRole);
      });

      return () => {
        cancelled = true;
        listener.subscription.unsubscribe();
      };
    } catch {
      setLoading(false);
      return undefined;
    }
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      session,
      role,
      loading,
      async signIn(email, password) {
        try {
          const { error } = await getMobileSupabaseClient().auth.signInWithPassword({
            email,
            password,
          });
          return error ? "Sign in failed" : null;
        } catch {
          return "Supabase is not configured";
        }
      },
      async signOut(everywhere = false) {
        await getMobileSupabaseClient().auth.signOut({ scope: everywhere ? "global" : "local" });
      },
    }),
    [session, role, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
