"use client";

import type { AuthzActor } from "@svl/domain";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { listDrafts } from "@/lib/field/drafts";
import styles from "./field.module.css";
import { Icon, type IconName } from "./glyph";

const ActorContext = createContext<AuthzActor | null>(null);
export function useFieldActor() {
  const actor = useContext(ActorContext);
  if (!actor) throw new Error("Field account is unavailable");
  return actor;
}

export function FieldShell({ actor, children }: { actor: AuthzActor; children: ReactNode }) {
  const path = usePathname();
  const [online, setOnline] = useState(true);
  const [signOutPrompt, setSignOutPrompt] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const update = () => {
      // navigator.onLine is only a network-interface hint, not proof that this service is reachable.
      void fetch("/api/me", {
        cache: "no-store",
        credentials: "same-origin",
        signal: AbortSignal.timeout(5000),
      })
        .then(() => {
          if (active) setOnline(true);
        })
        .catch(() => {
          if (active) setOnline(false);
        });
    };
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      active = false;
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const nav: { href: string; label: string; icon: IconName }[] = [
    { href: "/field", label: "Overview", icon: "home" },
    { href: "/field/new", label: "New receipt", icon: "plus" },
    { href: "/field/receipts", label: "My receipts", icon: "receipt" },
    { href: "/field/help", label: "Help & install", icon: "help" },
  ];
  async function signOut(force = false) {
    setBusy(true);
    setError("");
    try {
      if (!force && (await listDrafts(actor.userId)).length > 0) {
        setSignOutPrompt(true);
        return;
      }
      const response = await fetch("/api/auth/sign-out", { method: "POST" });
      if (!response.ok) throw new Error("Could not sign out. Check your connection and try again.");
      window.location.assign("/login?next=/field");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not sign out.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActorContext.Provider value={actor}>
      <div className={styles.app}>
        <a href="#field-content" className={styles.skip}>
          Skip to content
        </a>
        <aside className={styles.sidebar}>
          <Link href="/field" className={styles.brand} aria-label="SVL Receipts home">
            <span className={styles.brandIcon}>
              <Icon name="receipt" size={25} />
            </span>
            <span>
              SVL <strong>Receipts</strong>
              <small>FIELD WORKSPACE</small>
            </span>
          </Link>
          <div className={styles.sidebarLabel}>YOUR WORKSPACE</div>
          <nav className={styles.nav} aria-label="Field navigation">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={
                  (item.href === "/field" ? path === item.href : path.startsWith(item.href))
                    ? "page"
                    : undefined
                }
              >
                <Icon name={item.icon} />
                <span>{item.label}</span>
              </Link>
            ))}
          </nav>
          <div className={styles.sidebarBottom}>
            <div className={styles.privateNote}>
              <Icon name="shield" />
              <span>
                Your receipts.
                <br />
                Connected to your office.
              </span>
            </div>
            {actor.role !== "worker" && (
              <Link href="/" className={styles.textLink}>
                Office dashboard <Icon name="arrow" size={16} />
              </Link>
            )}
            <button
              type="button"
              className={styles.signout}
              onClick={() => void signOut()}
              disabled={busy}
            >
              <Icon name="logout" size={19} />
              Sign out
            </button>
          </div>
        </aside>
        <div className={styles.mainColumn}>
          <header className={styles.topbar}>
            <Link href="/field" className={styles.mobileBrand}>
              <span className={styles.brandIcon}>
                <Icon name="receipt" size={20} />
              </span>
              SVL Receipts
            </Link>
            <span className={styles.breadcrumb}>
              FIELD WORKSPACE <span>/</span>{" "}
              {nav.find((item) => item.href === path)?.label ?? "Receipt details"}
            </span>
            <div className={styles.connection}>
              <span className={online ? styles.onlineDot : styles.offlineDot} />
              {online ? "Connected" : "Offline"}
              <span className={styles.avatar}>SVL</span>
            </div>
          </header>
          {!online && (
            <div className={styles.offlineBanner} role="status">
              You’re offline. You can prepare a draft here. Reconnect to send it or load receipts.
            </div>
          )}
          {(signOutPrompt || error) && (
            <div className={styles.notice} role="alert">
              {error ||
                "You have unsent drafts on this device. They stay saved for this account after you sign out."}
              {signOutPrompt && (
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => setSignOutPrompt(false)}
                  >
                    Keep working
                  </button>
                  <button
                    type="button"
                    className={styles.secondary}
                    onClick={() => void signOut(true)}
                    disabled={busy}
                  >
                    Sign out and keep drafts
                  </button>
                </div>
              )}
            </div>
          )}
          <main id="field-content" className={styles.content}>
            {children}
          </main>
          <footer className={styles.footer}>
            <span>SVL RECEIPTS</span>
            <span>A little less paperwork. A little more time.</span>
            <button type="button" onClick={() => void signOut()} disabled={busy}>
              Sign out
            </button>
          </footer>
        </div>
      </div>
    </ActorContext.Provider>
  );
}

export function ApiNotice({ error }: { error: string }) {
  return (
    <div className={styles.notice} role="alert">
      {error}
      {error.includes("Sign in") || error.includes("session ended") ? (
        <p>
          <Link href="/login?next=/field" className={styles.textLink}>
            Sign in again
          </Link>
        </p>
      ) : null}
    </div>
  );
}
