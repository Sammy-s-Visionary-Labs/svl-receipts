"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "./manager/icons";
import styles from "./workspace-switcher.module.css";

export function WorkspaceSwitcher({
  role,
  current,
  children,
  className = "",
  brandClassName = "",
  dark = false,
}: {
  role: "worker" | "manager" | "admin";
  current: "svl" | "field";
  children: ReactNode;
  className?: string;
  brandClassName?: string;
  dark?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const canSwitch = role === "manager" || role === "admin";

  useEffect(() => {
    if (!open) return;
    function outside(event: Event) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function handleKeydown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", handleKeydown);
    };
  }, [open]);

  return (
    <div ref={root} className={`${styles.root} ${dark ? styles.dark : ""} ${className}`}>
      {canSwitch ? (
        <button
          type="button"
          ref={trigger}
          className={`${brandClassName} ${styles.trigger}`}
          aria-label="Switch workspace"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
        >
          {children}
          <Icon name="chevron" size={14} className={styles.chevron} />
        </button>
      ) : (
        <Link href="/field" className={brandClassName} aria-label="SVL Receipts home">
          {children}
        </Link>
      )}
      {canSwitch && open && (
        <nav id={id} className={styles.menu} aria-label="Workspaces">
          <p className={styles.caption}>Switch workspace</p>
          {/* Full navigation honors the review page’s unsaved-change protection. */}
          <a
            href="/"
            aria-current={current === "svl" ? "true" : undefined}
            onClick={() => setOpen(false)}
          >
            <span className={styles.icon}>
              <Icon name="inbox" size={19} />
            </span>
            <span className={styles.choice}>
              <strong>SVL workspace</strong>
              <small>Review receipts and manage your team</small>
            </span>
            {current === "svl" && <Icon name="check" size={16} />}
          </a>
          <a
            href="/field"
            aria-current={current === "field" ? "true" : undefined}
            onClick={() => setOpen(false)}
          >
            <span className={styles.icon}>
              <Icon name="receipt" size={19} />
            </span>
            <span className={styles.choice}>
              <strong>Field workspace</strong>
              <small>Upload receipts and track submissions</small>
            </span>
            {current === "field" && <Icon name="check" size={16} />}
          </a>
        </nav>
      )}
    </div>
  );
}
