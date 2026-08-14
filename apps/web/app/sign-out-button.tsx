"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function signOut() {
    setBusy(true);
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <button type="button" onClick={() => void signOut()} disabled={busy}>
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
