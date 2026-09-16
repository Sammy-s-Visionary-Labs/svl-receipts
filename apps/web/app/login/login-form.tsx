"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useState } from "react";
import { createBrowserSupabaseClient } from "@/lib/supabase/browser";
import styles from "./login.module.css";

export function LoginForm({ defaultNext = "/" }: { defaultNext?: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    setBusy(true);
    setError(null);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError("Sign in failed");
        return;
      }
      const access = await fetch("/api/account", { cache: "no-store" });
      if (!access.ok) {
        setError("Could not check account access. Please try again.");
        return;
      }
      const profile = await access.json();
      if (profile.disabled || profile.access_status !== "approved") {
        router.replace("/access-status");
        router.refresh();
        return;
      }
      const next = searchParams.get("next") ?? defaultNext;
      router.replace(
        next.startsWith("/") && !next.startsWith("//") && !next.includes("\\") ? next : "/",
      );
      router.refresh();
    } catch {
      setError("Sign-in is currently unavailable. Please try again or contact your manager.");
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
          name="email"
          autoComplete="username"
          required
        />
      </label>
      <label className={styles.label}>
        Password
        <input
          className={styles.input}
          type="password"
          name="password"
          autoComplete="current-password"
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
