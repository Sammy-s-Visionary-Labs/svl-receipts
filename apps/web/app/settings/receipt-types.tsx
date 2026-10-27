"use client";
import { useEffect, useRef, useState } from "react";
import styles from "../manager/manager.module.css";

type Progress = {
  cutoff: string;
  total: number;
  completed: number;
  credit: number;
  debit: number;
  unknown: number;
  remaining: number;
  failed: number;
  claimed?: number;
};
export function ReceiptTypeSettings() {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    void fetch("/api/admin/receipt-types", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Classification status could not be loaded.");
        if (active.current) setProgress(await response.json());
      })
      .catch((error) => {
        if (active.current) setError(error.message);
      });
    return () => {
      active.current = false;
    };
  }, []);
  async function run() {
    setBusy(true);
    setError("");
    const cutoff = progress?.cutoff ?? new Date().toISOString();
    try {
      for (;;) {
        const response = await fetch("/api/admin/receipt-types", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cutoff }),
        });
        if (!response.ok)
          throw new Error("Classification paused. Resume to continue from the saved progress.");
        const next: Progress = await response.json();
        if (!active.current) return;
        setProgress(next);
        if (!next.remaining || !next.claimed) break;
      }
    } catch (error) {
      if (active.current)
        setError(error instanceof Error ? error.message : "Classification paused.");
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <section className={styles.settingsCard} aria-labelledby="receipt-types-heading">
      <h2 id="receipt-types-heading">Receipt Credit/Debit classification</h2>
      <p>
        Classify existing receipt images. Manager edits, approval history, and completed Housecall
        exports are preserved. This does not send receipts to Housecall.
      </p>
      {progress && (
        <p role="status" aria-live="polite">
          {progress.completed} of {progress.total} classified · {progress.credit} Credit ·{" "}
          {progress.debit} Debit · {progress.unknown} Review required · {progress.failed} Failed
        </p>
      )}
      {busy && (
        <p>
          Classifying receipts… Keep this page open. Saved progress can be resumed if interrupted.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className={styles.primaryButton}
        type="button"
        disabled={busy || progress?.remaining === 0}
        onClick={() => void run()}
      >
        {busy ? "Classifying receipts…" : "Classify existing receipts / Resume"}
      </button>
    </section>
  );
}
