import Link from "next/link";
import type { ReactNode } from "react";
import { SignOutButton } from "../sign-out-button";
import { Icon } from "./icons";
import styles from "./manager.module.css";

export function ManagerShell({
  actorRole,
  active,
  reviewCount,
  children,
}: {
  actorRole: "manager" | "admin";
  active: "inbox" | "history" | "settings";
  reviewCount?: number;
  children: ReactNode;
}) {
  return (
    <div className={styles.workspace}>
      <a className={styles.skipLink} href="#main-content">
        Skip to receipts
      </a>
      <aside className={styles.sidebar}>
        <Link href="/" className={styles.brand} aria-label="SVL Receipts home">
          <span className={styles.brandMark}>
            S<span>V</span>L
          </span>
          <span className={styles.brandName}>
            Receipts<span>SVL WORKSPACE</span>
          </span>
        </Link>
        <div className={styles.navCaption}>WORKSPACE</div>
        <nav className={styles.navigation} aria-label="Main navigation">
          <Link
            href="/"
            aria-current={active === "inbox" ? "page" : undefined}
            className={active === "inbox" ? styles.navActive : undefined}
          >
            <Icon name="inbox" />
            <span>Inbox</span>
            {reviewCount !== undefined && <span className={styles.navCount}>{reviewCount}</span>}
          </Link>
          <Link
            href="/?tab=completed"
            aria-current={active === "history" ? "page" : undefined}
            className={active === "history" ? styles.navActive : undefined}
          >
            <Icon name="history" />
            <span>History</span>
          </Link>
          {actorRole === "admin" && (
            <Link
              href="/settings"
              aria-current={active === "settings" ? "page" : undefined}
              className={active === "settings" ? styles.navActive : undefined}
            >
              <Icon name="settings" />
              <span>Settings</span>
            </Link>
          )}
        </nav>
        <div className={styles.sidebarBottom}>
          <div className={styles.workspaceNote}>
            <Icon name="receipt" size={23} />
            <p>
              A clearer view of
              <br />
              every receipt.
            </p>
          </div>
          <div className={styles.account}>
            <span className={styles.avatar}>{actorRole === "admin" ? "A" : "M"}</span>
            <div>
              <strong>{actorRole === "admin" ? "Administrator" : "Manager"}</strong>
              <SignOutButton />
            </div>
          </div>
        </div>
      </aside>
      <div className={styles.contentArea}>
        <header className={styles.topbar}>
          <span>
            Workspace <span className={styles.breadcrumbSlash}>/</span>{" "}
            <strong>
              {active === "history" ? "History" : active === "settings" ? "Settings" : "Inbox"}
            </strong>
          </span>
          <span className={styles.topbarCaption}>SVL RECEIPTS</span>
        </header>
        {children}
      </div>
    </div>
  );
}
