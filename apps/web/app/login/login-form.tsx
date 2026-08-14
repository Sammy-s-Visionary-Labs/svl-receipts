"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import styles from "./login.module.css";

export function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError("Sign in failed");
        return;
      }
      const next = searchParams.get("next") ?? "/";
      router.replace(next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("Supabase is not configured in this environment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void onSubmit(event)}>
      <label className={styles.label}>
        Email
        <input
          className={styles.input}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </label>
      <label className={styles.label}>
        Password
        <input
          className={styles.input}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </label>
      {error ? <p className={styles.error}>{error}</p> : null}
      <button className={styles.submit} type="submit" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
