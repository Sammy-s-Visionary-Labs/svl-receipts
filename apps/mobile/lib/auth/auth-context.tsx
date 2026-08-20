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
import { restoreInitialSession } from "./session-restore";
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

async function clearPersistedIdentityQuietly(): Promise<void> {
  try {
    await clearPersistedIdentity();
  } catch {
    // Auth recovery must remain available even if secure storage is temporarily unavailable.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [identity, setIdentity] = useState<MeIdentity | null>(null);
  const [error, setError] = useState<IdentityError | null>(null);
  const [booting, setBooting] = useState(true);
  const sessionRef = useRef<Session | null>(null);

  const applyIdentity = useCallback(async (next: Session | null, isBoot: boolean) => {
    sessionRef.current = next;
    setSession(next);
    try {
      if (!next) {
        setIdentity(null);
        setError(null);
        await clearPersistedIdentityQuietly();
        return;
      }

      const cached = await loadPersistedIdentity(next.user.id).catch(() => null);
      if (cached) {
        setIdentity(cached);
        setError(null);
      }

      const result = await fetchMe(next.access_token);
      if (sessionRef.current?.user.id !== next.user.id) {
        return;
      }
      if (result.ok) {
        setIdentity(result.identity);
        setError(null);
        await persistIdentity(result.identity).catch(() => undefined);
      } else if (result.error === "inactive" || result.error === "revoked") {
        setIdentity(null);
        setError(result.error);
        await clearPersistedIdentityQuietly();
      } else if (!cached) {
        setIdentity(null);
        setError("network");
      } else {
        setError(null);
      }
    } catch {
      setIdentity(null);
      setError(next ? "network" : null);
    } finally {
      if (isBoot) {
        setBooting(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    try {
      const supabase = getMobileSupabaseClient();

      void restoreInitialSession(() => supabase.auth.getSession()).then(async (result) => {
        if (cancelled) {
          return;
        }
        if (result.kind === "revoked") {
          sessionRef.current = null;
          setSession(null);
          setIdentity(null);
          setError("revoked");
          await clearPersistedIdentityQuietly();
          setBooting(false);
          return;
        }
        await applyIdentity(result.session, true);
      });

      const { data: listener } = supabase.auth.onAuthStateChange((event, next) => {
        if (cancelled) {
          return;
        }
        if (event === "INITIAL_SESSION") {
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
