import type { Session } from "@supabase/supabase-js";
import type { UserRole } from "@svl/domain";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { fetchMe, postSignOut } from "@/lib/api/client";
import { clearPersistedIdentity, loadPersistedIdentity, persistIdentity } from "./identity-store";
import { type AuthPhase, type IdentityError, type MeIdentity, resolveAuthPhase } from "./phase";
import { getMobileSupabaseClient } from "./supabase";

type AuthState = {
  phase: AuthPhase;
  session: Session | null;
  role: UserRole | null;
  userId: string | null;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: (everywhere?: boolean) => Promise<void>;
  retryIdentity: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [identity, setIdentity] = useState<MeIdentity | null>(null);
  const [error, setError] = useState<IdentityError | null>(null);
  const [booting, setBooting] = useState(true);
  const sessionRef = useRef<Session | null>(null);

  const applyIdentity = useCallback(async (next: Session | null, isBoot: boolean) => {
    sessionRef.current = next;
    setSession(next);
    if (!next) {
      setIdentity(null);
      setError(null);
      await clearPersistedIdentity();
      if (isBoot) {
        setBooting(false);
      }
      return;
    }

    const cached = await loadPersistedIdentity(next.user.id);
    if (cached) {
      setIdentity(cached);
      setError(null);
    }

    const result = await fetchMe(next.access_token);
    if (sessionRef.current?.user.id !== next.user.id) {
      if (isBoot) {
        setBooting(false);
      }
      return;
    }
    if (result.ok) {
      setIdentity(result.identity);
      setError(null);
      await persistIdentity(result.identity);
    } else if (result.error === "inactive") {
      setIdentity(null);
      setError("inactive");
      await clearPersistedIdentity();
    } else if (!cached) {
      setIdentity(null);
      setError("network");
    } else {
      setError(null);
    }
    if (isBoot) {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = getMobileSupabaseClient();

      void supabase.auth.getSession().then(async ({ data }) => {
        if (cancelled) {
          return;
        }
        await applyIdentity(data.session, true);
      });

      const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
        if (cancelled) {
          return;
        }
        if (event === "INITIAL_SESSION") {
          return;
        }
        if (event === "TOKEN_REFRESHED") {
          sessionRef.current = next;
          setSession(next);
          return;
        }
        void applyIdentity(next, false);
      });

      return () => {
        cancelled = true;
        listener.subscription.unsubscribe();
      };
    } catch {
      setBooting(false);
      return undefined;
    }
  }, [applyIdentity]);

  const retryIdentity = useCallback(async () => {
    if (sessionRef.current) {
      await applyIdentity(sessionRef.current, false);
    }
  }, [applyIdentity]);

  const value = useMemo<AuthState>(() => {
    const phase = resolveAuthPhase({
      booting,
      hasSession: Boolean(session),
      role: identity?.role ?? null,
      error,
    });
    return {
      phase,
      session,
      role: identity?.role ?? null,
      userId: identity?.userId ?? session?.user.id ?? null,
      async signIn(email, password) {
        try {
          const { error: signInError } = await getMobileSupabaseClient().auth.signInWithPassword({
            email,
            password,
          });
          return signInError ? "Check your email and password and try again." : null;
        } catch {
          return "This phone is not configured to sign in yet.";
        }
      },
      async signOut(everywhere = false) {
        const token = sessionRef.current?.access_token;
        if (token) {
          try {
            await postSignOut(token, everywhere);
          } catch {
            // Local sign-out still has to succeed so the worker can leave the app.
          }
        }
        try {
          await getMobileSupabaseClient().auth.signOut({
            scope: everywhere ? "global" : "local",
          });
        } catch {
          await applyIdentity(null, false);
        }
      },
      retryIdentity,
    };
  }, [applyIdentity, booting, error, identity, retryIdentity, session]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
