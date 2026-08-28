import type { Session } from "@supabase/supabase-js";

type SessionResponse = {
  data: { session: Session | null };
  error: unknown;
};

export type InitialSessionResult =
  | { kind: "session"; session: Session | null }
  | { kind: "revoked" };

/** Always settles so a corrupt or expired stored session cannot trap the splash screen. */
export async function restoreInitialSession(
  getSession: () => Promise<SessionResponse>,
): Promise<InitialSessionResult> {
  try {
    const { data, error } = await getSession();
    return error ? { kind: "revoked" } : { kind: "session", session: data.session };
  } catch {
    return { kind: "revoked" };
  }
}
